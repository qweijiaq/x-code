// @x-code-cli/core — 会话级持久 shell
//
// 普通 shell 工具调用每次都会新建进程，因此 `cd`、`export`、函数定义都不会
// 保留。对连续的多步操作（进入目录 → 安装 → 运行测试）来说，这会让 agent
// 反复拼 `cd ... && ...`，也不像用户自己的终端。
//
// 这个类为每个 LoopState 维持一个长期运行的非交互 shell：
//   - 命令通过 base64 + eval 写入，保留当前 shell 的 cwd/env；
//   - 每条命令后打印一个带随机 token 的哨兵，用来取回退出码和新的 $PWD；
//   - 命令必须用子进程/管道承载时，调用方会回退到受管 shell（见
//     shouldUsePersistentShell）。
//
// 只支持 POSIX。Windows 继续使用每次独立的 PowerShell/Job 路径。
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { LoopState } from '../../agent/loop-state.js'
import { sanitizeShellEnv } from '../../utils/shell-sandbox.js'
import type { PreparedShellRequest } from './types.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024

/** 这些命令通常长期驻留；交给受管后台 shell，避免把持久终端永久占住。 */
const LONG_RUNNING_COMMAND =
  /(^|[\s;&|])(vite|nodemon|webpack-dev-server|next\s+dev|nuxt\s+dev|electron|serve|http-server|tail\s+-f|watch)(?=$|[\s;&|])/i
const PACKAGE_DEV_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i

export class PersistentShellBusyError extends Error {
  constructor() {
    super('persistent shell is busy')
    this.name = 'PersistentShellBusyError'
  }
}

