interface ErrorEmitter {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  off(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export function installTerminalStreamErrorGuards(streams: readonly ErrorEmitter[]): () => void {
  const onError = (error: NodeJS.ErrnoException): void => {
    // 断开的管道绝不能在 shutdown 协调器确认其受管进程树达到终止状态之前
    // 抢占它。
    if (error.code === 'EPIPE') return
    throw error
  }
  for (const stream of streams) stream.on('error', onError)
  return () => {
    for (const stream of streams) stream.off('error', onError)
  }
}
