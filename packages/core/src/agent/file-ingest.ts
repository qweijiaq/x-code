// @x-code-cli/core — 附件文件到消息的管道
//
// 给定一条引用了文件的原始用户提示词（通过 `@path` 或裸绝对路径），
// 把每个引用解析成 AI-SDK 的 content part：
//
//   text / code  → 带文件正文的 TextPart
//   PDF          → 按页排序的本地文本和标准页面图片
//   docx/xlsx/pptx → 通过有界的格式专用解析器产生的 TextPart
//   image        → 给具备视觉能力的模型用的 image FilePart；否则本地 OCR
//
// PDF、音频、Office 和未知二进制源字节永不离开本地处理管道。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, TextPart } from 'ai'

import type { ProviderCapabilities } from '../providers/capabilities.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImage,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import type { ReadFileCache } from '../tools/read-file.js'
import { errorMessage, truncateUtf8 } from '../utils.js'
import { FileSizeLimitError, readFileWithinLimit } from '../utils/bounded-read.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  MAX_IMAGE_SOURCE_BYTES,
  buildCompressionCaption,
  buildImageProcessingFailureNotice,
  compressImage,
  formatBytes,
} from '../utils/image-compress.js'
import { formatTranscription, transcribeAudio } from './audio-transcribe.js'
import { classifyFile, decodeTextBuffer, inspectFile, inspectFileBuffer } from './file-classifier.js'
import type { FileKind, InspectedFileKind } from './file-classifier.js'
import { MAX_INGEST_BYTES } from './file-ingest-limits.js'
import { ocrImage } from './image-ocr.js'
import {
  BUILT_IN_MEDIA_ANALYSIS_NOTE,
  escapeMediaAttribute,
  openMediaTag,
  toUserContentParts,
  wrapLocalText,
} from './local-media.js'
import { MAX_NOTEBOOK_SOURCE_BYTES, renderNotebookFile } from './notebook-render.js'
import {
  MAX_OFFICE_ARCHIVE_ENTRIES,
  MAX_OFFICE_SOURCE_BYTES,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  detectOfficeKindFromArchive,
} from './office-archive.js'
import type { OfficeKind } from './office-archive.js'
import { parseXlsxInWorker } from './office-xlsx.js'
import { MAX_PDF_SOURCE_BYTES, formatPdfReference, processPdf } from './pdf-ingest.js'
import type { VisionUsageEvent } from './vision-fallback.js'

/** 从一个文件引用解析出的 content part。类型与 AI SDK 在用户消息
 *  `content` 数组中接受的一致，所以调用方可以把它们直接拼进
 *  UserModelMessage。 */
export type IngestedPart = TextPart | ImagePart | FilePart

export { classifyFile }
export type { FileKind }

/** 用户指向的路径，要么通过 `@file`，要么是裸绝对路径。 */
export interface FileReference {
  /** 来自用户输入的原始 token（用于回显 / UI）。 */
  raw: string
  /** 解析后的绝对路径。 */
  absolutePath: string
}

/** 单个内联文件在【被替换成帮助消息之前】最多能塞进用户消息的字节数。
 *  取 256 KB 以对齐 Claude Code 的 Read-tool 默认值——对典型配置和源文件
 *  够大，对多文件粘贴也小到不会撑爆 1M 上下文窗口。
 *
 *  没有这个上限的话，`@really-large-file.txt`（或像 `D:\novels\book.txt`
 *  这样的裸绝对路径）会静默地把整个文件塞进用户消息，因为
 *  `buildUserContent` 绕过了 readFile 工具每次调用的行守卫。模型根本没有
 *  机会反应——请求直接在 API 处以 `context_length_exceeded` 失败。有了这个
 *  上限，模型看到的是简短提示，可以改用带 offset/limit 的 readFile 或
 *  grep 来缩小范围。 */
export const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024
export const MAX_ATTACHMENT_MEDIA_PARTS = 10
export const MAX_ATTACHMENT_WIRE_BYTES = 21 * 1024 * 1024

export { MAX_INGEST_BYTES, MAX_IMAGE_SOURCE_BYTES, MAX_OFFICE_SOURCE_BYTES, MAX_PDF_SOURCE_BYTES }

