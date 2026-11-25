// @x-code-cli/core — 同一时刻只允许一个浏览器事务。
//
// Playwright MCP 每个连接只维护一个可变的“当前标签页”。单独等待单个工具调用是安全的，
// 但交错执行两个多调用的浏览器流程，会让其中一个流程悄无声息地劫持另一个流程的点击和截图。
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/** 排队上限。持锁方若忽略了 abort（abort 只作用于队列里的 waiter），等待方会无限堆积；
 *  超过此上限就直接失败，而不是让 promise 永不 settle。 */
const MAX_WAITERS = 32

/** 单次等待的上限。仅作为“持锁方卡死”的兜底——正常的浏览器事务远短于此。 */
const ACQUIRE_TIMEOUT_MS = 10 * 60_000

interface Waiter {
  resolve: (release: () => void) => void
  signal?: AbortSignal
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

let active = false
/** 当前持有者的 token；null 表示锁空闲。 */
let activeToken: string | null = null
const waiters: Waiter[] = []

/** 记录“当前异步上下文已持有锁”的 token，使同一持有者的内层获取可直接透传。
 *  没有它，浏览器子代理（runner.ts 为整个运行持锁）内部再调用视觉检查
 *  （visual-check.ts 的 withBrowserOperation）会排在自己后面，永远拿不到锁。 */
const holderStorage = new AsyncLocalStorage<string>()

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Browser operation aborted', 'AbortError')
}

function timedOutReason(): Error {
  return new Error(`Timed out after ${ACQUIRE_TIMEOUT_MS} ms waiting for the browser operation lock`)
}

function releaseNext(): void {
  const next = waiters.shift()
  if (!next) {
    active = false
    activeToken = null
    return
  }
  if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
  if (next.timer) clearTimeout(next.timer)
  // 锁直接转交给队首——`active` 保持 true，避免释放与重新获取之间出现空窗。
  activeToken = randomUUID()
  const token = activeToken
  let released = false
  next.resolve(() => {
    if (released) return
    released = true
    if (activeToken === token) releaseNext()
  })
}

function acquire(signal?: AbortSignal): Promise<{ release: () => void; token: string }> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  const held = holderStorage.getStore()
  if (held && active && activeToken === held) {
    // 可重入：同一持有者（同一异步调用链）直接透传，不排队、也不释放锁。
    return Promise.resolve({ release: () => {}, token: held })
  }
  if (!active) {
    active = true
    activeToken = randomUUID()
    const token = activeToken
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (activeToken === token) releaseNext()
    }
    return Promise.resolve({ release, token })
  }

  if (waiters.length >= MAX_WAITERS) {
    return Promise.reject(new Error('Too many queued browser operations; retry once the active browser task finishes'))
  }

  return new Promise<{ release: () => void; token: string }>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: (release) => resolve({ release, token: activeToken ?? '' }),
      signal,
    }
    const fail = (error: unknown): void => {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.timer = undefined
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.onAbort = undefined
      reject(error)
    }
    const drop = (): void => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
    }
    waiter.onAbort = () => {
      drop()
      fail(abortReason(signal!))
    }
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true })
    waiter.timer = setTimeout(() => {
      drop()
      fail(timedOutReason())
    }, ACQUIRE_TIMEOUT_MS)
    waiter.timer.unref()
    waiters.push(waiter)
  })
}

export async function withBrowserOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const { release, token } = await acquire(signal)
  try {
    if (signal?.aborted) throw abortReason(signal)
    // 在持有者上下文里运行 operation，内层 withBrowserOperation 才能识别出可重入。
    return await holderStorage.run(token, operation)
  } finally {
    release()
  }
}
