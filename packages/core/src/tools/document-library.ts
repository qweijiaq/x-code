// @x-code-cli/core — documentLibrary 工具
//
// 管理本地文档索引：索引一个文件夹或文件、查看统计，或清空它。索引在本地
// 解析文档（readDocument），从不上传任何东西；语义向量只在可选的 BGE 后端
// 可用时才会产生。
import fs from 'node:fs'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { clearDocumentLibrary, indexLibrary, libraryStats } from '../library/index.js'
import { MAX_LIBRARY_CHARS, MAX_LIBRARY_FILES } from '../library/store.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/** 把索引目标限制在项目根内。索引内容会被持久化，并作为检索结果回流到模型
 *  上下文，所以 `~/.ssh`、`/etc` 或 `../../` 这类越界路径必须拒绝，而不是
 *  悄悄把它们解析、切片后存下来。软链用 realpath 归一化后再做前缀比较。 */
function projectRoot(): string {
  return path.resolve(process.cwd())
}

function resolveInsideProjectRoot(input: string): string | null {
  const root = projectRoot()
  const resolved = path.resolve(root, input)
  const realRoot = realpathOrNull(root) ?? root
  const realResolved = realpathOrNull(resolved) ?? resolved
  if (realResolved === realRoot) return realResolved
  return realResolved.startsWith(realRoot + path.sep) ? realResolved : null
}

export const documentLibrary = tool({
  description:
    'Manage the local document library. action:"index" parses every supported file under a folder (or one file) ' +
    `and stores chunks in a local index (max ${MAX_LIBRARY_FILES} files / ${MAX_LIBRARY_CHARS} characters). ` +
    'action:"stats" reports counts, vector dimensions, and embedding availability. action:"clear" deletes the ' +
    'index. Set semantic:true to build embeddings with the optional local BGE model; without it the index is ' +
    'keyword-only. Nothing is uploaded.',
  inputSchema: z.object({
    action: z.enum(['index', 'stats', 'clear']),
    path: z.string().max(4096).optional().describe('Folder or file to index (default: the current project)'),
    recursive: z.boolean().optional().describe('Index subfolders (default true)'),
    semantic: z.boolean().optional().describe('Build semantic vectors when the embedding backend is available'),
  }),
  execute: async ({ action, path, recursive, semantic }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      if (action === 'clear') {
        await clearDocumentLibrary()
        return 'Document library cleared.'
      }
      if (action === 'stats') {
        const stats = await libraryStats()
        return [
          `Files: ${stats.files}`,
          `Chunks: ${stats.chunks}`,
          `Characters: ${stats.characters}`,
          `Vectors: ${stats.vectors}${stats.dimensions > 0 ? ` (${stats.dimensions}d)` : ''}`,
          `Updated: ${stats.updatedAt}`,
          `Index: ${stats.indexPath}`,
          `Semantic: ${stats.semantic.note}`,
        ].join('\n')
      }

      const target = path?.trim()
      if (!target) return 'documentLibrary action:"index" needs a folder or file path.'
      const insideProject = resolveInsideProjectRoot(target)
      if (!insideProject) {
        return (
          `documentLibrary can only index paths inside the project directory (${projectRoot()}). ` +
          `Refusing to index ${target}: it resolves outside the project.`
        )
      }
      reportProgress(toolCallId, `Indexing ${insideProject}`)
      const result = await indexLibrary(insideProject, {
        recursive: recursive !== false,
        semantic: semantic === true,
        onProgress: (progress) => {
          reportProgress(
            toolCallId,
            `Indexing (${progress.phase}) ${progress.processed}/${progress.total}, ${progress.chunks} chunk(s)`,
          )
        },
      })
      return [
        `Indexed ${result.indexed} new/updated file(s), skipped ${result.skipped} unchanged, removed ${result.removed}.`,
        `Library now: ${result.files} file(s), ${result.chunks} chunk(s), ${result.characters} characters, ${result.vectors} vector(s).`,
        `Semantic vectors: ${result.semantic ? 'yes' : 'no (keyword-only)'}.`,
        ...(result.note ? [result.note] : []),
        ...result.errors.map((error) => `Note: ${error}`),
      ].join('\n')
    } catch (err) {
      return formatToolError('managing the document library', err)
    }
  },
})
