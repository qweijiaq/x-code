// @x-code-cli/core — 同一时刻只允许一个浏览器事务。
//
// Playwright MCP 每个连接只维护一个可变的“当前标签页”。单独等待单个工具调用是安全的，
// 但交错执行两个多调用的浏览器流程，会让其中一个流程悄无声息地劫持另一个流程的点击和截图。

interface Waiter {
  resolve: (release: () => void) => void
  signal?: AbortSignal
  onAbort?: () => void
}

let active = false
const waiters: Waiter[] = []

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Browser operation aborted', 'AbortError')
}

function releaseNext(): void {
  const next = waiters.shift()
  if (!next) {
    active = false
    return
  }
  if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
  let released = false
  next.resolve(() => {
    if (released) return
    released = true
    releaseNext()
  })
}

function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  if (!active) {
    active = true
    let released = false
    return Promise.resolve(() => {
      if (released) return
      released = true
      releaseNext()
    })
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { resolve, signal }
    waiter.onAbort = () => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', waiter.onAbort, { once: true })
    waiters.push(waiter)
  })
}

export async function withBrowserOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(signal)
  try {
    if (signal?.aborted) throw abortReason(signal)
    return await operation()
  } finally {
    release()
  }
}
