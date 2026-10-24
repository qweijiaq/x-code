// @x-code-cli/core — documentLibrary tool
//
// Manages the local document index: index a folder or file, show stats, or
// clear it. Indexing parses documents locally (readDocument) and never uploads
// anything; semantic vectors are only produced when the optional BGE backend
// is available.
import { tool } from 'ai'

import { z } from 'zod'

import { clearDocumentLibrary, indexLibrary, libraryStats } from '../library/index.js'
import { MAX_LIBRARY_CHARS, MAX_LIBRARY_FILES } from '../library/store.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

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
      reportProgress(toolCallId, `Indexing ${target}`)
      const result = await indexLibrary(target, {
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
