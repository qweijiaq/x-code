// @x-code-cli/core — readFile 工具
//
// 文本文件带行号返回。图片和本地渲染的 PDF 页面只在注入的模型支持视觉时，
// 才用带标签的图片 FileParts；否则共享管线返回本地 OCR 文本。原始
// PDF/音频/一般二进制字节从不作为 file-data 输出。
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { formatTranscription, transcribeAudio } from '../agent/audio-transcribe.js'
import { assertSafeTextContent, inspectFile } from '../agent/file-classifier.js'
import type { TextEncoding } from '../agent/file-classifier.js'
import { extractOfficeTextResult } from '../agent/file-ingest.js'
import { ocrImage } from '../agent/image-ocr.js'
import { BUILT_IN_MEDIA_ANALYSIS_NOTE, toToolResultContent } from '../agent/local-media.js'
import { MAX_NOTEBOOK_SOURCE_BYTES, renderNotebookFile } from '../agent/notebook-render.js'
import { PDF_AUTO_MAX_RENDERED_PAGES, PDF_READ_MAX_PAGES, formatPdfReference, processPdf } from '../agent/pdf-ingest.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { truncateUtf8 } from '../utils.js'
import { FileSizeLimitError, readFileWithinLimit } from '../utils/bounded-read.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  MAX_IMAGE_SOURCE_BYTES,
  buildImageProcessingFailureNotice,
  compressImage,
} from '../utils/image-compress.js'
import { knownMediaTypeFor } from '../utils/media-type.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

/** 无参数 readFile 调用返回行数的默认上限。对齐 Claude Code 的
 *  MAX_LINES_TO_READ —— 凭经验挑的：2000 行是“通读整个文件”的现实上限，
 *  再大的几乎总是先用 grep。原来是 500，后来观察到 500 会让合法的“读整个
 *  模块”场景被迫做太多往返（同等覆盖下比 CC 多 4 倍调用），于是上调。 */
const LARGE_FILE_LINE_THRESHOLD = 2000

/** 单次工具结果载荷的字节上限。对应 file-ingest.ts 里 @-attach 的摄入上限，
 *  以及 Claude Code Read 工具 25K-token 默认值（约 100 KB 英文 / 约 75 KB
 *  CJK；256 KB 留了余量）。同时作用于默认的头部情形和显式的 offset/limit
 *  情形 —— 没有这个，模型对多 MB 文件请求 `limit: 90000` 时，整份内容会被
 *  倒进上下文，下一轮就以 context_length_exceeded 失败。CC 通过
 *  `validateContentTokens` 执行同样的不变量。 */
const MAX_READ_BYTES = 256 * 1024

/** 每个文件的指纹，供已交付内容去重缓存使用。 */
export interface ReadFileCacheEntry {
  mtimeMs: number
  size: number
}
/** 会话作用域的映射：绝对路径 → 最近交付的指纹。放在 LoopState 上，这样每个
 *  agent（包括拿到全新 LoopState 的子 agent）都有自己隔离的缓存，一个
 *  agent 的读取永远不会让另一个 agent 对一个它从没见过的文件返回占位桩。 */
export type ReadFileCache = Map<string, ReadFileCacheEntry>

export interface ReadFileToolOptions {
  modelId?: string
}

export function parsePdfPageRange(value: string): { first: number; last: number } | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim())
  if (!match) return null
  const first = Number(match[1])
  const last = Number(match[2] ?? match[1])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return null
  if (last - first + 1 > PDF_READ_MAX_PAGES) return null
  return { first, last }
}

