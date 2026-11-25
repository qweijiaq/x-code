import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { resolveWindowsNativeArtifact, resolveWindowsNativeRoot } from '../../../native/windows-native-artifact.js'
import { debugLog, errorMessage } from '../../../utils.js'
import { sanitizeShellEnv } from '../../../utils/shell-sandbox.js'
import type {
  ManagedExitStatus,
  ManagedProcess,
  ManagedProcessFrame,
  ManagedShellProvider,
  ManagedShellSpawnOptions,
  ManagedSpawnAttempt,
  SpawnReadyResult,
} from '../provider.js'
import { createDeferred } from '../session.js'
import type { ProcessTerminationResult, TerminationBudget, TerminationReason } from '../types.js'
import { ActivationFrameBuffer } from './activation-frames.js'
import { defaultWindowsPowerShellExecutable, powerShellCommandLine } from './windows-powershell.js'
import {
  WINDOWS_SUPERVISOR_PROTOCOL_VERSION,
  WindowsSupervisorFrameDecoder,
  WindowsSupervisorFrameKind,
  encodeWindowsSupervisorFrame,
  encodeWindowsSupervisorLaunch,
} from './windows-supervisor-protocol.js'

export interface WindowsSupervisorArtifact {
  executablePath: string
  sha256: string
}

export interface WindowsJobObjectProviderOptions {
  artifact?: Promise<WindowsSupervisorArtifact> | WindowsSupervisorArtifact
  executable?: string
}

function timeoutWake(ms: number): { promise: Promise<false>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    promise: new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
    dispose() {
      if (timer) clearTimeout(timer)
    },
  }
}

/** supervisor 不读 stdin（卡死）时 write 回调永远不会触发，没有 deadline 就会
 *  把这些 promise 永久挂住。 */
const WINDOWS_SUPERVISOR_LAUNCH_WRITE_TIMEOUT_MS = 15_000
const WINDOWS_SUPERVISOR_FRAME_WRITE_TIMEOUT_MS = 2_000

async function writeFrameWithDeadline(stdin: Writable, frame: Buffer, timeoutMs: number): Promise<void> {
  const deadline = timeoutWake(timeoutMs)
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        stdin.write(frame, (error) => (error ? reject(error) : resolve()))
      }),
      deadline.promise.then(() => {
        throw new Error(`supervisor did not accept the frame within ${timeoutMs}ms`)
      }),
    ])
  } finally {
    deadline.dispose()
  }
}

export function resolveWindowsSupervisorNativeRoot(modulePath: string): string {
  return resolveWindowsNativeRoot(modulePath)
}

export async function resolveWindowsSupervisorArtifact(
  arch: NodeJS.Architecture = process.arch,
): Promise<WindowsSupervisorArtifact> {
  const artifact = await resolveWindowsNativeArtifact({
    arch,
    nativeRoot: resolveWindowsSupervisorNativeRoot(fileURLToPath(import.meta.url)),
    spec: {
      artifactName: 'shellSupervisor',
      executableName: 'xc-shell-supervisor.exe',
      displayName: 'Windows shell supervisor',
      protocolVersion: WINDOWS_SUPERVISOR_PROTOCOL_VERSION,
    },
  })
  return { executablePath: artifact.executablePath, sha256: artifact.sha256 }
}

class WindowsManagedProcess implements ManagedProcess {
  private readonly rootExit = createDeferred<ManagedExitStatus>()
  private readonly treeExit = createDeferred<void>()
  private readonly helperSpawnFailed = createDeferred<void>()
  private helper?: ChildProcessWithoutNullStreams
  private helperState: 'absent' | 'pending' | 'spawned' | 'exited' = 'pending'
  private protocolFailure?: string
  private terminationFlight?: Promise<ProcessTerminationResult>
  private currentRootPid?: number
  private currentExitStatus: ManagedExitStatus = {}

  constructor(private readonly cancelPendingSpawn: () => void) {}

  get rootPid(): number | undefined {
    return this.currentRootPid
  }

  get treeConfirmedExited(): boolean {
    return this.treeExit.settled
  }

  attachHelper(helper: ChildProcessWithoutNullStreams): void {
    this.helper = helper
    this.helperState = 'pending'
  }

  observeHelperSpawn(): void {
    if (this.helperState === 'pending') this.helperState = 'spawned'
  }

  observeHelperSpawnFailure(message: string): void {
    if (this.helperState === 'pending') {
      this.helperState = 'absent'
      this.helperSpawnFailed.resolve()
    }
    this.protocolFailure = message
  }

