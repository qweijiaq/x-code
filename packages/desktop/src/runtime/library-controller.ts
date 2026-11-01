// @x-code-cli/desktop — 文档库操作
//
// 文档库是本地索引，和会话生命周期解耦。抽成 controller 后，AgentHost 只负责
// 转发调用；进度事件通过注入的 send 回调回传，controller 不依赖 host 实例。
import path from 'node:path'

import { clearDocumentLibrary, indexLibrary, libraryStats, searchLibrary } from '@x-code-cli/core'

import type { LibraryIndexResultView, LibrarySearchView, LibraryStatsView, RuntimeEvent } from '../shared/protocol.js'
import { loadDesktopSettings, saveDesktopSettings } from './desktop-settings.js'

export interface LibraryControllerOptions {
  send: (event: RuntimeEvent) => void
}

export interface LibraryController {
  stats(): Promise<LibraryStatsView>
  setSemantic(enabled: boolean): { enabled: boolean }
  index(target: string, options?: { recursive?: boolean; semantic?: boolean }): Promise<LibraryIndexResultView>
  search(query: string, limit?: number, scope?: string): Promise<LibrarySearchView>
  clear(): Promise<null>
}

export function createLibraryController(options: LibraryControllerOptions): LibraryController {
  return {
    async stats() {
      const stats = await libraryStats()
      const settings = loadDesktopSettings()
      return {
        ...stats,
        lastRoot: settings.libraryRoot,
        semanticEnabled: settings.librarySemantic === true,
      }
    },

    setSemantic(enabled) {
      saveDesktopSettings({ librarySemantic: enabled })
      return { enabled }
    },

    async index(target, indexOptions = {}) {
      const resolved = path.resolve(target)
      const semantic = indexOptions.semantic ?? loadDesktopSettings().librarySemantic === true
      const result = await indexLibrary(resolved, {
        recursive: indexOptions.recursive !== false,
        semantic,
        onProgress: (progress) => options.send({ type: 'library:progress', ...progress }),
      })
      saveDesktopSettings({ libraryRoot: resolved, librarySemantic: semantic })
      return result
    },

    async search(query, limit, scope) {
      const settings = loadDesktopSettings()
      return searchLibrary(query, {
        limit,
        path: scope,
        semantic: settings.librarySemantic !== false,
      })
    },

    async clear() {
      await clearDocumentLibrary()
      return null
    },
  }
}
