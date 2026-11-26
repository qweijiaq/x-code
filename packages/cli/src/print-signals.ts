// @x-code-cli/cli — --print 模式与全局 SIGINT 的协调
//
// 全局 SIGINT 处理器会在第一次 Ctrl+C 时直接进入 gracefulShutdown，而 print
// 模式有自己的 abort + finally 保存路径。两者同时运行会让进程在会话落盘前
// 退出。这里用一个很小的注册点让全局处理器把第一次 SIGINT 让给 print 模式：
// print 自己 abort，等 runPrintMode 完成保存后再由调用方退出。
let printAbort: (() => void) | null = null

export function setPrintAbortHandler(handler: (() => void) | null): void {
  if (printAbort && handler && printAbort !== handler) {
    // 覆盖意味着上一次 print 运行的反注册没有执行（例如初始化阶段抛错），
    // 旧运行从此收不到 abort。默不作声会让 Ctrl+C 失效变得无法排查。
    process.stderr.write('\n[warn] print abort handler overwritten before cleanup\n')
  }
  printAbort = handler
}

/** 如果当前有活跃的 print 运行，触发它的 abort 并返回 true。 */
export function abortPrintMode(): boolean {
  const handler = printAbort
  if (!handler) return false
  try {
    handler()
  } catch (error) {
    // 信号回调里抛出的异常会变成 uncaughtException，让本次 SIGINT 既不 abort
    // 也走不到 gracefulShutdown。
    process.stderr.write(`\n[print abort failed] ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return true
}
