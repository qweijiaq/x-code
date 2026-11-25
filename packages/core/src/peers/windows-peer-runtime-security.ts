import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage, userXcodeDir } from '../utils.js'
import { stripTerminalControls } from './terminal-sanitize.js'
import { type WindowsPeerBrokerArtifact, resolveWindowsPeerBrokerArtifact } from './windows-peer-broker-artifact.js'
import { spawnWindowsPeerBrokerProcess } from './windows-peer-broker-process.js'
import {
  WindowsPeerBrokerFrameKind,
  decodeOneStringPayload,
  decodeOperationErrorPayload,
  encodeSecureRuntimePayload,
} from './windows-peer-broker-protocol.js'

const SECURE_RUNTIME_OPERATION_ID = 1
const SECURE_RUNTIME_TIMEOUT_MS = 5_000
/** kill() 之后等待子进程真正关闭的上界——不能让收尾 await 无限挂住。 */
const BROKER_CLOSE_WAIT_MS = 1_000
const PREMATURE_EXIT_MESSAGE = 'Windows peer runtime helper exited before completing the security check'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface WindowsPeerRuntimePaths {
  registryDir: string
  socketDir: string
  namespaceId: string
}

export interface WindowsPeerRuntimeSecurityProvider {
  initialize(signal?: AbortSignal): Promise<WindowsPeerRuntimePaths>
}

export interface WindowsPeerRuntimeSecurityOptions {
  root?: string
  artifact?: WindowsPeerBrokerArtifact | Promise<WindowsPeerBrokerArtifact>
  spawnBroker?: typeof spawn
  timeoutMs?: number
}

function runtimeError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(stripTerminalControls(message), cause === undefined ? undefined : { cause })
  error.name = code
  return error
}

function abortError(): Error {
  return Object.assign(new Error('Windows peer runtime initialization was interrupted'), { name: 'AbortError' })
}

export function createWindowsPeerRuntimeSecurity(
  options: WindowsPeerRuntimeSecurityOptions = {},
): WindowsPeerRuntimeSecurityProvider {
  let initialized: Promise<WindowsPeerRuntimePaths> | undefined
  return {
    initialize(signal) {
      // 初始化已在飞行时，新调用方的取消意图不能被顺手丢掉。
      if (initialized) {
        return signal?.aborted ? Promise.reject(abortError()) : initialized
      }
      const operation = secureWindowsPeerRuntime(options, signal).catch((error) => {
        initialized = undefined
        throw error
      })
      initialized = operation
      return operation
    },
  }
}

async function secureWindowsPeerRuntime(
  options: WindowsPeerRuntimeSecurityOptions,
  signal?: AbortSignal,
): Promise<WindowsPeerRuntimePaths> {
  if (process.platform !== 'win32') {
    throw runtimeError('PEER_UNSUPPORTED_PLATFORM', 'Windows peer runtime security is only available on Windows')
  }
  if (signal?.aborted) throw abortError()
  const root = path.resolve(options.root ?? userXcodeDir())
  try {
    await fs.mkdir(root, { recursive: true })
  } catch (error) {
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime root creation failed: ${errorMessage(error)}`,
      error,
    )
  }
  let artifact: WindowsPeerBrokerArtifact
  try {
    artifact = await (options.artifact ?? resolveWindowsPeerBrokerArtifact())
  } catch (error) {
    // 原始错误可能带着不可信子进程输出里的 ANSI 序列，统一走净化通道。
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime helper resolution failed: ${errorMessage(error)}`,
      error,
    )
  }
  if (signal?.aborted) throw abortError()
  let settled = false
  let resolveResult!: (namespaceId: string) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // `result` 要等到 `brokerProcess.send(...)` 之后才被 await。若在那之前的 try
  // 块里就失败了（spawn 出错、`child.stdin` 的 error 事件先经 `onError:
  // settleError` 把 result reject，随后 `send()` 也 reject），catch 分支不会再
  // 触碰 `result`，这个 rejection 就永久无人处理——Node 默认
  // `--unhandled-rejections=throw` 会直接崩掉进程，把一次本可恢复的安全检查
  // 失败放大成整体宕机。先挂一个吞掉的 handler。
  result.catch(() => {})
  const settleError = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }
  const brokerProcess = spawnWindowsPeerBrokerProcess({
    artifact,
    mode: 'secure-runtime',
    spawnBroker: options.spawnBroker ?? spawn,
    debugKey: 'peer.windows.runtime-helper',
    onFrame(frame) {
      if (settled) return
      if (frame.operationId !== SECURE_RUNTIME_OPERATION_ID) {
        throw runtimeError(
          'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
          'Windows peer runtime helper returned an unknown operation ID',
        )
      }
      if (frame.kind === WindowsPeerBrokerFrameKind.SecureRuntimeResult) {
        const namespaceId = decodeOneStringPayload(frame.payload)
        if (!/^[a-f0-9]{12}$/.test(namespaceId)) {
          throw runtimeError(
            'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
            'Windows peer runtime helper returned an invalid namespace',
          )
        }
        settled = true
        resolveResult(namespaceId)
      } else if (frame.kind === WindowsPeerBrokerFrameKind.OperationError) {
        const failure = decodeOperationErrorPayload(frame.payload)
        settleError(runtimeError(failure.code, failure.message))
      } else {
        throw runtimeError(
          'PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH',
          'Windows peer runtime helper returned an unexpected frame',
        )
      }
    },
    onError: settleError,
    onClose() {
      settleError(runtimeError('PEER_WINDOWS_RUNTIME_UNSAFE', PREMATURE_EXIT_MESSAGE))
    },
  })
  const onAbort = (): void => {
    brokerProcess.kill()
    settleError(abortError())
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    brokerProcess.kill()
    settleError(runtimeError('PEER_WINDOWS_RUNTIME_UNSAFE', 'Windows peer runtime security check timed out'))
  }, options.timeoutMs ?? SECURE_RUNTIME_TIMEOUT_MS)
  timer.unref()

  try {
    await brokerProcess.send({
      kind: WindowsPeerBrokerFrameKind.SecureRuntime,
      operationId: SECURE_RUNTIME_OPERATION_ID,
      payload: encodeSecureRuntimePayload(root),
    })
    brokerProcess.endInput()
    const namespaceId = await result
    // terminate 不一定即时生效、子进程也可能卡在 IO 上：收尾等待必须有界，
    // 否则 5s 超时保护形同虚设。
    const status = await Promise.race([brokerProcess.closed, sleep(BROKER_CLOSE_WAIT_MS).then(() => undefined)])
    if (signal?.aborted) throw abortError()
    if (status && status.code !== 0) {
      throw runtimeError('PEER_WINDOWS_RUNTIME_UNSAFE', PREMATURE_EXIT_MESSAGE)
    }
    const registryDir = path.join(root, 'runtime', 'peers')
    return { registryDir, socketDir: registryDir, namespaceId }
  } catch (error) {
    brokerProcess.kill()
    await Promise.race([brokerProcess.closed, sleep(BROKER_CLOSE_WAIT_MS)])
    if (error instanceof Error && (error.name === 'AbortError' || error.name.startsWith('PEER_'))) throw error
    throw runtimeError(
      'PEER_WINDOWS_RUNTIME_UNSAFE',
      `Windows peer runtime security check failed: ${errorMessage(error)}`,
      error,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
