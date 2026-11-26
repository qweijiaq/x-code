export type ChatGPTLoginCatalogResult<T> = { models: T } | { error: unknown }

export async function refreshCatalogAfterCommittedLogin<T>(
  refresh: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 8_000,
): Promise<ChatGPTLoginCatalogResult<T>> {
  // 形参类型 `(signal: AbortSignal) => Promise<T>` 并不强制实现方监听 abort：
  // 一旦某个实现忽略 signal（或底层 fetch 卡住），这个 await 会无限期挂起，进而
  // 阻塞调用方（App.tsx 里登录成功之后的提示），用户看到的是登录“卡死”。
  // 所以这里用 Promise.race 再加一道超时兜底，同时保留 abort 以便取消底层请求。
  // abort 的 deadline 要比兜底 timer 略晚：否则尊重 signal 的实现会先以
  // `AbortError: This operation was aborted` 拒绝，用户看到的仍是那条没有意义
  // 的默认文案，下面这段可读文案形同虚设。
  const signal = AbortSignal.timeout(timeoutMs + 1_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const models = await Promise.race([
      refresh(signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // 自带可读文案：调用方会把它拼进
          // “The model catalog could not be refreshed: …” 提示，`TimeoutError`
          // 那种默认消息对用户没有意义。
          reject(new Error(`model catalog refresh timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        // 兜底 timer 不该自己把 event loop 拖到超时之后（短命令路径尤其明显）。
        timer.unref?.()
      }),
    ])
    return { models }
  } catch (error) {
    return { error }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
