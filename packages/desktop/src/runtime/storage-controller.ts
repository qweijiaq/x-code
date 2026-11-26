// @x-code-cli/desktop — 本地存储统计与清理
//
// 从 AgentHost 拆出的存储管理：统计 sessions/library/attachments/whisper/logs
// 占用，并按天数清理。活动会话和置顶会话永远不删；运行时清理依赖 host 的
// 只读访问器（workspace / busy / activeSessionPath）。
import fs from 'node:fs'
import path from 'node:path'

import { clearDocumentLibrary, userXcodeDir } from '@x-code-cli/core'

import type { StorageUsageView } from '../shared/protocol.js'
import { directoryStats } from './agent-host-support.js'
import { loadDesktopSettings } from './desktop-settings.js'
import { clearDocumentStore, documentStoreStats } from './document-store.js'

export interface StorageControllerHost {
  workspace(): string
  isBusy(): boolean
  activeSessionPath(): string | null
}

export interface CleanupStorageOptions {
  sessionsOlderThanDays?: number
  attachmentsOlderThanDays?: number
  library?: boolean
  whisperModels?: boolean
  diagnostics?: boolean
  documents?: boolean
}

export interface StorageController {
  usage(): Promise<StorageUsageView>
  cleanup(
    options: CleanupStorageOptions,
  ): Promise<{ deletedFiles: number; freedBytes: number; usage: StorageUsageView }>
}

export function createStorageController(host: StorageControllerHost): StorageController {
  const usage = async (): Promise<StorageUsageView> => {
    const workspace = path.resolve(host.workspace())
    const root = userXcodeDir()
    const definitions = [
      { id: 'sessions', label: '会话记录', path: path.join(workspace, '.x-code', 'sessions') },
      { id: 'library', label: '文档库', path: path.join(root, 'library') },
      { id: 'attachments', label: '附件与截图', path: path.join(root, 'attachments') },
      { id: 'whisper', label: '语音模型', path: path.join(root, 'whisper-models') },
      { id: 'diagnostics', label: '诊断包', path: path.join(root, 'diagnostics') },
      { id: 'documents', label: '文档基线与 OCR', path: path.join(root, 'desktop-documents.json') },
      { id: 'logs', label: '日志', path: path.join(root, 'logs') },
    ]
    const categories = []
    for (const definition of definitions) {
      const stats = definition.id === 'documents' ? await documentStoreStats() : await directoryStats(definition.path)
      categories.push({ ...definition, ...stats })
    }
    return { categories, totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0) }
  }

  return {
    usage,

    async cleanup(options) {
      if (host.isBusy()) throw new Error('turn-busy')
      const workspace = path.resolve(host.workspace())
      const root = userXcodeDir()
      const now = Date.now()
      let deletedFiles = 0
      let freedBytes = 0

      /** 逐个目录清理：删除失败（EBUSY/只读挂载）时不能把未释放的空间计入
       *  「已释放」，否则 UI 的「已释放 X MB」与下一行 usage() 自相矛盾。 */
      const purgeDirectory = async (dir: string): Promise<void> => {
        const before = await directoryStats(dir)
        try {
          await fs.promises.rm(dir, { recursive: true })
          freedBytes += before.bytes
          deletedFiles += before.files
        } catch {
          // 目录不可删除：不计入释放量，用户能从 usage() 里看到它仍在。
        }
      }

      /** 单个步骤失败（权限/占用）不能让整次清理 reject：前面已经删掉的
       *  sessions/attachments 的统计会随之丢失，UI 也无法告知「部分已清理」。 */
      const step = async (label: string, run: () => Promise<void>): Promise<void> => {
        try {
          await run()
        } catch (error) {
          console.warn(`[storage] 清理步骤失败：${label}`, error)
        }
      }

      const removeIfOlder = async (dir: string, predicate: (name: string) => boolean, days: number): Promise<void> => {
        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        const cutoff = now - days * 24 * 60 * 60 * 1000
        for (const entry of entries) {
          if (!entry.isFile() || !predicate(entry.name)) continue
          const target = path.join(dir, entry.name)
          try {
            const stat = await fs.promises.stat(target)
            if (stat.mtimeMs > cutoff) continue
            await fs.promises.unlink(target)
            deletedFiles += 1
            freedBytes += stat.size
          } catch {
            // 跳过已消失或无法删除的文件。
          }
        }
      }

      if (options.sessionsOlderThanDays) {
        const days = Math.max(1, Math.min(3650, Math.round(options.sessionsOlderThanDays)))
        const dir = path.join(workspace, '.x-code', 'sessions')
        const pinned = new Set(loadDesktopSettings().pinnedSessions ?? [])
        const active = host.activeSessionPath()
        let entries: fs.Dirent[] = []
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          entries = []
        }
        const cutoff = now - days * 24 * 60 * 60 * 1000
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          const target = path.join(dir, entry.name)
          if (pinned.has(target) || target === active) continue
          // 清理期间用户可能启动了 turn 或切到了别的会话（IPC 事件仍可处理），
          // 那些刚变成活动/写入中的文件不能按旧快照判定删除。
          if (host.isBusy() && target === host.activeSessionPath()) continue
          try {
            const stat = await fs.promises.stat(target)
            if (stat.mtimeMs > cutoff) continue
            // 同理：扫描过程中的置顶操作也要能生效，删除前重读一次置顶集合。
            if ((loadDesktopSettings().pinnedSessions ?? []).includes(target)) continue
            await fs.promises.unlink(target)
            deletedFiles += 1
            freedBytes += stat.size
          } catch {
            // 跳过。
          }
        }
      }

      if (options.attachmentsOlderThanDays) {
        const days = Math.max(1, Math.min(3650, Math.round(options.attachmentsOlderThanDays)))
        await removeIfOlder(
          path.join(root, 'attachments'),
          (name) => name.startsWith('pasted-') || name.startsWith('recording-'),
          days,
        )
      }

      if (options.library) {
        await step('library', async () => {
          const before = await directoryStats(path.join(root, 'library'))
          await clearDocumentLibrary()
          freedBytes += before.bytes
          deletedFiles += before.files
        })
      }

      if (options.whisperModels) {
        await step('whisper-models', () => purgeDirectory(path.join(root, 'whisper-models')))
      }

      if (options.diagnostics) {
        await step('diagnostics', () => purgeDirectory(path.join(root, 'diagnostics')))
      }

      if (options.documents) {
        await step('documents', async () => {
          const before = await documentStoreStats()
          await clearDocumentStore()
          freedBytes += before.bytes
          deletedFiles += before.files
        })
      }

      // usage() 只是报告，不该让整次清理结果（已删除量）因为统计失败而丢失。
      const current = await usage().catch(() => ({ categories: [], totalBytes: 0 }))
      return { deletedFiles, freedBytes, usage: current }
    },
  }
}
