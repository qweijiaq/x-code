// @x-code-cli/core — batchRename 工具
//
// 就地重命名文件：默认先 dry-run，100 个文件上限，且强制不覆盖规则。它
// 刻意不能跨目录移动文件、不能通过单独选项改扩展名，也不能删除任何东西。
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const MAX_FILES = 100
const MAX_DEPTH = 6

const inputSchema = z.object({
  directory: z.string().min(1).max(4096).describe('Absolute path to the directory to rename files in'),
  find: z.string().max(200).optional().describe('Literal text to replace in the file name (all occurrences)'),
  replace: z.string().max(200).optional().describe('Replacement for `find` (default: empty string)'),
  prefix: z.string().max(100).optional().describe('Text prepended to each file name'),
  suffix: z.string().max(100).optional().describe('Text appended to each file name (before the extension)'),
  extensions: z
    .array(z.string().max(16))
    .max(20)
    .optional()
    .describe('Only rename files with these extensions, with or without the leading dot (e.g. ["png","jpg"])'),
  numbering: z
    .object({
      start: z.number().int().min(0).max(1_000_000).optional().describe('First number (default 1)'),
      padding: z.number().int().min(1).max(10).optional().describe('Zero padding width (default 3)'),
    })
    .optional()
    .describe('Replace each base name with a padded sequence number'),
  dryRun: z.boolean().optional().describe('Preview only (default true). Set false to apply the renames'),
  recursive: z.boolean().optional().describe('Also rename files in subdirectories (max depth 6)'),
})

interface Candidate {
  filePath: string
  relative: string
  name: string
}

async function collectFiles(root: string, recursive: boolean, extensions: Set<string>): Promise<Candidate[]> {
  const files: Candidate[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && files.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) break
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.size > 0 && !extensions.has(path.extname(entry.name).toLowerCase())) continue
      files.push({ filePath: full, relative: path.relative(root, full), name: entry.name })
    }
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative))
}

function computeName(name: string, index: number, options: z.infer<typeof inputSchema>): string {
  const extension = path.extname(name)
  let base = path.basename(name, extension)
  if (options.numbering) {
    const start = options.numbering.start ?? 1
    const padding = options.numbering.padding ?? 3
    base = String(start + index).padStart(padding, '0')
  } else if (options.find) {
    base = base.split(options.find).join(options.replace ?? '')
  }
  return `${options.prefix ?? ''}${base}${options.suffix ?? ''}${extension}`
}

export const batchRename = tool({
  description:
    'Rename files in a directory in place. Defaults to a dry run that only returns the plan. Never overwrites an ' +
    'existing file, never moves files between directories, and processes at most 100 files. Use dryRun:false to ' +
    'apply. Supported edits: literal find/replace in the base name, a prefix or suffix, and optional sequential ' +
    'numbering. Renaming is a write operation and requires permission.',
  inputSchema,
  execute: async (input, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      const root = path.resolve(input.directory)
      const stat = await fs.stat(root)
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`)

      const extensions = new Set(
        (input.extensions ?? []).map((value) => {
          const normalised = value.trim().toLowerCase()
          return normalised.startsWith('.') ? normalised : `.${normalised}`
        }),
      )
      reportProgress(toolCallId, `Scanning ${root}`)
      const files = await collectFiles(root, input.recursive === true, extensions)
      if (files.length === 0) return 'No matching files.'

      const dryRun = input.dryRun !== false
      const planned: Array<{ from: string; to: string; conflict?: string }> = []
      const targets = new Set<string>()
      for (const [index, file] of files.entries()) {
        abortSignal?.throwIfAborted()
        const nextName = computeName(file.name, index, input)
        const target = path.join(path.dirname(file.filePath), nextName)
        if (nextName === file.name) {
          planned.push({ from: file.relative, to: nextName })
          continue
        }
        const caseOnly = file.filePath.toLowerCase() === target.toLowerCase()
        const lowerTarget = target.toLowerCase()
        if (targets.has(lowerTarget) && !caseOnly) {
          planned.push({ from: file.relative, to: nextName, conflict: 'duplicate target' })
          continue
        }
        targets.add(lowerTarget)
        const exists = await fs
          .access(target)
          .then(() => true)
          .catch(() => false)
        planned.push({
          from: file.relative,
          to: nextName,
          ...(exists && !caseOnly ? { conflict: 'target exists' } : {}),
        })
      }

      const changed = planned.filter((entry) => entry.from !== entry.to)
      const conflicts = planned.filter((entry) => entry.conflict)
      const lines = planned.map((entry) =>
        entry.from === entry.to
          ? `  ${entry.from} (unchanged)`
          : `  ${entry.from} → ${entry.to}${entry.conflict ? ` [${entry.conflict}]` : ''}`,
      )

      if (conflicts.length > 0) {
        return [
          `Batch rename blocked: ${conflicts.length} conflict(s). Nothing was renamed.`,
          ...lines,
          'Rename or remove the conflicting targets first.',
        ].join('\n')
      }
      if (dryRun) {
        return [
          `Dry run: ${changed.length} of ${planned.length} file(s) would be renamed in ${root}.`,
          ...lines,
          'Call again with dryRun:false to apply.',
        ].join('\n')
      }

      let renamed = 0
      for (const entry of changed) {
        abortSignal?.throwIfAborted()
        const from = path.join(root, entry.from)
        const to = path.join(path.dirname(from), entry.to)
        const exists = await fs
          .access(to)
          .then(() => true)
          .catch(() => false)
        if (exists && from.toLowerCase() !== to.toLowerCase()) {
          return `Stopped after renaming ${renamed} file(s): ${entry.to} appeared during the run.`
        }
        await fs.rename(from, to)
        renamed++
        reportProgress(toolCallId, `Renamed ${renamed}/${changed.length}`)
      }
      return [`Renamed ${renamed} file(s) in ${root}.`, ...lines].join('\n')
    } catch (err) {
      return formatToolError('batch renaming', err)
    }
  },
})