  markSpawnAbsent(): void {
    if (this.helperState !== 'pending' || this.helper) return
    this.helperState = 'absent'
    this.helperSpawnFailed.resolve()
  }

  setRootPid(rootPid: number): void {
    this.currentRootPid = rootPid
  }

  observeRootExit(exitCode: number): void {
    this.currentExitStatus = { exitCode }
    this.rootExit.resolve(this.currentExitStatus)
  }

  observeTreeExit(): void {
    this.treeExit.resolve()
  }

  observeProtocolFailure(message: string): void {
    this.protocolFailure = message
  }

  observeHelperExit(): void {
    this.helperState = 'exited'
  }

  waitForRootExit(): Promise<ManagedExitStatus> {
    return this.rootExit.promise
  }

  waitForTreeExit(): Promise<void> {
    return this.treeExit.promise
  }

  async probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'> {
    if (this.treeExit.settled) return 'confirmed-exited'
    if (this.helperState === 'absent') return 'confirmed-exited'
    // pending：supervisor 还没 spawn 成功，进程树尚未建立 —— 不能断言 'live'
    // （与 windows-pty 的 probeTree 保持同一语义）。
    if (this.helperState === 'pending') return 'unknown'
    return this.helperState === 'exited' || this.protocolFailure ? 'unknown' : 'live'
  }

  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult> {
    if (this.terminationFlight) return this.terminationFlight
    const flight = this.runTermination(reason, budget)
    this.terminationFlight = flight
    void flight.then(
      () => {
        if (this.terminationFlight === flight) this.terminationFlight = undefined
      },
      () => {
        if (this.terminationFlight === flight) this.terminationFlight = undefined
      },
    )
    return flight
  }

  forceTreeSync(deadlineAt: number): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed' {
    if (this.treeExit.settled || this.helperState === 'absent') return 'already-exited'
    if (performance.now() >= deadlineAt) return 'deadline-exhausted'
    if (this.helperState === 'pending' && !this.helper) {
      this.cancelPendingSpawn()
      this.markSpawnAbsent()
      return 'already-exited'
    }
    // helper 已经退出时进程树大概率也消失了：这是"已经结束"，不是"关停失败"，
    // 否则 shutdown 汇总会把死掉的 supervisor 统计成失败并污染重试决策。
    if (this.helperState === 'exited') return 'already-exited'
    try {
      return this.helper?.kill() ? 'force-sent-unconfirmed' : 'already-exited'
    } catch {
      return 'failed'
    }
  }

  private async runTermination(
    _reason: TerminationReason,
    budget: TerminationBudget,
  ): Promise<ProcessTerminationResult> {
    if (this.treeExit.settled || this.helperState === 'absent') return this.confirmed(false, false)
    if (this.helperState === 'pending' && !this.helper) {
      this.cancelPendingSpawn()
      this.markSpawnAbsent()
      return this.confirmed(false, false)
    }
    let gracefulAttempted = false
    let forceAttempted = false

    if (this.helper && this.helperState !== 'exited') {
      gracefulAttempted = await this.writeControl(WindowsSupervisorFrameKind.graceful)
      if (await this.waitForTree(budget.gracefulMs)) return this.confirmed(gracefulAttempted, forceAttempted)

      forceAttempted = await this.writeControl(WindowsSupervisorFrameKind.force)
      if (await this.waitForTree(budget.forceMs + budget.confirmMs)) {
        return this.confirmed(gracefulAttempted, forceAttempted)
      }
    }

    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.rootExit.settled,
      treeConfirmedExited: false,
      ...this.currentExitStatus,
      failure: {
        code: 'termination-unconfirmed',
        message:
          this.protocolFailure ??
          (this.helperState === 'exited'
            ? 'Windows shell supervisor exited before reporting an empty Job Object'
            : 'Windows Job Object did not report active-process-zero before the termination deadline'),
      },
    }
  }

  private async writeControl(
    kind: typeof WindowsSupervisorFrameKind.graceful | typeof WindowsSupervisorFrameKind.force,
  ) {
    const stdin = this.helper?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return false
    try {
      await writeFrameWithDeadline(stdin, encodeWindowsSupervisorFrame(kind), WINDOWS_SUPERVISOR_FRAME_WRITE_TIMEOUT_MS)
      return true
    } catch (error) {
      this.protocolFailure = `Could not write Windows supervisor termination frame: ${String(error)}`
      return false
    }
  }

  private async waitForTree(ms: number): Promise<boolean> {
    if (this.treeExit.settled || this.helperState === 'absent') return true
    const timeout = timeoutWake(ms)
    try {
      return await Promise.race([
        this.treeExit.promise.then(() => true),
        this.helperSpawnFailed.promise.then(() => true),
        timeout.promise,
      ])
    } finally {
      timeout.dispose()
    }
  }

  private confirmed(gracefulAttempted: boolean, forceAttempted: boolean): ProcessTerminationResult {
    return {
      gracefulAttempted,
      forceAttempted,
      rootExited: this.rootExit.settled,
      treeConfirmedExited: true,
      ...this.currentExitStatus,
    }
  }
}