async function readTextResult(
  filePath: string,
  offset?: number,
  limit?: number,
  abortSignal?: AbortSignal,
  encoding: TextEncoding = 'utf-8',
): Promise<{ text: string; complete: boolean }> {
  const userSpecifiedRange = offset != null || limit != null
  const startLine = offset ?? 1
  const maxLines = limit ?? (userSpecifiedRange ? Number.MAX_SAFE_INTEGER : LARGE_FILE_LINE_THRESHOLD)
  const formatted: string[] = []
  const stream = createReadStream(filePath, { signal: abortSignal })
  let outputBytes = 0
  let lineNumber = 1
  let lineParts: string[] = []
  let lineBytes = 0
  let stopped = false
  let hasMoreLines = false
  let byteCapped = false
  let partialLine = false

  const collectSegment = (segment: string): void => {
    if (lineNumber < startLine || formatted.length >= maxLines) return
    const separatorBytes = formatted.length > 0 ? 1 : 0
    const prefixBytes = Buffer.byteLength(`${lineNumber}\t`, 'utf-8')
    const remaining = MAX_READ_BYTES - outputBytes - separatorBytes - prefixBytes - lineBytes
    const segmentBytes = Buffer.byteLength(segment, 'utf-8')
    if (segmentBytes <= remaining) {
      if (segment.length > 0) lineParts.push(segment)
      lineBytes += segmentBytes
      return
    }
    if (formatted.length > 0) {
      lineParts = []
      lineBytes = 0
      byteCapped = true
      stopped = true
      return
    }
    if (remaining > 0) {
      const truncated = truncateUtf8(segment, remaining)
      lineParts.push(truncated)
      lineBytes += Buffer.byteLength(truncated, 'utf-8')
    }
    byteCapped = true
    partialLine = true
    stopped = true
  }

  const finishLine = (): void => {
    if (lineNumber >= startLine) {
      if (formatted.length >= maxLines) {
        hasMoreLines = true
        stopped = true
        return
      }
      const text = lineParts.join('').replace(/\r$/, '')
      const numbered = `${lineNumber}\t${text}`
      const addedBytes = Buffer.byteLength(numbered, 'utf-8') + (formatted.length > 0 ? 1 : 0)
      formatted.push(numbered)
      outputBytes += addedBytes
    }
    lineParts = []
    lineBytes = 0
    lineNumber++
  }

  const decoder = new TextDecoder(encoding, { fatal: true })
  const consume = (decoded: string): void => {
    assertSafeTextContent(decoded)
    let cursor = 0
    while (cursor < decoded.length && !stopped) {
      const newline = decoded.indexOf('\n', cursor)
      const end = newline === -1 ? decoded.length : newline
      collectSegment(decoded.slice(cursor, end))
      if (stopped || newline === -1) break
      finishLine()
      cursor = newline + 1
    }
  }

  try {
    for await (const value of stream) {
      const chunk = value as Buffer
      consume(decoder.decode(chunk, { stream: true }))
      if (stopped) break
    }
    if (!stopped) {
      consume(decoder.decode())
      finishLine()
    }
  } finally {
    stream.destroy()
  }

  if (partialLine) {
    let text = lineParts.join('')
    const separatorBytes = formatted.length > 0 ? 1 : 0
    while (Buffer.byteLength(`${lineNumber}\t${text}`, 'utf-8') + separatorBytes > MAX_READ_BYTES) {
      text = text.slice(0, -1)
    }
    formatted.push(`${lineNumber}\t${text}`)
  }

  const includedLines = formatted.length
  const body = formatted.join('\n')

  if (!userSpecifiedRange && (hasMoreLines || byteCapped)) {
    const note = byteCapped
      ? `; output capped at ${MAX_READ_BYTES / 1024} KB${partialLine ? ' because the current line itself exceeds the cap' : ''}`
      : ''
    return {
      text:
        body +
        `\n\n[readFile: showing first ${includedLines} lines${note}; the file contains more content. ` +
        `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols. ` +
        `For whole-file analysis of very large files, consider delegating to a sub-agent via the task tool — ` +
        `each sub-agent reads in isolated context and returns only a summary.]`,
      complete: false,
    }
  }
  if (byteCapped) {
    const nextOffset = lineNumber + (partialLine ? 1 : 0)
    const continuation = partialLine
      ? `The last line itself exceeded the cap; use grep to inspect it instead of skipping its remainder.`
      : `Call readFile again with offset=${nextOffset} for the next chunk, or narrow the range.`
    return {
      text:
        body +
        `\n\n[readFile: output capped at ${MAX_READ_BYTES / 1024} KB; ` +
        `returned ${includedLines} requested lines starting at line ${startLine}. ${continuation}]`,
      complete: false,
    }
  }

  return { text: body, complete: !userSpecifiedRange }
}

