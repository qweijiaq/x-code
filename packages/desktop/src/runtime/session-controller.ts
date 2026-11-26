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
  /** 活动转录的真实路径。文件名只是落盘约定，jsonl 头部的 sessionId 可能与
   *  文件名不一致，只比 id 会漏掉「删的就是活动会话」这种情况。 */
  activeSessionPath?(): string | null
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
      const resetActive = host.activeSessionPath?.() === target || host.activeSessionId() === fileId
      // 删除语义是「确保不存在」：文件已不存在时继续清理设置，而不是让
      // ENOENT 跳过 sessionTitles/pinned/archived 回收并报一个原始错误。
      await deleteSessionFile(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      })
      const isSameSession = (entry: string): boolean => entry === target || path.resolve(entry) === target
      // 锁内读改写：容器字段在锁外读会在多窗口并发时丢掉另一个窗口的条目。
      updateDesktopSettings((current) => {
        const hadTitle = Boolean(current.sessionTitles?.[fileId])
        const pinned = (current.pinnedSessions ?? []).filter((entry) => !isSameSession(entry))
        const archived = (current.archivedSessions ?? []).filter((entry) => !isSameSession(entry))
        // 已删除会话的路径留在 pinned/archived 里会随删除次数无界增长，
        // 且永远无法再回收。
        const changed =
          hadTitle ||
          pinned.length !== (current.pinnedSessions?.length ?? 0) ||
          archived.length !== (current.archivedSessions?.length ?? 0)
        if (!changed) return null
        const titles = { ...current.sessionTitles }
        delete titles[fileId]
        return { sessionTitles: titles, pinnedSessions: pinned, archivedSessions: archived }
      })
      if (resetActive) host.onActiveSessionDeleted()
      return { deleted: true, resetActive }
    },

    setPinned(filePath, pinned) {
      // 归一化写入：读侧用 `path.join(sessionsDir, name)` 比对，任何字面不同的
      // 等价路径（相对路径、重复分隔符、`..`）都会让置顶「保存成功但不生效」。
      const key = path.resolve(filePath)
      updateDesktopSettings((current) => {
        const next = new Set(current.pinnedSessions ?? [])
        if (pinned) next.add(key)
        else next.delete(key)
        return { pinnedSessions: [...next] }
      })
      return { pinned }
    },

    setArchived(filePath, archived) {
      const key = path.resolve(filePath)
      updateDesktopSettings((current) => {
        const next = new Set(current.archivedSessions ?? [])
        if (archived) next.add(key)
        else next.delete(key)
        return { archivedSessions: [...next] }
      })
      return { archived }
    },

    async search(query, limit) {
      return { results: await searchSessionItems(host.workspace(), query, limit) }
    },
  }
}