/** 当附件太大无法内联时，展示给人类/模型的消息。对齐 Claude Code 的
 *  `MaxFileReadTokenExceededError` 消息，但加上了 sub-agent 逃生通道——
 *  对「总结整本小说」/「审查整份日志」这类请求，逐块的 readFile 迭代会
 *  很快烧掉父上下文（每个 tool_result 都会留在原地）。委派给 sub-agent
 *  则只把摘要留在父上下文里。 */
function tooLargeMessage(filePath: string, sizeBytes: number, cap: number = MAX_INGEST_BYTES): string {
  return (
    `[File ${filePath} is too large to inline (${formatBytes(sizeBytes)}, ` +
    `cap ${formatBytes(cap)}). ` +
    `Use the readFile tool with offset/limit to read specific portions, ` +
    `or grep to search for specific content. ` +
    `For whole-file analysis (summarization, full review), prefer delegating to ` +
    `a sub-agent via the task tool — each sub-agent reads in isolated context ` +
    `and returns only its conclusions, keeping the parent context lean.]`
  )
}

function checkedTextAttachment(filePath: string, text: string): IngestedPart[] {
  const outputBytes = Buffer.byteLength(text, 'utf-8')
  if (outputBytes > MAX_INGEST_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(filePath, outputBytes) }]
  }
  return [{ type: 'text', text }]
}

interface AttachmentUsage {
  mediaParts: number
  textBytes: number
  wireBytes: number
}

function measureAttachment(parts: IngestedPart[]): AttachmentUsage {
  return {
    mediaParts: parts.filter((part) => part.type === 'file' || part.type === 'image').length,
    textBytes: parts.reduce(
      (total, part) => total + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf-8') : 0),
      0,
    ),
    // 这是持久化/会话表示，因此包含 Base64 膨胀、JSON 转义、
    // 文件名和媒体类型元数据。
    wireBytes: Buffer.byteLength(JSON.stringify(parts), 'utf-8'),
  }
}

function attachmentBudgetReason(current: AttachmentUsage, added: AttachmentUsage): string | null {
  if (current.mediaParts + added.mediaParts > MAX_ATTACHMENT_MEDIA_PARTS) {
    return `${MAX_ATTACHMENT_MEDIA_PARTS}-media-part limit`
  }
  if (current.textBytes + added.textBytes > MAX_ATTACHMENT_TEXT_BYTES) {
    return `${formatBytes(MAX_ATTACHMENT_TEXT_BYTES)} cumulative text limit`
  }
  if (current.wireBytes + added.wireBytes > MAX_ATTACHMENT_WIRE_BYTES) {
    return `${formatBytes(MAX_ATTACHMENT_WIRE_BYTES)} serialized attachment limit`
  }
  return null
}

function addUsage(current: AttachmentUsage, added: AttachmentUsage): void {
  current.mediaParts += added.mediaParts
  current.textBytes += added.textBytes
  current.wireBytes += added.wireBytes
}

/**
 * 从用户提示词中提取纯文本引用。识别两种语法：
 *
 *   1. `@path` —— `@` 前缀标记显式附件。含空白的路径可用单引号或双引号
 *      包裹。认可 Windows（`D:\foo\bar`）和 POSIX（`/etc/foo`）绝对路径。
 *
 *   2. 裸绝对路径 —— 形如 `C:\…`、`D:\…`，或以 `/` 开头、带扩展名的单个
 *      非空白 token。含空白的路径必须加引号。这能把散文、路由、正则和 SQL
 *      挡在错误的文件引用之外。
 *
 * 重复项按绝对路径去重，所以被引用两次的文件只会被摄取一次。
 */
function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r'
}

function isReferenceBoundary(input: string, index: number): boolean {
  return index === 0 || isWhitespace(input[index - 1] ?? '')
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function resolveReferencePath(value: string): string {
  if (isWindowsAbsolute(value)) return path.win32.normalize(value)
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(value)
}

function isBareAbsoluteFilePath(value: string): boolean {
  const absolute = isWindowsAbsolute(value) || value.startsWith('/')
  if (!absolute) return false
  const extension = (isWindowsAbsolute(value) ? path.win32 : path.posix).extname(value)
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension)
}