// ── 读取去重 ──
// 重新读一个本次会话已交付完整文本的文件 —— 无论是经附件摄入还是 readFile
// —— 都浪费上下文。改为返回一个短占位桩，可以省下成千上万个 token，也避免
// 反复做本地转写。只有产出文本的整文件读取才去重；显式文本范围总是重新读，
// 而图片/PDF 读取仍可用于刻意的再次视觉查看。一次编辑/写入会改变文件的
// mtime，所以下一次读取自然错过缓存、返回新鲜内容。
type ReadCacheVerdict = { hit: true; stub: string } | { hit: false; entry: ReadFileCacheEntry } | null

async function checkReadCache(
  cache: ReadFileCache | undefined,
  filePath: string,
  isRangeRead: boolean,
): Promise<ReadCacheVerdict> {
  if (!cache || isRangeRead) return null
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null // 让正常读取路径去暴露错误
  const prev = cache.get(filePath)
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
    return {
      hit: true,
      stub:
        `[readFile: ${filePath} is unchanged since its full content was added to this conversation ` +
        `(same mtime and size); its full content is already in the conversation above. ` +
        `Analyze that content directly instead of reading it again. For text files, use an explicit offset/limit ` +
        `only to revisit a specific range, or use grep to search within it.]`,
    }
  }
  return { hit: false, entry: { mtimeMs: stat.mtimeMs, size: stat.size } }
}

/** 构建 readFile 工具。可选的 `cache` 开启会话作用域的读取去重（见
 *  checkReadCache）。buildTools 从 LoopState 注入每会话缓存；下面裸导出的
 *  `readFile` 不传任何缓存，因此对任何直接导入它的调用方（测试等）行为与
 *  之前完全一致（不去重）。 */
