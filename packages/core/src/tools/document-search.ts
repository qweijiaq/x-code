// @x-code-cli/core — documentSearch 工具
//
// 在本地文档库上做混合检索。仅本地：查询会在设备上嵌入（可用时），并与已
// 索引的分块做匹配。
import { tool } from 'ai'

import { z } from 'zod'

import { searchLibrary } from '../library/index.js'
import { formatToolError } from '../utils/tool-errors.js'

export const documentSearch = tool({
  description:
    'Search the local document library. Uses semantic (BGE embeddings) plus keyword ranking when the optional ' +
    'embedding backend is installed, otherwise keyword-only. Results include the file, page (for PDFs), and a ' +
    'snippet. The library must be indexed first with documentLibrary (action:"index"). Nothing is uploaded.',
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe('What to look for'),
    limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default 8)'),
    path: z.string().max(4096).optional().describe('Restrict the search to a file or folder inside the library'),
  }),
  execute: async ({ query, limit, path }) => {
    try {
      const { results, mode } = await searchLibrary(query, { limit, path })
      if (results.length === 0) {
        return (
          `No indexed documents matched "${query}". ` +
          'If the library is empty, index a folder first with documentLibrary (action:"index").'
        )
      }
      const lines = [`Document search (${mode}): ${results.length} result(s)`]
      for (const [index, result] of results.entries()) {
        const where = result.page ? `${result.fileName} — page ${result.page}` : result.fileName
        lines.push('', `${index + 1}. ${where}`, `   ${result.filePath}`, `   ${result.snippet}`)
      }
      return lines.join('\n')
    } catch (err) {
      return formatToolError('searching the document library', err)
    }
  },
})