function readQuotedPath(input: string, quoteIndex: number): { end: number; value: string } | null {
  const quote = input[quoteIndex]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  for (let index = quoteIndex + 1; index < input.length; index++) {
    const current = input[index] ?? ''
    if (current === quote) return { end: index + 1, value }
    if (current === '\\' && input[index + 1] === quote) {
      value += quote
      index++
    } else {
      value += current
    }
  }
  return null
}

export function extractFileReferences(input: string): FileReference[] {
  const refs = new Map<string, FileReference>()

  const addReference = (value: string, raw: string): void => {
    if (!value || value.startsWith('@')) return
    const absolutePath = resolveReferencePath(value)
    refs.set(absolutePath, { raw, absolutePath })
  }

  // 显式提及可以用引号包裹含空白的路径。边界规则把邮箱地址和
  // 包版本说明符挡在外面。
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== '@' || !isReferenceBoundary(input, index)) continue
    const valueStart = index + 1
    const quoted = readQuotedPath(input, valueStart)
    if (quoted) {
      addReference(quoted.value, input.slice(index, quoted.end))
      index = quoted.end - 1
      continue
    }
    if (input[valueStart] === "'" || input[valueStart] === '"') continue
    let end = valueStart
    while (end < input.length && !isWhitespace(input[end] ?? '')) end++
    addReference(input.slice(valueStart, end), input.slice(index, end))
    index = Math.max(index, end - 1)
  }

  // 当 shell 把含空白的路径复制进提示词时，带引号的裸路径很常见。
  for (let index = 0; index < input.length; index++) {
    if (!isReferenceBoundary(input, index)) continue
    const quoted = readQuotedPath(input, index)
    if (!quoted) continue
    if (isBareAbsoluteFilePath(quoted.value)) addReference(quoted.value, input.slice(index, quoted.end))
    index = quoted.end - 1
  }

  // 每个 token 只扫描一次。除了避免在路由密集的提示词上出现正则回溯，
  // 这也刻意要求含空格的路径必须加引号。
  const trailingPunctuation = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}'])
  for (let start = 0; start < input.length; ) {
    while (start < input.length && isWhitespace(input[start] ?? '')) start++
    if (start >= input.length) break
    let end = start
    while (end < input.length && !isWhitespace(input[end] ?? '')) end++
    let candidateEnd = end
    while (candidateEnd > start && trailingPunctuation.has(input[candidateEnd - 1] ?? '')) candidateEnd--
    const raw = input.slice(start, candidateEnd)
    if (isBareAbsoluteFilePath(raw)) addReference(raw, raw)
    start = end
  }

  return [...refs.values()]
}

/** 把文件读成带行号的文本块——与 read-file 工具产出的格式一致，
 *  这样无论文件是提前内联还是按需获取，模型看到的表示都一致。 */
async function readTextFile(filePath: string, abortSignal?: AbortSignal): Promise<string> {
  const buffer = await readFileWithinLimit(filePath, MAX_INGEST_BYTES, abortSignal)
  const classification = await inspectFileBuffer(filePath, buffer, abortSignal)
  if (classification.kind !== 'text') {
    throw new Error('File content is not valid text')
  }
  const content = decodeTextBuffer(buffer, classification.textEncoding ?? 'utf-8')
  const lines = content.split('\n')
  return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, (entity) => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    if (entity === '&apos;') return "'"
    const hex = entity.startsWith('&#x')
    const value = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
  })
}

