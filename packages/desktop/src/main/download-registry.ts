// @x-code-cli/desktop — 每个窗口独立的下载控制器
//
// 更新包下载曾经是一个全局单例：第二个窗口开始下载会 abort 第一个窗口的
// 请求，进度事件也只回到第二个窗口。把控制器按 WebContents id 隔离后，
// 多窗口可以各自下载、各自取消，互不影响。

export class DownloadControllerRegistry {
  private readonly controllers = new Map<number, AbortController>()

  /** 为指定窗口开始一次下载；同一窗口的旧下载会被取消。 */
  start(ownerId: number): AbortController {
    this.controllers.get(ownerId)?.abort()
    const controller = new AbortController()
    this.controllers.set(ownerId, controller)
    return controller
  }

  /** 下载结束时清理；只有仍是当前控制器时才删除，避免误删后启动的下载。 */
  finish(ownerId: number, controller: AbortController): void {
    if (this.controllers.get(ownerId) === controller) this.controllers.delete(ownerId)
  }

  /** 只取消指定窗口的下载。返回是否确实取消了一个进行中的下载。 */
  cancel(ownerId: number): boolean {
    const controller = this.controllers.get(ownerId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(ownerId)
    return true
  }

  isActive(ownerId: number): boolean {
    return this.controllers.has(ownerId)
  }

  get activeCount(): number {
    return this.controllers.size
  }
}
