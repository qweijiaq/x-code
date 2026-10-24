// @x-code-cli/core — documentExport tool
//
// Renders Markdown/HTML into PDF or DOCX locally. PDF rendering needs an
// Electron renderer, which the desktop runtime registers; DOCX uses macOS
// `textutil`. Nothing is uploaded, and an existing output is never overwritten.
import { marked } from 'marked'

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const execFileAsync = promisify(execFile)

export type DocumentRenderer = (html: string, title: string) => Promise<Buffer>

let pdfRenderer: DocumentRenderer | null = null

/** The desktop runtime registers an Electron printToPDF renderer; CLI hosts
 *  leave it unset and get a clear message when asking for PDF output. */
export function setDocumentRenderers(renderers: { pdf?: DocumentRenderer | null }): void {
  pdfRenderer = renderers.pdf ?? null
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function wrapHtml(body: string, title: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 48px 56px; color: #1c1a16; background: #fff;
    font-family: "Songti SC", "Noto Serif SC", Georgia, serif; font-size: 12.5pt; line-height: 1.75; }
  h1, h2, h3, h4 { font-family: "PingFang SC", "Noto Sans SC", sans-serif; letter-spacing: 0.02em; margin: 1.2em 0 0.5em; }
  h1 { font-size: 22pt; border-bottom: 1px solid #d8cfbc; padding-bottom: 0.3em; }
  h2 { font-size: 17pt; }
  h3 { font-size: 14pt; }
  p { margin: 0 0 0.9em; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 0.9em; background: #f3efe4; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #f3efe4; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0.8em 0; padding-left: 1em; border-left: 2px solid #d8cfbc; color: #555049; }
  table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
  th, td { border: 1px solid #d8cfbc; padding: 6px 9px; text-align: left; }
  th { background: #f3efe4; }
  img { max-width: 100%; }
  a { color: #3f5f7f; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

async function toHtml(content: string, contentFormat: 'markdown' | 'html', title: string): Promise<string> {
  const body = contentFormat === 'html' ? content : String(await marked.parse(content, { async: false }))
  return wrapHtml(body, title)
}

async function assertWritableOutput(output: string): Promise<void> {
  const exists = await fs
    .access(output)
    .then(() => true)
    .catch(() => false)
  if (exists) throw new Error(`Output already exists; refusing to overwrite: ${output}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
}

async function renderDocx(html: string, title: string): Promise<Buffer> {
  if (process.platform !== 'darwin') {
    throw new Error('DOCX export uses macOS textutil; this platform is not supported yet.')
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-docx-'))
  const htmlPath = path.join(dir, 'document.html')
  const docxPath = path.join(dir, 'document.docx')
  try {
    await fs.writeFile(htmlPath, html, 'utf8')
    await execFileAsync('textutil', ['-convert', 'docx', '-output', docxPath, '-title', title, htmlPath], {
      maxBuffer: 4 * 1024 * 1024,
    })
    return await fs.readFile(docxPath)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export const documentExport = tool({
  description:
    'Export a Markdown or HTML document to PDF or DOCX on this machine, without uploading it. PDF rendering ' +
    'requires the desktop app (Electron); DOCX uses macOS textutil. Returns the output path; refuses to overwrite ' +
    'an existing file. This is a write operation and requires permission.',
  inputSchema: z.object({
    content: z.string().min(1).max(500_000).describe('Document body'),
    contentFormat: z.enum(['markdown', 'html']).optional().describe('How to interpret content (default markdown)'),
    format: z.enum(['pdf', 'docx']).describe('Output format'),
    output: z.string().min(1).max(4096).describe('Absolute output path (must not exist)'),
    title: z.string().max(200).optional().describe('Document title used in metadata/header'),
  }),
  execute: async ({ content, contentFormat, format, output, title }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      const resolved = path.resolve(output)
      await assertWritableOutput(resolved)
      const documentTitle = title?.trim() || path.basename(resolved, path.extname(resolved))
      reportProgress(toolCallId, `Rendering ${format.toUpperCase()}`)
      const html = await toHtml(content, contentFormat ?? 'markdown', documentTitle)

      if (format === 'pdf') {
        if (!pdfRenderer) {
          return '[PDF export needs the desktop app (Electron renderer). Use format:"docx" or run from X-Code Desktop.]'
        }
        const bytes = await pdfRenderer(html, documentTitle)
        await fs.writeFile(resolved, bytes)
      } else {
        const bytes = await renderDocx(html, documentTitle)
        await fs.writeFile(resolved, bytes)
      }
      abortSignal?.throwIfAborted()
      const stats = await fs.stat(resolved)
      return `Exported ${format.toUpperCase()} → ${resolved} (${Math.max(1, Math.round(stats.size / 1024))} KB)`
    } catch (err) {
      return formatToolError('exporting the document', err)
    }
  },
})
