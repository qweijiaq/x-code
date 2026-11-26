export interface SessionExitInfo {
  sessionId: string
  taskSlug: string
  messageCount: number
  peerInfluenced: boolean
}

let sessionInfoGetter: (() => SessionExitInfo | null) | null = null

export function registerSessionInfoGetter(getter: () => SessionExitInfo | null): void {
  sessionInfoGetter = getter
}

export function getSessionExitInfo(): SessionExitInfo | null {
  if (!sessionInfoGetter) return null
  try {
    return sessionInfoGetter()
  } catch {
    // getter 可能读到尚未初始化（或已被拆除）的会话状态。退出路径必须继续往下走
    // ——后面的清理（临时文件、退出码写入）比这条提示重要得多。
    return null
  }
}
