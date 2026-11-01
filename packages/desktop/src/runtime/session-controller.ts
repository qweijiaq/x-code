// @x-code-cli/desktop — 会话管理操作
//
// 重命名/删除/搜索/置顶/归档从 AgentHost 拆出。删除活动会话时的运行时清理
// 通过 host 回调完成，controller 本身不持有 LoopState。
import path from 'node:path'

import { deleteSession as deleteSessionFile, renameSession as renameSessionFile } from '@x-code-cli/core'

import { loadDesktopSettings, saveDesktopSettings } from './desktop-settings.js'
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

export function createSessionController(host: SessionControllerHost): SessionController {
  return {
    async rename(filePath, name) {
      const renamed = await renameSessionFile(filePath, name)
      return { name: renamed }
    },

    async remove(filePath) {
      if (host.isBusy()) throw new Error('turn-busy')
      const fileId = path.basename(filePath, '.jsonl')
      const resetActive = host.activeSessionId() === fileId
      await deleteSessionFile(filePath)
      const settings = loadDesktopSettings()
      if (settings.sessionTitles?.[fileId]) {
        const titles = { ...settings.sessionTitles }
        delete titles[fileId]
        saveDesktopSettings({ sessionTitles: titles })
      }
      if (resetActive) host.onActiveSessionDeleted()
      return { deleted: true, resetActive }
    },

    setPinned(filePath, pinned) {
      const settings = loadDesktopSettings()
      const next = new Set(settings.pinnedSessions ?? [])
      if (pinned) next.add(filePath)
      else next.delete(filePath)
      saveDesktopSettings({ pinnedSessions: [...next] })
      return { pinned }
    },

    setArchived(filePath, archived) {
      const settings = loadDesktopSettings()
      const next = new Set(settings.archivedSessions ?? [])
      if (archived) next.add(filePath)
      else next.delete(filePath)
      saveDesktopSettings({ archivedSessions: [...next] })
      return { archived }
    },

    async search(query, limit) {
      return { results: await searchSessionItems(host.workspace(), query, limit) }
    },
  }
}
