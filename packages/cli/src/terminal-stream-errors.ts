import { debugLog } from '@x-code-cli/core'

interface ErrorEmitter {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  off(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/** 终端流错误的上报器。实现必须自己吞掉所有异常：它是在 'error' 监听器里
 *  被调用的，再抛就回到「监听器抛错」的老问题上。 */
export type TerminalStreamErrorReporter = (error: NodeJS.ErrnoException) => void

/** 默认上报：写 debug 日志。终端可能已经坏了，因此不往 stderr 直接写。 */
export function reportTerminalStreamFailure(error: NodeJS.ErrnoException): void {
  debugLog('terminal.stream-error', `${error.code ?? 'unknown'}: ${error.message}`)
}

export function installTerminalStreamErrorGuards(
  streams: readonly ErrorEmitter[],
  report: TerminalStreamErrorReporter = reportTerminalStreamFailure,
): () => void {
  const onError = (error: NodeJS.ErrnoException): void => {
    // 断开的管道绝不能在 shutdown 协调器确认其受管进程树达到终止状态之前
    // 抢占它。
    if (error.code === 'EPIPE') return
    // 不能在这里 `throw`：
    //   1) EventEmitter 同步遍历监听器，抛错会跳过之后注册的每一个 error
    //      监听器——日志落盘、shutdown 协调、退出码设置全都收不到这个错误；
    //   2) 流的 'error' 多由 `errorOrDestroy` 在 process.nextTick 中 emit，
    //      抛出不会回到写入点，而是变成 uncaughtException 直接终止进程，
    //      恰好是在受管进程树尚未确认终止时把进程轰掉。
    // 改为交给统一上报路径，由 shutdown 协调器决定退出码与退出时机。
    try {
      report(error)
    } catch {
      // 上报本身失败时保持静默：此时已经没有更安全的去处了。
    }
  }
  // 安装时对传入集合做快照并剔除非法项：`readonly` 只是编译期约束，调用方后续
  // mutate 数组会让 dispose 与 install 作用于不同的集合；而 `process.stdout`
  // 在个别嵌入式/打包环境里可能缺失或不具备 `on/off`，顶层调用一旦抛
  // TypeError，CLI 就启动失败，且后面的流完全拿不到 guard。
  const guarded = streams.filter(
    (stream): stream is ErrorEmitter =>
      stream != null && typeof stream.on === 'function' && typeof stream.off === 'function',
  )
  for (const stream of guarded) stream.on('error', onError)
  return () => {
    for (const stream of guarded) stream.off('error', onError)
  }
}