class WindowsSpawnAttempt implements ManagedSpawnAttempt {
  readonly handle: WindowsManagedProcess
  readonly ready: Promise<SpawnReadyResult>
  private readonly readyState = createDeferred<SpawnReadyResult>()
  private readonly frames: ActivationFrameBuffer
  private helper?: ChildProcessWithoutNullStreams
  private cancelled = false

  constructor(
    private readonly command: string,
    private readonly options: ManagedShellSpawnOptions,
    artifact: Promise<WindowsSupervisorArtifact>,
    private readonly powerShellExecutable: string,
  ) {
    this.frames = new ActivationFrameBuffer(options.outputCapture)
    this.handle = new WindowsManagedProcess(() => this.cancelPendingSpawn())
    this.ready = this.readyState.promise
    // 同步 best-effort 关停路径（forceTreeSync → cancelPendingSpawn）可能 reject
    // `ready`，而此时未必有调用方在等它；没有 handler 的 rejection 在 Node 默认
    // 策略下会直接打崩进程。挂一个兜底 handler，真正的错误仍会传给 await ready
    // 的调用方。
    void this.ready.catch(() => undefined)
    void this.initialize(artifact)
  }

  activate(listener: (frame: ManagedProcessFrame) => void): void {
    this.frames.activate(listener)
  }

  discardBufferedFrames(): ManagedProcessFrame[] {
    return this.frames.discard()
  }

  async cancelBeforeReady(
    reason: TerminationReason | 'turn-abort-before-ready',
    budget: TerminationBudget = { gracefulMs: 1_000, forceMs: 1_000, confirmMs: 250 },
  ): Promise<ProcessTerminationResult> {
    this.cancelPendingSpawn()
    if (!this.helper) {
      return {
        gracefulAttempted: false,
        forceAttempted: false,
        rootExited: false,
        treeConfirmedExited: true,
      }
    }
    const mappedReason = reason === 'turn-abort-before-ready' ? 'spawn-failure-cleanup' : reason
    return this.handle.terminateTree(mappedReason, budget)
  }

  private cancelPendingSpawn(): void {
    this.cancelled = true
    this.readyState.reject(new Error('Windows shell start was cancelled before supervisor launch'))
    if (!this.helper) this.handle.markSpawnAbsent()
  }

