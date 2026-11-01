// @x-code-cli/core — semantic navigation tools backed by the workspace's
// TypeScript language service.
//
// These are read-only on purpose: rename returns a preview of every location
// and the agent applies it through the normal edit/write tools, so the usual
// diff and permission path stays intact.
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { formatDiagnostics, formatLocations, formatRename, inferProjectRoot } from '../lsp/format.js'
import { getTypeScriptService } from '../lsp/typescript-service.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { truncateToolResult } from './truncate.js'

const filePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe('File to inspect. Absolute paths are preferred; relative paths resolve against the project root.')

const rootSchema = z
  .string()
  .max(4096)
  .optional()
  .describe('Project root containing tsconfig.json. Omit to infer it from filePath.')

const positionSchema = {
  line: z.number().int().min(1).max(10_000_000).describe('1-based line number'),
  column: z.number().int().min(1).max(1_000_000).describe('1-based column (UTF-16 code unit)'),
}

function projectRoot(filePath: string, root?: string): string {
  return path.resolve(root ?? inferProjectRoot(filePath))
}

export const lspDiagnostics = tool({
  description:
    'Return TypeScript/JavaScript syntactic and semantic diagnostics for one file using the workspace TypeScript language service. ' +
    'Use this when you need compiler-level errors instead of grep. Read-only. If the workspace has no TypeScript installed, fall back to project checks or grep.',
  inputSchema: z.object({
    filePath: filePathSchema,
    root: rootSchema,
    limit: z.number().int().min(1).max(500).optional().describe('Maximum diagnostics (default 120)'),
  }),
  execute: async ({ filePath, root, limit }, { toolCallId, abortSignal }) => {
    try {
      reportProgress(toolCallId, 'Checking TypeScript diagnostics')
      const service = getTypeScriptService(projectRoot(filePath, root))
      const diagnostics = await service.diagnostics(filePath, abortSignal, limit ?? 120)
      return truncateToolResult(formatDiagnostics(diagnostics, filePath), { maxLines: 400 })
    } catch (error) {
      return formatToolError('checking TypeScript diagnostics', error)
    }
  },
})

export const lspDefinition = tool({
  description:
    'Find the declaration of the TypeScript/JavaScript symbol at file:line:column. ' +
    'Use this for precise "where is this defined" questions instead of grepping the name. Read-only.',
  inputSchema: z.object({
    filePath: filePathSchema,
    ...positionSchema,
    root: rootSchema,
    limit: z.number().int().min(1).max(100).optional().describe('Maximum definitions (default 60)'),
  }),
  execute: async ({ filePath, line, column, root, limit }, { toolCallId, abortSignal }) => {
    try {
      reportProgress(toolCallId, `Finding definition at ${path.basename(filePath)}:${line}:${column}`)
      const service = getTypeScriptService(projectRoot(filePath, root))
      const locations = await service.definition(filePath, line, column, abortSignal, limit ?? 60)
      return truncateToolResult(formatLocations(locations, `No definition found at ${filePath}:${line}:${column}.`), {
        maxLines: 200,
      })
    } catch (error) {
      return formatToolError('finding TypeScript definition', error)
    }
  },
})

export const lspReferences = tool({
  description:
    'Find references to the TypeScript/JavaScript symbol at file:line:column using the compiler. ' +
    'Prefer this over grepping a name when you need every call site before editing or renaming. Read-only.',
  inputSchema: z.object({
    filePath: filePathSchema,
    ...positionSchema,
    root: rootSchema,
    includeDeclaration: z.boolean().optional().describe('Include the declaration itself (default true)'),
    limit: z.number().int().min(1).max(300).optional().describe('Maximum references (default 120)'),
  }),
  execute: async ({ filePath, line, column, root, includeDeclaration, limit }, { toolCallId, abortSignal }) => {
    try {
      reportProgress(toolCallId, `Finding references at ${path.basename(filePath)}:${line}:${column}`)
      const service = getTypeScriptService(projectRoot(filePath, root))
      const locations = await service.references(
        filePath,
        line,
        column,
        abortSignal,
        includeDeclaration ?? true,
        limit ?? 120,
      )
      return truncateToolResult(formatLocations(locations, `No references found at ${filePath}:${line}:${column}.`), {
        maxLines: 300,
      })
    } catch (error) {
      return formatToolError('finding TypeScript references', error)
    }
  },
})

export const lspRename = tool({
  description:
    'Preview a TypeScript/JavaScript rename at file:line:column. Returns every occurrence and the replacement name, but does not write files. ' +
    'Apply the returned edits with the normal edit/write tools so the change still goes through diff approval. Read-only.',
  inputSchema: z.object({
    filePath: filePathSchema,
    ...positionSchema,
    newName: z.string().min(1).max(200).describe('Replacement identifier'),
    root: rootSchema,
    limit: z.number().int().min(1).max(500).optional().describe('Maximum occurrences (default 200)'),
  }),
  execute: async ({ filePath, line, column, newName, root, limit }, { toolCallId, abortSignal }) => {
    try {
      reportProgress(toolCallId, `Previewing rename to ${newName}`)
      const service = getTypeScriptService(projectRoot(filePath, root))
      const edits = await service.rename(filePath, line, column, newName, abortSignal, limit ?? 200)
      return truncateToolResult(formatRename(edits, newName), { maxLines: 400 })
    } catch (error) {
      return formatToolError('previewing TypeScript rename', error)
    }
  },
})