function officeXmlToText(xml: string): string {
  const parts: string[] = []
  let outputChars = 0
  let cursor = 0
  while (cursor < xml.length && outputChars < MAX_INGEST_BYTES) {
    const tagStart = xml.indexOf('<', cursor)
    const end = tagStart < 0 ? xml.length : tagStart
    if (end > cursor) {
      const text = decodeXmlText(xml.slice(cursor, end))
      parts.push(text)
      outputChars += text.length
    }
    if (tagStart < 0) break
    const tagEnd = xml.indexOf('>', tagStart + 1)
    if (tagEnd < 0) break
    const tag = xml
      .slice(tagStart + 1, Math.min(tagEnd, tagStart + 128))
      .trimStart()
      .toLowerCase()
    if (
      tag.startsWith('/a:p') ||
      tag.startsWith('/text:p') ||
      tag.startsWith('/text:h') ||
      tag.startsWith('/table:table-row') ||
      tag.startsWith('a:br')
    ) {
      parts.push('\n')
    } else if (tag.startsWith('/table:table-cell') || tag.startsWith('text:tab')) {
      parts.push('\t')
    } else if (tag.startsWith('text:line-break')) {
      parts.push('\n')
    }
    cursor = tagEnd + 1
  }
  const normalized = parts
    .join('')
    .replace(/[ \f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return truncateUtf8(normalized, MAX_INGEST_BYTES)
}

async function extractZippedOfficeText(archive: Buffer, kind: OfficeKind, abortSignal?: AbortSignal): Promise<string> {
  const { strFromU8, unzip } = await import('fflate')
  let entryCount = 0
  let uncompressedBytes = 0
  const wanted = (name: string): boolean =>
    kind === 'pptx' ? /^ppt\/slides\/slide\d+\.xml$/i.test(name) : name === 'content.xml'
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let settled = false
    let terminate = (): void => {}
    const finish = (error?: Error | null, result?: Record<string, Uint8Array>): void => {
      if (settled) return
      settled = true
      abortSignal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result ?? {})
    }
    const onAbort = (): void => {
      terminate()
      finish(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Office extraction aborted'))
    }
    terminate = unzip(
      archive,
      {
        filter: (entry) => {
          entryCount++
          if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
            throw new Error('Office archive exceeds the safe entry-count limit')
          }
          if (!wanted(entry.name)) return false
          uncompressedBytes += entry.originalSize
          if (uncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
            throw new Error('Office archive exceeds the safe decompression limit')
          }
          return true
        },
      },
      (error, result) => finish(error, result),
    )
    if (!settled) {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (abortSignal?.aborted) onAbort()
    }
  })
  const names = Object.keys(files).sort((left, right) => {
    const a = Number(/slide(\d+)\.xml$/i.exec(left)?.[1] ?? 0)
    const b = Number(/slide(\d+)\.xml$/i.exec(right)?.[1] ?? 0)
    return a - b || left.localeCompare(right)
  })
  const parts: string[] = []
  let outputBytes = 0
  for (const name of names) {
    abortSignal?.throwIfAborted()
    const text = officeXmlToText(strFromU8(files[name]!))
    if (!text) continue
    const prefix =
      kind === 'pptx' ? `--- Slide ${Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? parts.length + 1)} ---\n` : ''
    const available = MAX_INGEST_BYTES - outputBytes - Buffer.byteLength(prefix, 'utf8')
    if (available <= 0) break
    const bounded = truncateUtf8(text, available)
    parts.push(prefix + bounded)
    outputBytes += Buffer.byteLength(prefix + bounded, 'utf8')
  }
  return parts.join('\n\n')
}

export type OfficeExtractionResult = { ok: true; text: string } | { ok: false; text: string }

/** 用有界的格式专用解析器从 Office 文档提取文本。 */
export async function extractOfficeTextResult(
  filePath: string,
  abortSignal?: AbortSignal,
  detectedMediaType?: string | null,
): Promise<OfficeExtractionResult> {
  try {
    abortSignal?.throwIfAborted()
    const archive = await readFileWithinLimit(filePath, MAX_OFFICE_SOURCE_BYTES, abortSignal)
    const kind = await detectOfficeKindFromArchive(archive, abortSignal)
    void detectedMediaType
    if (!kind) {
      return {
        ok: false,
        text: `[Failed to extract text from ${path.basename(filePath)}: unknown Office document type]`,
      }
    }
    if (kind === 'docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: archive })
      return { ok: true, text: result.value }
    }
    if (kind === 'xlsx') {
      return { ok: true, text: await parseXlsxInWorker(archive, abortSignal) }
    }
    return { ok: true, text: await extractZippedOfficeText(archive, kind, abortSignal) }
  } catch (err) {
    if (err instanceof FileSizeLimitError) {
      return {
        ok: false,
        text: `[Office file is too large to parse safely: ${formatBytes(err.observedBytes)} (cap ${formatBytes(err.limitBytes)}).]`,
      }
    }
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return { ok: false, text: `[Failed to extract text from ${path.basename(filePath)}: ${msg}]` }
  }
}

