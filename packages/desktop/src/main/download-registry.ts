// @x-code-cli/desktop — 每个窗口独立的下载控制器
//
// 更新包下载曾经是一个全局单例：第二个窗口开始下载会 abort 第一个窗口的
// 请求，进度事件也只回到第二个窗口。把控制器按 WebContents id 隔离后，
// 多窗口可以各自下载、各自取消，互不影响。

/** 被同一窗口的新下载顶掉时使用的 abort 原因，让调用方能与「用户主动取消」区分。 */
export const DOWNLOAD_SUPERSEDED = 'download-superseded'

export class DownloadControllerRegistry {
  private readonly controllers = new Map<number, AbortController>()

  /** 为指定窗口开始一次下载；同一窗口的旧下载会被取消。 */
  start(ownerId: number): AbortController {
    // 带上 reason：否则被顶掉的请求也会给 renderer 回一条「下载已取消」，
    // 用户看到的是自己没执行过的操作。
    this.controllers.get(ownerId)?.abort(new Error(DOWNLOAD_SUPERSEDED))
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

  /** 窗口销毁时清理：取消仍在进行的下载并释放条目。
   *  没有这一步时，关闭窗口会让 controller（连同挂起的网络请求/临时文件）
   *  永久残留——WebContents id 单调递增，新窗口不会覆盖同一个键。 */
  dispose(ownerId: number): void {
    this.controllers.get(ownerId)?.abort(new Error('owner-destroyed'))
    this.controllers.delete(ownerId)
  }

  /** 应用退出时取消全部下载。 */
  clear(): void {
    for (const ownerId of [...this.controllers.keys()]) this.dispose(ownerId)
  }

  get activeCount(): number {
    return this.controllers.size
  }
}
