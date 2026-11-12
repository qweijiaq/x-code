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
          try {
            const stat = await fs.promises.stat(target)
            if (stat.mtimeMs > cutoff) continue
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
        const before = await directoryStats(path.join(root, 'library'))
        await clearDocumentLibrary()
        freedBytes += before.bytes
        deletedFiles += before.files
      }

      if (options.whisperModels) {
        const dir = path.join(root, 'whisper-models')
        const before = await directoryStats(dir)
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        freedBytes += before.bytes
        deletedFiles += before.files
      }

      if (options.diagnostics) {
        const dir = path.join(root, 'diagnostics')
        const before = await directoryStats(dir)
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        freedBytes += before.bytes
        deletedFiles += before.files
      }

      if (options.documents) {
        const before = await documentStoreStats()
        await clearDocumentStore()
        freedBytes += before.bytes
        deletedFiles += before.files
      }

      return { deletedFiles, freedBytes, usage: await usage() }
    },
  }
}