export async function extractOfficeText(
  filePath: string,
  abortSignal?: AbortSignal,
  detectedMediaType?: string | null,
): Promise<string> {
  return (await extractOfficeTextResult(filePath, abortSignal, detectedMediaType)).text
}

/**
 * 把一个文件引用解析成一个或多个 content part，并考虑当前提供商
 * 的多模态能力。
 *
 * 契约：
 *  - 文本、Office 和带文本的 PDF 总是坍缩成单个 TextPart ——
 *    最便宜的路径，适用于所有提供商。
 *  - 图片：若提供商能看图片，则为仅图片的 FilePart；否则返回
 *    标注为回退的 OCR 文本 TextPart。
 *  - 扫描/纯视觉 PDF 页：给当前视觉模型的是一张张标准图片，
 *    否则做本地 OCR。
 *  - 缺失/不可读的文件返回一个携带错误的 TextPart，好让模型
 *    能确认失败，而不是静默忽略它。
 */
export async function ingestFile(
  ref: FileReference,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
  abortSignal?: AbortSignal,
  onVisionUsage?: (event: VisionUsageEvent) => void,
  modelId?: string,
): Promise<IngestedPart[]> {
  void onVisionUsage
  if (abortSignal?.aborted) {
    return [{ type: 'text', text: `[File ingest cancelled: ${ref.raw}]` }]
  }

  let kind: InspectedFileKind
  let mediaType: string | null
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(ref.absolutePath)
    const classification = await inspectFile(ref.absolutePath, abortSignal)
    kind = classification.kind
    mediaType = classification.mediaType
  } catch (err) {
    if (abortSignal?.aborted) return [{ type: 'text', text: `[File ingest cancelled: ${ref.raw}]` }]
    const msg = errorMessage(err)
    return [{ type: 'text', text: `[Cannot read ${ref.raw}: ${msg}]` }]
  }

  if (kind === 'office' && stats.size > MAX_OFFICE_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_OFFICE_SOURCE_BYTES) }]
  }
  if (kind === 'pdf' && stats.size > MAX_PDF_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_PDF_SOURCE_BYTES) }]
  }
  if (kind === 'image' && stats.size > MAX_IMAGE_SOURCE_BYTES) {
    return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_IMAGE_SOURCE_BYTES) }]
  }

  if (kind === 'binary') {
    return [
      {
        type: 'text',
        text: `[Unsupported binary file: ${ref.absolutePath} (${mediaType ?? 'unknown media type'}, ${formatBytes(stats.size)}).]`,
      },
    ]
  }

  if (kind === 'notebook') {
    if (stats.size > MAX_NOTEBOOK_SOURCE_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size, MAX_NOTEBOOK_SOURCE_BYTES) }]
    }
    try {
      const { text } = await renderNotebookFile(ref.absolutePath, abortSignal)
      return checkedTextAttachment(
        ref.absolutePath,
        wrapLocalText('file', text, { kind: 'notebook', path: ref.absolutePath }),
      )
    } catch (err) {
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${errorMessage(err)}]` }]
    }
  }

  if (kind === 'text') {
    // 源文件大小只是廉价的预检。行号、UTF 转换和源文件包装会在结果
    // 被接纳之前再次测量。
    if (stats.size > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, stats.size) }]
    }
    try {
      const body = await readTextFile(ref.absolutePath, abortSignal)
      return checkedTextAttachment(ref.absolutePath, wrapLocalText('file', body, { path: ref.absolutePath }))
    } catch (err) {
      const msg = errorMessage(err)
      return [{ type: 'text', text: `[Failed to read ${ref.raw}: ${msg}]` }]
    }
  }

  if (kind === 'office') {
    const extraction = await extractOfficeTextResult(ref.absolutePath, abortSignal, mediaType)
    if (!extraction.ok) return [{ type: 'text', text: extraction.text }]
    const { text } = extraction
    // Office 二进制通常比提取出的文本大得多（压缩 + 媒体），所以在提取后
    // 检查。一本长篇的 .docx 仍可能超过上限。
    const textBytes = Buffer.byteLength(text, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      wrapLocalText('file', text, { kind: 'office', path: ref.absolutePath }),
    )
  }

  if (kind === 'pdf') {
    const result = await processPdf(ref.absolutePath, {
      vision: caps.image,
      mode: 'auto',
      maxTextBytes: MAX_INGEST_BYTES - 8 * 1024,
      abortSignal,
      onNotice,
    })
    if (result.type === 'error') return [{ type: 'text', text: `[PDF processing failed: ${result.message}]` }]
    if (result.type === 'reference') return [{ type: 'text', text: formatPdfReference(result) }]
    const parts = toUserContentParts(result.parts)
    if (result.continuation) parts.push({ type: 'text', text: formatPdfReference(result.continuation) })
    parts.push({ type: 'text', text: BUILT_IN_MEDIA_ANALYSIS_NOTE })
    const totalTextBytes = parts.reduce(
      (total, part) => total + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf-8') : 0),
      0,
    )
    if (totalTextBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, totalTextBytes) }]
    }
    return parts
  }

  // 音频始终留在本地：无论提供商的线上能力如何，进入模型消息的只有
  // 带时间戳的转录文本。
  if (kind === 'audio') {
    // 把重复的原生提示挡在 UI 之外，又不丢弃变化的下载/转录百分比。
    // CLI 在单行实时状态行里渲染这些提示，所以转发进度不会淹没历史。
    let lastNotice = ''
    const deduplicatedNotice = onNotice
      ? (msg: string) => {
          if (msg === lastNotice) return
          lastNotice = msg
          onNotice(msg)
        }
      : undefined
    const result = await transcribeAudio(ref.absolutePath, { abortSignal, onNotice: deduplicatedNotice })
    if (typeof result === 'string') {
      return [{ type: 'text', text: result }]
    }
    const formatted = formatTranscription(result, ref.absolutePath)
    const textBytes = Buffer.byteLength(formatted, 'utf-8')
    if (textBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, textBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      `${wrapLocalText('file', formatted, { kind: 'audio-transcription', path: ref.absolutePath })}\n` +
        `[Note: this audio was transcribed locally via whisper.cpp. ` +
        `Only the timestamped text is visible; pauses, tone, and speaker identity are not captured.]\n` +
        BUILT_IN_MEDIA_ANALYSIS_NOTE,
    )
  }

  // 图片字节在送模型或 OCR 之前先归一化。这是针对伪装格式、解压炸弹
  // 和提供商拒绝的 BMP/TIFF 负载的共享安全闸门。
  try {
    const buffer = await readFileWithinLimit(ref.absolutePath, MAX_IMAGE_SOURCE_BYTES, abortSignal)
    const effectiveMime = (await sniffImageMime(buffer)) ?? mediaType ?? 'application/octet-stream'
    const compressed = await compressImage(buffer, effectiveMime, {
      byteBudget: ATTACH_BYTE_BUDGET,
      abortSignal,
    })
    const finalMime = normalizeImageMime(compressed.mimeType)
    if (caps.image && !isModelAcceptedImage(finalMime, { modelId, animated: compressed.animated })) {
      return [
        {
          type: 'text',
          text: buildUnsupportedImageNotice(finalMime, ref.absolutePath, modelId, compressed.animated),
        },
      ]
    }
    if (
      compressed.failureReason ||
      compressed.data.length > ATTACH_BYTE_BUDGET ||
      compressed.width > MAX_EDGE_PX ||
      compressed.height > MAX_EDGE_PX
    ) {
      return [{ type: 'text', text: buildImageProcessingFailureNotice(ref.absolutePath, compressed) }]
    }

    if (caps.image) {
      const extension = finalMime === 'image/jpeg' ? 'jpg' : finalMime.slice('image/'.length)
      const originalName = path.parse(ref.absolutePath).name
      const parts: IngestedPart[] = [
        { type: 'text', text: openMediaTag('file', { kind: 'image', path: ref.absolutePath }) },
        {
          type: 'file',
          data: { type: 'data', data: compressed.data.toString('base64') },
          mediaType: finalMime,
          filename: `${originalName}.${extension}`,
        },
      ]
      if (compressed.changed) {
        parts.push({ type: 'text', text: buildCompressionCaption(compressed) })
        onNotice?.(`Normalized image: ${formatBytes(buffer.length)} → ${formatBytes(compressed.data.length)}`)
      }
      parts.push({ type: 'text', text: BUILT_IN_MEDIA_ANALYSIS_NOTE })
      return parts
    }

    // 纯文本提供商接收本地 OCR。没有显式的产品级 opt-in，文件不会被
    // 转发给另一个已配置的提供商。
    const ocr = await ocrImage(compressed.data, { abortSignal })
    const ocrBytes = Buffer.byteLength(ocr, 'utf-8')
    if (ocrBytes > MAX_INGEST_BYTES) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, ocrBytes) }]
    }
    return checkedTextAttachment(
      ref.absolutePath,
      `${wrapLocalText('file', ocr, { kind: 'image-ocr', path: ref.absolutePath })}\n[Note: the current model cannot natively see images. Only OCR text is available; visual content (layout, diagrams, photos) is NOT visible.]`,
    )
  } catch (err) {
    if (err instanceof FileSizeLimitError) {
      return [{ type: 'text', text: tooLargeMessage(ref.absolutePath, err.observedBytes, err.limitBytes) }]
    }
    abortSignal?.throwIfAborted()
    const msg = errorMessage(err)
    return [{ type: 'text', text: `[Failed to attach image ${ref.raw}: ${msg}]` }]
  }
}

/**
 * 组装用户消息的 content parts：先是原文，然后每个已摄取文件一个或多个
 * part。当没有引用任何文件时返回纯字符串，让简单提示词保持在字符串
 * 快路径上（保持现有提供商行为 / 缓存语义不变）。
 */
export async function buildUserContent(
  text: string,
  caps: ProviderCapabilities,
  onNotice?: (msg: string) => void,
  abortSignal?: AbortSignal,
  onVisionUsage?: (event: VisionUsageEvent) => void,
  modelId?: string,
  readFileCache?: ReadFileCache,
): Promise<string | IngestedPart[]> {
  const refs = extractFileReferences(text)
  if (refs.length === 0) return text

  const parts: IngestedPart[] = [{ type: 'text', text }]
  const usage: AttachmentUsage = { mediaParts: 0, textBytes: 0, wireBytes: 0 }
  for (const ref of refs) {
    if (abortSignal?.aborted) break
    const ingested = await ingestFile(ref, caps, onNotice, abortSignal, onVisionUsage, modelId)
    const added = measureAttachment(ingested)
    const reason = attachmentBudgetReason(usage, added)
    if (reason) {
      const notice: IngestedPart[] = [
        { type: 'text', text: `[Attachment ${ref.raw} omitted: cumulative attachment budget exceeded (${reason}).]` },
      ]
      const noticeUsage = measureAttachment(notice)
      if (!attachmentBudgetReason(usage, noticeUsage)) {
        parts.push(...notice)
        addUsage(usage, noticeUsage)
      }
      continue
    }
    parts.push(...ingested)
    addUsage(usage, added)
    await rememberCompleteAttachment(readFileCache, ref.absolutePath, ingested)
  }
  return parts
}

function hasCompleteLocalFile(parts: IngestedPart[], filePath: string): boolean {
  const pathAttribute = `path="${escapeMediaAttribute(filePath)}"`
  return parts.some((part) => {
    if (part.type !== 'text' || !part.text.startsWith('<<file ')) return false
    const openingEnd = part.text.indexOf('>>')
    if (openingEnd === -1 || !part.text.slice(0, openingEnd).includes(pathAttribute)) return false
    if (part.text.indexOf('<</file>>', openingEnd + 2) !== -1) return true
    return (
      part.text.slice(0, openingEnd).includes('kind="image"') &&
      parts.some((candidate) => candidate.type === 'file' && candidate.mediaType.startsWith('image/'))
    )
  })
}

async function rememberCompleteAttachment(
  cache: ReadFileCache | undefined,
  filePath: string,
  parts: IngestedPart[],
): Promise<void> {
  if (!cache || !hasCompleteLocalFile(parts, filePath)) return
  const stats = await fs.stat(filePath).catch(() => null)
  if (stats) cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size })
}
