// @x-code-cli/core — 基于操作系统咨询锁的跨进程文件锁。
// 供内存提取器/写入器和托管浏览器配置租约共用。
import { flock } from 'fs-ext-extra-prebuilt'

import fs from 'node:fs/promises'
import os from 'node:os'

export interface FileLockLease {
  release(): Promise<void>
}

export interface AcquireFileLockOptions {
  /** 仅用于迁移旧版本遗留的、无法读取或远程所有者的文件。 */
  staleMs?: number
  /** 在活跃所有者持有锁期间重试多久。0 = 仅尝试一次。 */
  waitMs?: number
  retryMs?: number
  /** 提供后，等待超时会抛出此消息而不是返回 null。 */
  timeoutError?: string
  signal?: AbortSignal
}

interface OwnerMetadata {
  protocol?: number
  pid?: number
  hostname?: string
  heartbeatAt?: string
}

const KERNEL_LOCK_PROTOCOL = 2

function flockAsync(fd: number, operation: 'exnb' | 'un'): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fd, operation, (error) => (error ? reject(error) : resolve()))
  })
}

function lockIsBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EAGAIN' || code === 'EACCES' || code === 'EWOULDBLOCK'
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readOwnerMetadata(handle: Awaited<ReturnType<typeof fs.open>>): Promise<OwnerMetadata | null> {
  const buffer = Buffer.alloc(4_096)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
  try {
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8')) as OwnerMetadata
  } catch {
    return null
  }
}

async function legacyOwnerIsLive(handle: Awaited<ReturnType<typeof fs.open>>, staleMs: number): Promise<boolean> {
  const owner = await readOwnerMetadata(handle)
  if (owner?.protocol === KERNEL_LOCK_PROTOCOL) return false
  const stat = await handle.stat()
  if (!owner || typeof owner.pid !== 'number') return Date.now() - stat.mtimeMs <= staleMs
  const sameHost = !owner.hostname || owner.hostname === os.hostname()
  if (sameHost) return processExists(owner.pid)
  const heartbeat = owner.heartbeatAt ? Date.parse(owner.heartbeatAt) : stat.mtimeMs
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat <= staleMs
}

async function openLockFile(lockPath: string): Promise<{
  handle: Awaited<ReturnType<typeof fs.open>>
  created: boolean
}> {
  try {
    return { handle: await fs.open(lockPath, 'wx+', 0o600), created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { handle: await fs.open(lockPath, 'r+', 0o600), created: false }
  }
}

async function retryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('File lock acquisition aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('File lock acquisition aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLockLease | null> {
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + (options.waitMs ?? 0)
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted')
    let opened: Awaited<ReturnType<typeof openLockFile>>
    try {
      opened = await openLockFile(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const { handle, created } = opened
    try {
      await flockAsync(handle.fd, 'exnb')
      // 早于咨询锁协议的版本使用所有者 JSON 加路径删除。滚动升级期间尊重
      // 仍存活的旧持有者；已死的元数据只会被替换一次，之后内核所有权即为
      // 最终依据。
      if (!created && (await legacyOwnerIsLive(handle, staleMs))) {
        await flockAsync(handle.fd, 'un').catch(() => {})
        await handle.close().catch(() => {})
        if (Date.now() >= deadline) {
          if (options.timeoutError) throw new Error(options.timeoutError)
          return null
        }
        await retryDelay(retryMs, options.signal)
        continue
      }
      await handle.truncate(0)
      await handle.writeFile(
        JSON.stringify({ protocol: KERNEL_LOCK_PROTOCOL, pid: process.pid, startedAt: new Date().toISOString() }),
        'utf-8',
      )
      await handle.sync().catch(() => {})
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await flockAsync(handle.fd, 'un').catch(() => {})
          await handle.close().catch(() => {})
        },
      }
    } catch (error) {
      await handle.close().catch(() => {})
      if (!lockIsBusy(error)) throw error
      if (Date.now() >= deadline) {
        if (options.timeoutError) throw new Error(options.timeoutError)
        return null
      }
      await retryDelay(retryMs, options.signal)
    }
  }
}