export function createReadFileTool(cache?: ReadFileCache, options: ReadFileToolOptions = {}) {
  return tool({
    description: `Read a file from the local filesystem. Assume this tool can read all files on the machine.

Usage:
- The filePath parameter must be an absolute path, not a relative path.
- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file first.
- PDFs are processed locally. Use pages such as "1-5" for a maximum of 20 pages, and pdfMode="visual" for layouts, charts, or signatures.
- Results are returned with line numbers starting at 1.
- This tool can read images (PNG, JPG, etc.) and PDFs — their content is presented inline.
- This tool can read MP3, M4A, WAV, FLAC, and OGG Vorbis audio files (up to 20 minutes) — they are transcribed locally using a Whisper model, returning timestamped text. The original audio is never uploaded.
- For content analysis of supported media, use this tool before shell or OS media utilities. If it returns usable content, analyze that directly; use external utilities only after an explicit processing failure or for a user-requested conversion or codec diagnostic.
- This tool renders Jupyter notebooks (.ipynb) as readable cells (source + text outputs), skipping binary image outputs.
- This tool can only read files, not directories. To list a directory, use listDir or shell with ls.
- If a file path is provided by the user, assume it is valid.`,
    inputSchema: z
      .object({
        filePath: z.string().describe('Absolute path to the file'),
        offset: z.number().int().min(1).optional().describe('Start line (1-based, text files only)'),
        limit: z.number().int().min(1).optional().describe('Max lines to read (text files only)'),
        pages: z
          .string()
          .optional()
          .describe('PDF page or inclusive range, for example "3" or "1-5"; maximum 20 pages'),
        pdfMode: z.enum(['auto', 'text-only', 'visual']).optional().describe('PDF processing mode; defaults to auto'),
      })
      .superRefine((value, ctx) => {
        if ((value.pages || value.pdfMode) && (value.offset != null || value.limit != null)) {
          ctx.addIssue({ code: 'custom', message: 'PDF pages/pdfMode cannot be combined with offset or limit' })
        }
      }),
    execute: async ({ filePath, offset, limit, pages, pdfMode }, { toolCallId, abortSignal }) => {
      try {
        abortSignal?.throwIfAborted()
        reportProgress(toolCallId, `Reading ${filePath}`)
        const isRangeRead = offset != null || limit != null

        const classification = await inspectFile(filePath, abortSignal)
        const kind = classification.kind
        abortSignal?.throwIfAborted()

        if ((pages || pdfMode) && kind !== 'pdf') return 'pages and pdfMode are only valid for PDF files.'

        // Jupyter notebook 是 JSON —— 渲染单元格，而不是倾倒满是 base64 的
        // 原始 JSON。先分类可确保一个被改名的二进制文件永远不会被当成
        // notebook 文本解码。
        if (kind === 'notebook') {
          const stats = await fs.stat(filePath)
          if (stats.size > MAX_NOTEBOOK_SOURCE_BYTES) {
            return `[Notebook ${filePath} is too large to parse safely (${(stats.size / (1024 * 1024)).toFixed(1)} MB, cap ${MAX_NOTEBOOK_SOURCE_BYTES / (1024 * 1024)} MB). Use grep or shell tools to inspect selected cells.]`
          }
          const verdict = await checkReadCache(cache, filePath, false)
          if (verdict && verdict.hit) return verdict.stub
          const { text, complete } = await renderNotebookFile(filePath, abortSignal)
          if (verdict && !verdict.hit && complete) cache?.set(filePath, verdict.entry)
          return text
        }

        if (kind === 'audio') {
          const verdict = await checkReadCache(cache, filePath, false)
          if (verdict && verdict.hit) return verdict.stub
          const result = await transcribeAudio(filePath, {
            abortSignal,
            onNotice: (msg) => reportProgress(toolCallId, msg),
          })
          if (typeof result === 'string') return result
          const formatted = formatTranscription(result, filePath)
          const textBytes = Buffer.byteLength(formatted, 'utf-8')
          if (textBytes > MAX_READ_BYTES) {
            return (
              `[Audio transcription of ${filePath} is too large (${(textBytes / 1024).toFixed(1)} KB, ` +
              `cap ${MAX_READ_BYTES / 1024} KB). The audio may be very long.]`
            )
          }
          if (verdict && !verdict.hit) cache?.set(filePath, verdict.entry)
          return formatted
        }

        if (kind === 'image') {
          const verdict = await checkReadCache(cache, filePath, false)
          if (verdict && verdict.hit) return verdict.stub
          const stats = await fs.stat(filePath)
          if (stats.size > MAX_IMAGE_SOURCE_BYTES) {
            return `[Image ${filePath} is too large to process safely (${(stats.size / (1024 * 1024)).toFixed(1)} MB, cap ${MAX_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB).]`
          }
          let buffer: Buffer
          try {
            buffer = await readFileWithinLimit(filePath, MAX_IMAGE_SOURCE_BYTES, abortSignal)
          } catch (error) {
            if (!(error instanceof FileSizeLimitError)) throw error
            return `[Image ${filePath} is too large to process safely (${(error.observedBytes / (1024 * 1024)).toFixed(1)} MB, cap ${error.limitBytes / (1024 * 1024)} MB).]`
          }
          const mime = (await sniffImageMime(buffer)) ?? classification.mediaType ?? knownMediaTypeFor(filePath)
          if (!mime?.startsWith('image/')) return `[Image ${filePath} has an unsupported or unrecognized format.]`
          // 与用户附件图片相同的字节预算（ATTACH_BYTE_BUDGET）。
          const compressed = await compressImage(buffer, mime, {
            byteBudget: ATTACH_BYTE_BUDGET,
            abortSignal,
          })
          const finalMime = normalizeImageMime(compressed.mimeType)
          if (
            compressed.failureReason ||
            !isModelAcceptedImageMime(finalMime) ||
            compressed.data.length > ATTACH_BYTE_BUDGET ||
            compressed.width > MAX_EDGE_PX ||
            compressed.height > MAX_EDGE_PX
          ) {
            return buildImageProcessingFailureNotice(filePath, compressed)
          }
          if (options.modelId && !modelSupportsVision(options.modelId)) {
            const ocr = await ocrImage(compressed.data, { abortSignal })
            const rendered =
              `[Local OCR for image ${filePath}; the current model cannot see layout, diagrams, or photos.]\n` + ocr
            if (Buffer.byteLength(rendered, 'utf-8') > MAX_READ_BYTES) {
              return `[Image OCR output for ${filePath} exceeds the ${MAX_READ_BYTES / 1024} KB tool-result limit.]`
            }
            return rendered
          }
          if (!isModelAcceptedImage(finalMime, { modelId: options.modelId, animated: compressed.animated })) {
            return buildUnsupportedImageNotice(finalMime, filePath, options.modelId, compressed.animated)
          }
          const header = compressed.changed
            ? `Loaded image: ${filePath} (compressed from ${buffer.length} to ${compressed.data.length} bytes)`
            : `Loaded image: ${filePath}`
          if (verdict && !verdict.hit) cache?.set(filePath, verdict.entry)
          return {
            type: 'content',
            value: [
              { type: 'text', text: header },
              {
                type: 'file',
                data: { type: 'data', data: compressed.data.toString('base64') },
                mediaType: finalMime,
                filename: path.basename(filePath),
              },
              { type: 'text', text: BUILT_IN_MEDIA_ANALYSIS_NOTE },
            ],
          }
        }

        if (kind === 'pdf') {
          let pageRange: { first: number; last: number } | undefined
          if (pages !== undefined) {
            const parsed = parsePdfPageRange(pages)
            if (!parsed) {
              return `Invalid PDF pages value "${pages}". Use a single page or inclusive range of at most ${PDF_READ_MAX_PAGES} pages, for example "3" or "1-5".`
            }
            pageRange = parsed
          }
          const result = await processPdf(filePath, {
            pageRange,
            vision: options.modelId ? modelSupportsVision(options.modelId) : false,
            mode: pdfMode ?? 'auto',
            maxRenderedPages: pageRange ? PDF_READ_MAX_PAGES : PDF_AUTO_MAX_RENDERED_PAGES,
            abortSignal,
            onNotice: (message) => reportProgress(toolCallId, message),
          })
          if (result.type === 'error') return `[PDF processing failed: ${result.message}]`
          if (result.type === 'reference') return formatPdfReference(result)
          const content = toToolResultContent(result.parts)
          if (result.continuation) {
            content.value.push({ type: 'text', text: formatPdfReference(result.continuation) })
          }
          content.value.push({ type: 'text', text: BUILT_IN_MEDIA_ANALYSIS_NOTE })
          return content
        }

        if (kind === 'office') {
          const verdict = await checkReadCache(cache, filePath, false)
          if (verdict && verdict.hit) return verdict.stub
          const extraction = await extractOfficeTextResult(filePath, abortSignal, classification.mediaType)
          abortSignal?.throwIfAborted()
          if (!extraction.ok) return extraction.text
          const { text } = extraction
          const textBytes = Buffer.byteLength(text, 'utf-8')
          if (textBytes > MAX_READ_BYTES) {
            return (
              `[Office file ${filePath} extracted text is too large (${(textBytes / 1024).toFixed(1)} KB, ` +
              `cap ${MAX_READ_BYTES / 1024} KB). ` +
              `Use grep to search for specific content, or delegate to a sub-agent via the task tool.]`
            )
          }
          if (verdict && !verdict.hit) cache?.set(filePath, verdict.entry)
          return `Extracted text from ${path.basename(filePath)}:\n\n${text}`
        }

        if (kind === 'binary') {
          const stats = await fs.stat(filePath)
          return `[Unsupported binary file: ${filePath} (${classification.mediaType ?? 'unknown media type'}, ${stats.size} bytes).]`
        }

        // 文本 → 用有界输出读取。
        const verdict = await checkReadCache(cache, filePath, isRangeRead)
        if (verdict && verdict.hit) return verdict.stub
        const { text, complete } = await readTextResult(
          filePath,
          offset,
          limit,
          abortSignal,
          classification.textEncoding ?? 'utf-8',
        )
        if (verdict && !verdict.hit && complete) cache?.set(filePath, verdict.entry)
        return text
      } catch (err) {
        return formatToolError('reading file', err)
      }
    },
  })
}

/** 默认、无缓存的 readFile（供静态注册表导出和任何直接导入方使用）。
 *  buildTools 会用带缓存实例覆盖它。 */
export const readFile = createReadFileTool()
