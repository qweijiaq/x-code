// @x-code-cli/desktop — 会话管理操作
//
// 重命名/删除/搜索/置顶/归档从 AgentHost 拆出。删除活动会话时的运行时清理
// 通过 host 回调完成，controller 本身不持有 LoopState。
import path from 'node:path'

import { deleteSession as deleteSessionFile, renameSession as renameSessionFile } from '@x-code-cli/core'

import { updateDesktopSettings } from './desktop-settings.js'
import { searchSessionItems } from './sessions.js'

export interface SessionControllerHost {
  workspace(): string
  isBusy(): boolean
  activeSessionId(): string | null
  /** 活动会话被删除后释放 approvals/shell 订阅并清空 loopState。 */
  onActiveSessionDeleted(): void
}

export interface SessionController {
  rename(filePath: string, name: string): Promise<{ name: string }>
  remove(filePath: string): Promise<{ deleted: boolean; resetActive: boolean }>
  setPinned(filePath: string, pinned: boolean): { pinned: boolean }
  setArchived(filePath: string, archived: boolean): { archived: boolean }
  search(query: string, limit?: number): Promise<{ results: Awaited<ReturnType<typeof searchSessionItems>> }>
}

/** `filePath` 直接来自 renderer IPC。core 只校验 `.jsonl` 后缀，因此这里必须
 *  把路径收敛到「当前工作区的会话目录」内，否则等于把重命名/删除磁盘上任意
 *  `.jsonl` 文件（包含其它项目的会话记录）的能力暴露给 renderer。 */
function resolveSessionFile(host: SessionControllerHost, filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('invalid-session-path')
  const sessionsDir = path.resolve(host.workspace(), '.x-code', 'sessions')
  const resolved = path.resolve(filePath)
  const relative = path.relative(sessionsDir, resolved)
  const isDirectChild =
    relative !== '' && !path.isAbsolute(relative) && !relative.startsWith('..') && !relative.includes(path.sep)
  if (!isDirectChild || !resolved.endsWith('.jsonl')) throw new Error('invalid-session-path')
  return resolved
}

export function createSessionController(host: SessionControllerHost): SessionController {
  return {
    async rename(filePath, name) {
      const renamed = await renameSessionFile(resolveSessionFile(host, filePath), name)
      return { name: renamed }
    },

    async remove(filePath) {
      if (host.isBusy()) throw new Error('turn-busy')
      const target = resolveSessionFile(host, filePath)
      const fileId = path.basename(target, '.jsonl')
      const resetActive = host.activeSessionId() === fileId
      await deleteSessionFile(target)
      // 锁内读改写：容器字段在锁外读会在多窗口并发时丢掉另一个窗口的条目。
      updateDesktopSettings((current) => {
        if (!current.sessionTitles?.[fileId]) return null
        const titles = { ...current.sessionTitles }
        delete titles[fileId]
        return { sessionTitles: titles }
      })
      if (resetActive) host.onActiveSessionDeleted()
      return { deleted: true, resetActive }
    },

    setPinned(filePath, pinned) {
      updateDesktopSettings((current) => {
        const next = new Set(current.pinnedSessions ?? [])
        if (pinned) next.add(filePath)
        else next.delete(filePath)
        return { pinnedSessions: [...next] }
      })
      return { pinned }
    },

    setArchived(filePath, archived) {
      updateDesktopSettings((current) => {
        const next = new Set(current.archivedSessions ?? [])
        if (archived) next.add(filePath)
        else next.delete(filePath)
        return { archivedSessions: [...next] }
      })
      return { archived }
    },

    async search(query, limit) {
      return { results: await searchSessionItems(host.workspace(), query, limit) }
    },
  }
}