  private async initialize(artifactPromise: Promise<WindowsSupervisorArtifact>): Promise<void> {
    try {
      const artifact = await artifactPromise
      if (this.cancelled) {
        this.handle.markSpawnAbsent()
        return
      }
      const helper = spawn(artifact.executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: sanitizeShellEnv(this.options.env ?? process.env),
      })
      this.helper = helper
      this.handle.attachHelper(helper)
      const decoder = new WindowsSupervisorFrameDecoder()
      let stderrBytes = 0
      helper.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
      })
      helper.stdout.on('data', (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) this.onProtocolFrame(frame.kind, frame.payload)
        } catch (error) {
          this.failProtocol(error)
        }
      })
      helper.stdout.once('end', () => {
        try {
          decoder.end()
        } catch (error) {
          this.failProtocol(error)
        }
      })
      helper.once('spawn', () => {
        this.handle.observeHelperSpawn()
      })
      helper.once('error', (error) => {
        this.handle.observeHelperSpawnFailure(error.message)
        this.readyState.reject(error)
      })
      helper.once('exit', (code) => {
        this.handle.observeHelperExit()
        if (this.readyState.settled && !this.handle.treeConfirmedExited) {
          const message = `Windows shell supervisor exited before reporting an empty Job Object (code ${code ?? 'unknown'})`
          this.handle.observeProtocolFailure(message)
          this.frames.push({ kind: 'failure', message })
        }
        if (!this.readyState.settled) {
          this.readyState.reject(
            new Error(
              `Windows shell supervisor exited before ready (code ${code ?? 'unknown'}, stderrBytes ${stderrBytes})`,
            ),
          )
        }
      })
      const launch = encodeWindowsSupervisorLaunch({
        cwd: this.options.cwd,
        application: this.powerShellExecutable,
        commandLine: powerShellCommandLine(this.powerShellExecutable, this.command),
      })
      // launch 帧的写入同样要有 deadline：supervisor 启动了却不读 stdin 时，
      // write 回调不会触发，`ready` 会无限挂起并把整条 shell 会话拖住。
      await writeFrameWithDeadline(helper.stdin, launch, WINDOWS_SUPERVISOR_LAUNCH_WRITE_TIMEOUT_MS)
    } catch (error) {
      this.readyState.reject(error)
    }
  }

  private onProtocolFrame(kind: number, payload: Buffer): void {
    if (kind === WindowsSupervisorFrameKind.ready) {
      if (payload.length !== 4) return this.failProtocol(new Error('ready frame has an invalid payload'))
      const rootPid = payload.readUInt32LE()
      this.handle.setRootPid(rootPid)
      this.readyState.resolve({ rootPid, treeKind: 'windows-job-object' })
      return
    }
    if (kind === WindowsSupervisorFrameKind.stdout || kind === WindowsSupervisorFrameKind.stderr) {
      this.frames.push({
        kind: 'output',
        stream: kind === WindowsSupervisorFrameKind.stdout ? 'stdout' : 'stderr',
        chunk: payload,
      })
      return
    }
    if (kind === WindowsSupervisorFrameKind.stdoutEof || kind === WindowsSupervisorFrameKind.stderrEof) {
      this.frames.push({
        kind: 'stream-end',
        stream: kind === WindowsSupervisorFrameKind.stdoutEof ? 'stdout' : 'stderr',
      })
      return
    }
    if (kind === WindowsSupervisorFrameKind.rootExit) {
      if (payload.length !== 4) return this.failProtocol(new Error('root-exit frame has an invalid payload'))
      const exitCode = payload.readUInt32LE()
      this.handle.observeRootExit(exitCode)
      this.frames.push({ kind: 'root-exit', exitCode })
      return
    }
    if (kind === WindowsSupervisorFrameKind.treeEmpty) {
      if (payload.length !== 0) return this.failProtocol(new Error('tree-empty frame has an invalid payload'))
      this.handle.observeTreeExit()
      this.frames.push({ kind: 'tree-exit' })
      return
    }
    if (kind === WindowsSupervisorFrameKind.spawnError) {
      const message = payload.toString('utf8') || 'Windows shell supervisor failed to start the command'
      this.handle.observeProtocolFailure(message)
      this.readyState.reject(new Error(message))
      return
    }
    if (kind === WindowsSupervisorFrameKind.terminationError) {
      const message = payload.toString('utf8') || 'Windows Job Object termination failed'
      this.handle.observeProtocolFailure(message)
      this.frames.push({ kind: 'failure', message })
      return
    }
    this.failProtocol(new Error(`unknown Windows shell supervisor frame kind ${kind}`))
  }

  private failProtocol(error: unknown): void {
    const message = errorMessage(error)
    this.handle.observeProtocolFailure(message)
    this.readyState.reject(new Error(message))
    this.frames.push({ kind: 'failure', message })
    this.helper?.kill()
    debugLog('shell-session.windows-protocol-error', `messageBytes=${Buffer.byteLength(message, 'utf8')}`)
  }
}

export class WindowsJobObjectProvider implements ManagedShellProvider {
  private artifact?: Promise<WindowsSupervisorArtifact>
  private readonly configuredArtifact?: Promise<WindowsSupervisorArtifact>
  private readonly executable: string

  constructor(options: WindowsJobObjectProviderOptions = {}) {
    this.configuredArtifact = options.artifact ? Promise.resolve(options.artifact) : undefined
    this.executable = options.executable ?? defaultWindowsPowerShellExecutable()
  }

  spawnManaged(command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt {
    if (this.configuredArtifact) {
      // 调用方注入的 artifact 由其自身生命周期决定，这里既不缓存也不重试。
      return new WindowsSpawnAttempt(command, options, this.configuredArtifact, this.executable)
    }
    if (!this.artifact) {
      // 一次瞬时失败（原生产物还没解压完、临时 I/O 错误）不能让这个 provider
      // 实例后续所有 spawn 都复用同一个 rejected promise：失败时清掉缓存，
      // 下一次 spawn 重新解析产物。
      this.artifact = resolveWindowsSupervisorArtifact().catch((error: unknown) => {
        this.artifact = undefined
        throw error
      })
    }
    return new WindowsSpawnAttempt(command, options, this.artifact, this.executable)
  }
}
