// @x-code-cli/core — documentExport 工具
//
// 在本地把 Markdown/HTML 渲染成 PDF 或 DOCX。PDF 渲染需要一个 Electron
// 渲染器（桌面运行时负责注册）；DOCX 用 macOS 的 `textutil`。不上传任何
// 东西，且从不覆盖已有输出。
import { marked } from 'marked'

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { isSystemTempPath, workspaceOutputNote } from '../utils/output-location.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const execFileAsync = promisify(execFile)

export type DocumentRenderer = (html: string, title: string) => Promise<Buffer>

let pdfRenderer: DocumentRenderer | null = null

/** 桌面运行时注册一个 Electron printToPDF 渲染器；CLI 宿主保持未设置，在
 *  请求 PDF 输出时会得到一条明确的提示消息。 */
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
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
function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/** 输出路径必须落在工作区内（系统临时目录除外——那是文档里允许的临时交付
 *  位置，工具结果会附带一条引导回工作区的提醒）。只有“文件不存在”这一条
 *  限制的话，`~/.zshrc`、`~/.ssh/config`、LaunchAgents 之类的任意写都能绕过
 *  不覆盖保护，所以这里显式与工作区根比较。目标文件本身必须还不存在，因此
 *  只能归一化父目录来消除软链逃逸。 */
function assertOutputLocation(resolved: string): void {
  const workspace = path.resolve(process.cwd())
  const realWorkspace = realpathOrNull(workspace) ?? workspace
  const parent = path.dirname(resolved)
  const normalized = path.join(realpathOrNull(parent) ?? parent, path.basename(resolved))
  const insideWorkspace = normalized === realWorkspace || normalized.startsWith(realWorkspace + path.sep)
  if (!insideWorkspace && !isSystemTempPath(normalized)) {
    throw new Error(
      `Output must be inside the working directory (${workspace}) or the system temp directory; ` +
        `refusing to write ${resolved}`,
    )
  }
}

async function assertWritableOutput(output: string): Promise<void> {
  const exists = await fs
    .access(output)
    .then(() => true)
    .catch(() => false)
  if (exists) throw new Error(`Output already exists; refusing to overwrite: ${output}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
}

/** 把“不覆盖已有文件”交给文件系统保证：渲染可能耗时数秒，前置 `fs.access`
 *  检查到这里之间是 TOCTOU 窗口，`fs.writeFile` 的默认 'w' 会静默清空并覆盖
 *  期间出现的同名文件。'wx' 让创建与判存成为同一次原子操作。 */
async function writeNewFile(target: string, bytes: Uint8Array): Promise<void> {
  try {
    await fs.writeFile(target, bytes, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`Output already exists; refusing to overwrite: ${target}`)
    }
    throw err
  }
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
    'an existing file. Write the output inside the working directory (not the system temp directory). This is a write operation and requires permission.',
  inputSchema: z.object({
    content: z.string().min(1).max(500_000).describe('Document body'),
    contentFormat: z.enum(['markdown', 'html']).optional().describe('How to interpret content (default markdown)'),
    format: z.enum(['pdf', 'docx']).describe('Output format'),
    output: z.string().min(1).max(4096).describe('Absolute output path inside the working directory (must not exist)'),
    title: z.string().max(200).optional().describe('Document title used in metadata/header'),
  }),
  execute: async ({ content, contentFormat, format, output, title }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      const resolved = path.resolve(output)
      assertOutputLocation(resolved)
      await assertWritableOutput(resolved)
      const documentTitle = title?.trim() || path.basename(resolved, path.extname(resolved))
      reportProgress(toolCallId, `Rendering ${format.toUpperCase()}`)
      const html = await toHtml(content, contentFormat ?? 'markdown', documentTitle)

      let bytes: Uint8Array
      if (format === 'pdf') {
        if (!pdfRenderer) {
          return '[PDF export needs the desktop app (Electron renderer). Use format:"docx" or run from X-Code Desktop.]'
        }
        bytes = await pdfRenderer(html, documentTitle)
      } else {
        bytes = await renderDocx(html, documentTitle)
      }
      await writeNewFile(resolved, bytes)
      abortSignal?.throwIfAborted()
      const stats = await fs.stat(resolved)
      return `Exported ${format.toUpperCase()} → ${resolved} (${Math.max(1, Math.round(stats.size / 1024))} KB)${workspaceOutputNote(resolved)}`
    } catch (err) {
      return formatToolError('exporting the document', err)
    }
  },
})
