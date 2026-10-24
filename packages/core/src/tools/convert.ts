// @x-code-cli/core — convert tool
//
// Local conversions that do not spend tokens: merge PDFs, extract PDF pages,
// and (on macOS) convert images through `sips`. Every output path is refused
// if it already exists, so a conversion can never clobber a file.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const execFileAsync = promisify(execFile)
const MAX_MERGE_INPUTS = 50
const MAX_INPUT_BYTES = 200 * 1024 * 1024

function parsePages(spec: string, total: number): number[] {
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Math.max(1, Number(range[1]))
      const end = Math.min(total, Number(range[2]))
      for (let page = start; page <= end; page++) pages.add(page)
      continue
    }
    if (/^\d+$/.test(trimmed)) {
      const page = Number(trimmed)
      if (page >= 1 && page <= total) pages.add(page)
    }
  }
  return [...pages].sort((a, b) => a - b)
}

async function ensureOutput(output: string): Promise<void> {
  const exists = await fs
    .access(output)
    .then(() => true)
    .catch(() => false)
  if (exists) throw new Error(`Output already exists; refusing to overwrite: ${output}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
}

async function totalSize(files: string[]): Promise<number> {
  let total = 0
  for (const file of files) total += (await fs.stat(file)).size
  if (total > MAX_INPUT_BYTES) {
    throw new Error(`Inputs total ${Math.round(total / 1024 / 1024)} MB; cap is ${MAX_INPUT_BYTES / 1024 / 1024} MB.`)
  }
  return total
}

export const convert = tool({
  description:
    'Convert local files without uploading anything. Actions: "pdf-merge" combines input PDFs into one; ' +
    '"pdf-extract" copies a page range (e.g. "1-3,7") into a new PDF; "image-convert" converts a png/jpeg/tiff/bmp/gif ' +
    'image on macOS via sips. The output path must not already exist. This is a write operation and requires permission.',
  inputSchema: z.object({
    action: z.enum(['pdf-merge', 'pdf-extract', 'image-convert']).describe('Conversion to perform'),
    output: z.string().min(1).max(4096).describe('Absolute path for the new file (must not exist)'),
    inputs: z
      .array(z.string().min(1).max(4096))
      .min(2)
      .max(MAX_MERGE_INPUTS)
      .optional()
      .describe('pdf-merge: source PDFs in order'),
    input: z.string().min(1).max(4096).optional().describe('pdf-extract / image-convert: source file'),
    pages: z.string().max(200).optional().describe('pdf-extract: page range such as "1-3,7"'),
    format: z.enum(['png', 'jpeg', 'tiff', 'bmp', 'gif']).optional().describe('image-convert output format'),
  }),
  execute: async (input, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      const output = path.resolve(input.output)
      await ensureOutput(output)

      if (input.action === 'pdf-merge') {
        if (!input.inputs || input.inputs.length < 2) throw new Error('pdf-merge needs at least two inputs.')
        const sources = input.inputs.map((file) => path.resolve(file))
        await totalSize(sources)
        const { PDFDocument } = await import('pdf-lib')
        const merged = await PDFDocument.create()
        for (const [index, file] of sources.entries()) {
          abortSignal?.throwIfAborted()
          reportProgress(toolCallId, `Merging ${index + 1}/${sources.length}: ${path.basename(file)}`)
          const source = await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true })
          const pages = await merged.copyPages(source, source.getPageIndices())
          for (const page of pages) merged.addPage(page)
        }
        await fs.writeFile(output, await merged.save())
        return `Merged ${sources.length} PDFs (${merged.getPageCount()} pages) → ${output}`
      }

      if (input.action === 'pdf-extract') {
        if (!input.input) throw new Error('pdf-extract needs a source file.')
        if (!input.pages) throw new Error('pdf-extract needs a page range, e.g. "1-3,7".')
        const source = path.resolve(input.input)
        await totalSize([source])
        reportProgress(toolCallId, `Extracting pages ${input.pages}`)
        const { PDFDocument } = await import('pdf-lib')
        const document = await PDFDocument.load(await fs.readFile(source), { ignoreEncryption: true })
        const pages = parsePages(input.pages, document.getPageCount())
        if (pages.length === 0)
          throw new Error(`No valid pages in "${input.pages}" (document has ${document.getPageCount()}).`)
        const extracted = await PDFDocument.create()
        const copied = await extracted.copyPages(
          document,
          pages.map((page) => page - 1),
        )
        for (const page of copied) extracted.addPage(page)
        await fs.writeFile(output, await extracted.save())
        return `Extracted ${pages.length} page(s) from ${path.basename(source)} → ${output}`
      }

      if (!input.input) throw new Error('image-convert needs a source file.')
      if (!input.format) throw new Error('image-convert needs a format.')
      if (process.platform !== 'darwin') {
        return '[image-convert is only implemented on macOS (uses sips); use another tool on this platform.]'
      }
      const source = path.resolve(input.input)
      abortSignal?.throwIfAborted()
      reportProgress(toolCallId, `Converting ${path.basename(source)} to ${input.format}`)
      await execFileAsync('sips', ['-s', 'format', input.format, source, '--out', output], {
        maxBuffer: 1024 * 1024,
      })
      const stats = await fs.stat(output)
      return `Converted ${path.basename(source)} → ${output} (${Math.max(1, Math.round(stats.size / 1024))} KB)`
    } catch (err) {
      return formatToolError('converting files', err)
    }
  },
})