export interface PersistentShellRunOptions {
  command: string
  /** 省略时沿用 shell 当前目录；显式传入会先 cd 到该目录并持久化。 */
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

export interface PersistentShellRunResult {
  output: string
  exitCode?: number
  signal?: string
  timedOut: boolean
  aborted: boolean
  shellExited: boolean
}

interface Waiter {
  token: string
  resolve: (result: PersistentShellRunResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  onAbort: (() => void) | null
  signal?: AbortSignal
  startedAt: number
}

function resolveShellExecutable(): { executable: string; args: string[] } {
  const configured = process.env.SHELL?.trim()
  const candidate = configured && /\b(?:bash|zsh|sh)$/i.test(configured) ? configured : undefined
  const executable =
    candidate ?? (process.platform === 'darwin' ? '/bin/zsh' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
  const name = path.basename(executable)
  if (name === 'zsh') return { executable, args: ['-f'] }
  if (name === 'bash') return { executable, args: ['--noprofile', '--norc'] }
  return { executable, args: [] }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** 判断这次调用是否适合走持久 shell。 */
export function shouldUsePersistentShell(request: PreparedShellRequest): boolean {
  if (process.platform === 'win32') return false
  if (request.tty) return false
  // yieldTimeMs: 0 / runInBackground 明确要求立即返回 shell id。
  if (request.initialWait.kind === 'immediate') return false
  // 显式指定了非默认的等待时间：尊重它，交给受管 shell 在超时后返回 id。
  if (request.initialWait.kind === 'timed' && request.initialWait.ms !== 10_000) return false
  const command = request.command.trim()
  if (!command) return false
  // 末尾的 & 表示用户主动放到后台；持久 shell 会让输出串到后续命令里。
  if (/(^|[^\\])&\s*$/.test(command)) return false
  if (LONG_RUNNING_COMMAND.test(command) || PACKAGE_DEV_COMMAND.test(command)) return false
  return true
}

export function persistentShellTimeout(request: PreparedShellRequest): number {
  return request.hardTimeoutMs ?? DEFAULT_TIMEOUT_MS
}

export class PersistentShell {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private waiter: Waiter | null = null
  private running = false
  private cwd: string
  private readonly initialCwd: string
  private decoder = new StringDecoder('utf8')
  private errorDecoder = new StringDecoder('utf8')
  private disposed = false

  constructor(initialCwd: string) {
    this.cwd = initialCwd
    this.initialCwd = initialCwd
  }

  get currentCwd(): string {
    return this.cwd
  }

  get busy(): boolean {
    return this.running
  }

  async run(options: PersistentShellRunOptions): Promise<PersistentShellRunResult> {
    if (this.running) throw new PersistentShellBusyError()
    this.ensureChild()
    const child = this.child
    if (!child) throw new Error('persistent shell failed to start')

    this.running = true
    const token = randomUUID()
    const startedAt = Date.now()
    const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const requestedCwd = options.cwd
    const targetCwd = requestedCwd && fs.existsSync(requestedCwd) ? requestedCwd : this.cwd
    const script = this.buildScript(options.command, token, targetCwd)

    return await new Promise<PersistentShellRunResult>((resolve, reject) => {
      const settle = (
        result: Omit<PersistentShellRunResult, 'timedOut' | 'aborted' | 'shellExited'> & {
          timedOut?: boolean
          aborted?: boolean
          shellExited?: boolean
        },
      ): void => {
        const waiter = this.waiter
        if (!waiter || waiter.token !== token) return
        this.waiter = null
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
        this.running = false
        resolve({
          output: result.output,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut ?? false,
          aborted: result.aborted ?? false,
          shellExited: result.shellExited ?? false,
        })
      }

      const onAbort = (): void => {
        // 终止整棵前台进程树；持久 shell 也一起重启，避免半条命令留在里面。
        const output = this.takeOutput()
        this.killChild()
        settle({ output, aborted: true, signal: 'SIGKILL' })
      }

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const output = this.takeOutput()
              this.killChild()
              settle({ output, timedOut: true, signal: 'SIGKILL' })
            }, timeoutMs)
          : null

      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.waiter = {
        token,
        resolve,
        reject,
        timer,
        onAbort: options.signal ? onAbort : null,
        signal: options.signal,
        startedAt,
      }

      if (this.buffer.length > maxOutputBytes) {
        this.buffer = this.buffer.slice(-maxOutputBytes)
      }
      try {
        child.stdin.write(script)
      } catch (error) {
        this.waiter = null
        this.running = false
        if (timer) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private buildScript(command: string, token: string, targetCwd: string): string {
    const encoded = Buffer.from(command, 'utf8').toString('base64')
    const evalLine = `eval "$(printf '%s' '${encoded}' | base64 --decode)" < /dev/null 2>&1`
    const cd =
      targetCwd !== this.cwd
        ? `if cd -- ${shellQuote(targetCwd)} 2>&1; then\n${evalLine}\n__xc_ec=$?\nelse\n__xc_ec=$?\nfi\n`
        : `${evalLine}\n__xc_ec=$?\n`
    return `${cd}command printf '\\036${token}\\037%s\\037%s\\036' "$__xc_ec" "$PWD"\n`
  }

  private ensureChild(): void {
    if (this.child) return
    if (this.disposed) throw new Error('persistent shell was disposed')
    const { executable, args } = resolveShellExecutable()
    const cwd = fs.existsSync(this.cwd) ? this.cwd : this.initialCwd
    this.cwd = cwd
    this.buffer = ''
    const child = spawn(executable, args, {
      cwd,
      env: { ...sanitizeShellEnv(process.env), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    const decoder = new StringDecoder('utf8')
    const errorDecoder = new StringDecoder('utf8')
    this.decoder = decoder
    this.errorDecoder = errorDecoder
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.onOutput(decoder.write(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.onOutput(errorDecoder.write(chunk))
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.onExit(undefined, undefined, error)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.onExit(code ?? undefined, signal ?? undefined)
    })
  }

  private onOutput(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    if (this.buffer.length > MAX_PENDING_OUTPUT_BYTES * 4) {
      this.buffer = this.buffer.slice(-MAX_PENDING_OUTPUT_BYTES * 4)
    }
    const waiter = this.waiter
    if (!waiter) return
    const marker = `\x1e${waiter.token}\x1f`
    const start = this.buffer.indexOf(marker)
    if (start < 0) return
    const end = this.buffer.indexOf('\x1e', start + marker.length)
    if (end < 0) return
    const payload = this.buffer.slice(start + marker.length, end).split('\x1f')
    const output = this.buffer.slice(0, start)
    this.buffer = this.buffer.slice(end + 1)
    const code = Number(payload[0])
    const cwd = payload[1]
    if (cwd && fs.existsSync(cwd)) this.cwd = cwd
    this.waiter = null
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.running = false
    waiter.resolve({
      output,
      exitCode: Number.isFinite(code) ? code : undefined,
      timedOut: false,
      aborted: false,
      shellExited: false,
    })
  }

  private onExit(code: number | undefined, signal: string | undefined, error?: Error): void {
    this.child = null
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    this.running = false
    const output = this.takeOutput()
    if (error) {
      waiter.reject(error)
      return
    }
    waiter.resolve({ output, exitCode: code, signal, timedOut: false, aborted: false, shellExited: true })
  }

  private takeOutput(): string {
    const output = this.buffer
    this.buffer = ''
    return output
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    this.buffer = ''
    if (!child) return
    try {
      child.stdin.destroy()
    } catch {
      // 已经关闭。
    }
    const pid = child.pid
    if (process.platform !== 'win32' && pid) {
      try {
        process.kill(-pid, 'SIGKILL')
        return
      } catch {
        // 进程组可能已退出，退回单进程 kill。
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出。
    }
  }

  dispose(): void {
    this.disposed = true
    this.killChild()
  }
}

const shells = new WeakMap<LoopState, PersistentShell>()
const liveShells = new Set<PersistentShell>()

export function persistentShellFor(state: LoopState): PersistentShell {
  let shell = shells.get(state)
  if (!shell) {
    shell = new PersistentShell(state.projectCwd)
    shells.set(state, shell)
    liveShells.add(shell)
  }
  return shell
}

export function disposePersistentShell(state: LoopState): void {
  const shell = shells.get(state)
  if (!shell) return
  shells.delete(state)
  liveShells.delete(shell)
  shell.dispose()
}

// 进程退出时关闭持久 shell；否则 CLI 退出后可能留下一个等待 stdin 的 zsh。
process.once('exit', () => {
  for (const shell of liveShells) shell.dispose()
})
