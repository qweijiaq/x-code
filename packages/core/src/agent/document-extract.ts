// @x-code-cli/core — readDocument 工具的确定性文档/媒体提取。
// 每种受支持的格式都在本地解析；不会有文档字节被发送给模型。
// 文本有上限，避免一本大书灌满上下文窗口。
import * as cheerio from 'cheerio'
import { unzipSync } from 'fflate'

import { execFile } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { errorMessage } from '../utils.js'
import { formatBytes } from '../utils/image-compress.js'
import { formatTranscription, transcribeAudio } from './audio-transcribe.js'
import { inspectFile } from './file-classifier.js'
import { extractOfficeTextResult } from './file-ingest.js'
import { ocrImage } from './image-ocr.js'
import { processPdf } from './pdf-ingest.js'
import { configurePdfWorker } from './pdf-worker-config.js'

const execFileAsync = promisify(execFile)

const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const MAX_TEXT_SOURCE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_CHARS = 50_000
const HARD_MAX_CHARS = 200_000
const MAX_CSV_ROWS = 500
const MAX_CSV_COLUMNS = 50
const MAX_EPUB_CHAPTERS = 300
const MAX_PDF_PAGES = 200
/** 扫描版 PDF 回退：渲染没有文本层的页面并在本地 OCR。
 *  有上限是因为每页都要花数秒 CPU，且 token 恒为零但
 *  墙钟时间并非如此。 */
const MAX_PDF_OCR_PAGES = 10
const MAX_PDF_OCR_PAGES_PER_CALL = 4
const MAX_VIDEO_FRAMES = 10

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.mdx', '.rst', '.log'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])
const EPUB_EXTENSION = '.epub'
const MOBI_EXTENSIONS = new Set(['.mobi', '.azw', '.azw3'])

export interface DocumentReadOptions {
  maxChars?: number
  /** PDF 页码范围，如 "1-5,8"。 */
  pages?: string
  /** 设为 false 可跳过对无文本层 PDF 页面的本地 OCR。 */
  ocr?: boolean
  /** 设为 false 可跳过本地音频转录。 */
  transcribe?: boolean
  /** 最多提取这么多视频帧到临时文件（需要 ffmpeg）。 */
  extractFrames?: number
  abortSignal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface DocumentReadResult {
  path: string
  format: string
  metadata: Record<string, string | number>
  text: string
  truncated: boolean
  notes: string[]
}

function clampMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CHARS
  return Math.max(1_000, Math.min(HARD_MAX_CHARS, Math.floor(value!)))
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

async function readTextFile(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_TEXT_SOURCE_BYTES) {
    throw new Error(`Text file is too large (${formatBytes(stat.size)}; cap ${formatBytes(MAX_TEXT_SOURCE_BYTES)})`)
  }
  return decodeTextBuffer(await fs.readFile(filePath))
}

function htmlToText(html: string): string {
  if (!html.trim()) return ''
  const $ = cheerio.load(html)
  $('script,style,noscript,svg,head').remove()
  $('br').replaceWith('\n')
  $('p,div,section,article,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre').each((_, element) => {
    $(element).append('\n')
  })
  const body = $('body')
  const text = body.length > 0 ? body.text() : $.root().text()
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ─── CSV / TSV ──────────────────────────────────────────────────────────────

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function detectDelimiter(text: string, extension: string): string {
  if (extension === '.tsv') return '\t'
  const firstLine = text.slice(0, 4096).split('\n')[0] ?? ''
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

async function readDelimited(filePath: string, extension: string, maxChars: number): Promise<DocumentReadResult> {
  const text = await readTextFile(filePath)
  const delimiter = detectDelimiter(text, extension)
  const allRows = parseDelimited(text, delimiter)
  const notes: string[] = []
  const rows = allRows.slice(0, MAX_CSV_ROWS)
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  if (allRows.length > rows.length) notes.push(`Only the first ${rows.length} of ${allRows.length} rows are shown.`)
  if (columnCount > MAX_CSV_COLUMNS) notes.push(`Only the first ${MAX_CSV_COLUMNS} columns are shown.`)
  const clipped = rows.map((row) =>
    row
      .slice(0, MAX_CSV_COLUMNS)
      .map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' '))
      .join(' | '),
  )
  const formatted = clipped.join('\n')
  const truncated = truncateText(formatted, maxChars)
  return {
    path: filePath,
    format: extension === '.tsv' ? 'tsv' : 'csv',
    metadata: { rows: allRows.length, columns: columnCount, delimiter: delimiter === '\t' ? 'tab' : delimiter },
    text: truncated.text,
    truncated: truncated.truncated,
    notes,
  }
}

// ─── EPUB ───────────────────────────────────────────────────────────────────

function epubElementText($: cheerio.CheerioAPI, parentSelector: string, localName: string): string {
  let result = ''
  $(parentSelector)
    .find('*')
    .each((_, element) => {
      const tag = (element as { tagName?: string }).tagName ?? ''
      if (tag === localName || tag.endsWith(`:${localName}`)) {
        result = result || $(element).text().trim()
      }
    })
  return result
}

async function readEpub(filePath: string, maxChars: number): Promise<DocumentReadResult> {
  const buffer = await fs.readFile(filePath)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch (error) {
    throw new Error(`Invalid EPUB archive: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (files['META-INF/encryption.xml']) {
    throw new Error('EPUB is encrypted/DRM-protected; text extraction is not supported')
  }
  const container = files['META-INF/container.xml']
  if (!container) throw new Error('EPUB is missing META-INF/container.xml')

  const $container = cheerio.load(Buffer.from(container).toString('utf8'), { xmlMode: true })
  const opfPath = $container('rootfile').attr('full-path')
  if (!opfPath) throw new Error('EPUB container has no rootfile')
  const opf = files[opfPath]
  if (!opf) throw new Error(`EPUB OPF not found: ${opfPath}`)

  const $opf = cheerio.load(Buffer.from(opf).toString('utf8'), { xmlMode: true })
  const title = epubElementText($opf, 'metadata', 'title')
  const creator = epubElementText($opf, 'metadata', 'creator')
  const manifest = new Map<string, { href: string; mediaType: string }>()
  $opf('manifest')
    .find('item')
    .each((_, element) => {
      const id = $opf(element).attr('id')
      const href = $opf(element).attr('href')
      if (id && href) manifest.set(id, { href, mediaType: $opf(element).attr('media-type') ?? '' })
    })
  const spine: string[] = []
  $opf('spine')
    .find('itemref')
    .each((_, element) => {
      const idref = $opf(element).attr('idref')
      if (idref) spine.push(idref)
    })

  const opfDir = path.posix.dirname(opfPath)
  const chapters: string[] = []
  for (const idref of spine.slice(0, MAX_EPUB_CHAPTERS)) {
    const item = manifest.get(idref)
    if (!item) continue
    if (!/html|xhtml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue
    const rel = decodeURIComponent(item.href)
    const zipPath = opfDir === '.' ? rel : path.posix.normalize(path.posix.join(opfDir, rel))
    const content = files[zipPath]
    if (!content) continue
    const text = htmlToText(Buffer.from(content).toString('utf8'))
    if (text) chapters.push(text)
  }
  const body = chapters.join('\n\n')
  const truncated = truncateText(body, maxChars)
  const notes: string[] = []
  if (chapters.length === 0) notes.push('No extractable XHTML chapters were found in the spine.')
  return {
    path: filePath,
    format: 'epub',
    metadata: {
      title: title || path.basename(filePath, EPUB_EXTENSION),
      author: creator,
      chapters: chapters.length,
    },
    text: truncated.text,
    truncated: truncated.truncated,
    notes,
  }
}

// ─── MOBI / PalmDOC ─────────────────────────────────────────────────────────

/** PalmDOC LZ77 解压缩。为测试而导出。 */
export function palmDocDecompress(input: Uint8Array): Uint8Array {
  const output: number[] = []
  let index = 0
  while (index < input.length) {
    const byte = input[index++]!
    if (byte === 0) {
      output.push(0)
      continue
    }
    if (byte <= 0x08) {
      for (let i = 0; i < byte; i++) output.push(input[index++] ?? 0)
      continue
    }
    if (byte <= 0x7f) {
      output.push(byte)
      continue
    }
    if (byte <= 0xbf) {
      const next = input[index++] ?? 0
      const pair = (byte << 8) | next
      const distance = (pair >> 3) & 0x7ff
      const length = (pair & 0x07) + 3
      const start = output.length - distance
      if (distance <= 0 || start < 0) continue
      for (let i = 0; i < length; i++) output.push(output[start + i] ?? 0)
      continue
    }
    // 0xC0-0xFF：一个空格后跟 (byte - 0xC0) 个字面字节。
    output.push(0x20)
    const count = byte - 0xc0
    for (let i = 0; i < count; i++) output.push(input[index++] ?? 0)
  }
  return Uint8Array.from(output)
}

function findMobiEncoding(record0: Buffer): 'utf8' | 'latin1' {
  // MOBI 头部从 16 字节 PalmDOC 头之后开始；文本编码在
  // record 0 起始处偏移 28 的位置（65001 = UTF-8，1252 = cp1252）。
  if (record0.length < 30) return 'utf8'
  try {
    return record0.readUInt32BE(28) === 65001 ? 'utf8' : 'latin1'
  } catch {
    return 'utf8'
  }
}

async function readMobi(filePath: string, maxChars: number): Promise<DocumentReadResult> {
  const buffer = await fs.readFile(filePath)
  if (buffer.length < 86) throw new Error('MOBI file is too small')
  const recordCount = buffer.readUInt16BE(76)
  if (recordCount < 2 || recordCount > 100_000) throw new Error('MOBI file has an invalid record table')
  const offsets: number[] = []
  for (let i = 0; i < recordCount; i++) {
    const offset = buffer.readUInt32BE(78 + i * 4)
    if (offset <= 0 || offset >= buffer.length) throw new Error('MOBI record offset is invalid')
    offsets.push(offset)
  }
  const recordEnd = (index: number): number => (index + 1 < offsets.length ? offsets[index + 1]! : buffer.length)
  const record0 = buffer.subarray(offsets[0]!, recordEnd(0))
  if (record0.length < 16) throw new Error('MOBI record 0 is truncated')
  const compression = record0.readUInt16BE(0)
  const textLength = record0.readUInt32BE(4)
  const textRecords = record0.readUInt16BE(8)
  const encryption = record0.readUInt16BE(12)
  if (encryption !== 0) throw new Error('MOBI/DRM encryption is not supported')
  if (compression !== 1 && compression !== 2) {
    throw new Error(`Unsupported MOBI compression ${compression} (HUFF/CDIC is not supported)`)
  }
  if (textRecords === 0 || textRecords >= recordCount) throw new Error('MOBI text record count is invalid')

  const chunks: Uint8Array[] = []
  for (let i = 1; i <= textRecords; i++) {
    const record = buffer.subarray(offsets[i]!, recordEnd(i))
    chunks.push(compression === 1 ? record : palmDocDecompress(record))
  }
  const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  const decoded = combined.subarray(0, Math.min(combined.length, textLength)).toString(findMobiEncoding(record0))
  const text = htmlToText(decoded)
  const truncated = truncateText(text, maxChars)
  const rawName = buffer.subarray(0, 32).toString('latin1').replace(/\0.*$/, '').trim()
  return {
    path: filePath,
    format: path.extname(filePath).slice(1).toLowerCase(),
    metadata: { title: rawName || path.basename(filePath), records: textRecords, compression },
    text: truncated.text,
    truncated: truncated.truncated,
    notes: [],
  }
}

// ─── 视频元数据 / 帧 ────────────────────────────────────────────────────────

interface Mp4Box {
  start: number
  end: number
}

function findBox(buffer: Buffer, start: number, end: number, type: string): Mp4Box | null {
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const boxType = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) return null
      size = Number(buffer.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) return null
    if (boxType === type) return { start: offset, end: offset + size }
    offset += size
  }
  return null
}

function mp4Metadata(buffer: Buffer): { durationSeconds?: number; width?: number; height?: number } {
  const moov = findBox(buffer, 0, buffer.length, 'moov')
  if (!moov) return {}
  const metadata: { durationSeconds?: number; width?: number; height?: number } = {}
  const mvhd = findBox(buffer, moov.start + 8, moov.end, 'mvhd')
  if (mvhd) {
    const version = buffer[mvhd.start + 8]
    try {
      const timescale = version === 1 ? buffer.readUInt32BE(mvhd.start + 28) : buffer.readUInt32BE(mvhd.start + 20)
      const duration =
        version === 1 ? Number(buffer.readBigUInt64BE(mvhd.start + 32)) : buffer.readUInt32BE(mvhd.start + 24)
      if (timescale > 0 && Number.isFinite(duration)) {
        metadata.durationSeconds = Math.round((duration / timescale) * 10) / 10
      }
    } catch {
      // 忽略格式损坏的 mvhd。
    }
  }
  let offset = moov.start + 8
  while (offset < moov.end) {
    const trak = findBox(buffer, offset, moov.end, 'trak')
    if (!trak) break
    const tkhd = findBox(buffer, trak.start + 8, trak.end, 'tkhd')
    if (tkhd) {
      const version = buffer[tkhd.start + 8]
      const widthOffset = version === 1 ? tkhd.start + 100 : tkhd.start + 84
      const heightOffset = version === 1 ? tkhd.start + 104 : tkhd.start + 88
      if (heightOffset + 4 <= tkhd.end) {
        const width = buffer.readUInt32BE(widthOffset) / 65536
        const height = buffer.readUInt32BE(heightOffset) / 65536
        if (width > 0 && height > 0) {
          metadata.width = Math.round(width)
          metadata.height = Math.round(height)
        }
      }
    }
    offset = trak.end
  }
  return metadata
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

async function extractVideoFrames(filePath: string, count: number, durationSeconds?: number): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-video-frames-'))
  const times =
    durationSeconds && durationSeconds > 0
      ? Array.from({ length: count }, (_, index) => Math.max(0, (durationSeconds * (index + 0.5)) / count))
      : [1]
  const paths: string[] = []
  for (let index = 0; index < times.length; index++) {
    const output = path.join(dir, `frame-${index + 1}.png`)
    await execFileAsync(
      'ffmpeg',
      ['-y', '-ss', String(times[index]), '-i', filePath, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', output],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    )
    if (fsSync.existsSync(output)) paths.push(output)
  }
  return paths
}

async function readVideo(
  filePath: string,
  extension: string,
  options: DocumentReadOptions,
): Promise<DocumentReadResult> {
  const stat = await fs.stat(filePath)
  const buffer = await fs.readFile(filePath)
  const metadata: Record<string, string | number> = { size: formatBytes(stat.size) }
  if (['.mp4', '.m4v', '.mov'].includes(extension)) {
    const parsed = mp4Metadata(buffer)
    if (parsed.durationSeconds !== undefined) metadata.durationSeconds = parsed.durationSeconds
    if (parsed.width && parsed.height) metadata.resolution = `${parsed.width}x${parsed.height}`
  }
  const notes: string[] = []
  const frameCount = Math.min(MAX_VIDEO_FRAMES, Math.max(0, options.extractFrames ?? 0))
  if (frameCount > 0) {
    if (await ffmpegAvailable()) {
      try {
        const frames = await extractVideoFrames(filePath, frameCount, metadata.durationSeconds as number | undefined)
        if (frames.length > 0) {
          metadata.frames = frames.length
          notes.push(`Extracted frames:\n${frames.map((frame) => `- ${frame}`).join('\n')}`)
        } else {
          notes.push('ffmpeg produced no frames.')
        }
      } catch (error) {
        notes.push(`Frame extraction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      notes.push('ffmpeg is not available; install it to extract frames.')
    }
  } else {
    notes.push('Set extractFrames to extract still frames to temp files (requires ffmpeg).')
  }
  return {
    path: filePath,
    format: extension.slice(1),
    metadata,
    text: `Video file: ${path.basename(filePath)}${metadata.durationSeconds ? ` (${metadata.durationSeconds}s)` : ''}`,
    truncated: false,
    notes,
  }
}

// ─── PDF ────────────────────────────────────────────────────────────────────

async function ensurePdfGlobals(): Promise<void> {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix !== 'undefined') return
  try {
    const canvas = (await import('@napi-rs/canvas')) as unknown as {
      DOMMatrix?: unknown
      default?: { DOMMatrix?: unknown }
    }
    const DomMatrix = canvas.DOMMatrix ?? canvas.default?.DOMMatrix
    if (DomMatrix) (globalThis as { DOMMatrix?: unknown }).DOMMatrix = DomMatrix
  } catch {
    // 在纯 Node 进程中，pdfjs 可能仍会自行 polyfill。
  }
}

function parsePageRange(spec: string | undefined, totalPages: number): number[] {
  const limit = Math.min(totalPages, MAX_PDF_PAGES)
  if (!spec?.trim()) return Array.from({ length: limit }, (_, index) => index + 1)
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Math.max(1, Number(range[1]))
      const end = Math.min(limit, Number(range[2]))
      for (let page = start; page <= end; page++) pages.add(page)
    } else if (/^\d+$/.test(trimmed)) {
      const page = Number(trimmed)
      if (page >= 1 && page <= limit) pages.add(page)
    }
  }
  return [...pages].sort((a, b) => a - b)
}

async function readPdf(filePath: string, options: DocumentReadOptions, maxChars: number): Promise<DocumentReadResult> {
  await ensurePdfGlobals()
  const buffer = await fs.readFile(filePath)
  const { PDFParse } = await import('pdf-parse')
  configurePdfWorker(PDFParse)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const info = await parser.getInfo()
    const totalPages = info.total ?? 0
    const pages = parsePageRange(options.pages, totalPages)
    const result = await parser.getText({ partial: pages, pageJoiner: '' })
    const textByPage = new Map<number, string>()
    for (const page of result.pages) textByPage.set(page.num, page.text.trim())

    const notes: string[] = []
    let ocrPages = 0
    const sparse = pages.filter((pageNumber) => nonSpaceLength(textByPage.get(pageNumber) ?? '') < 40)
    if (options.ocr !== false) {
      const targets = sparse.slice(0, MAX_PDF_OCR_PAGES)
      for (const run of pdfOcrRuns(targets)) {
        options.abortSignal?.throwIfAborted()
        options.onProgress?.(`Local OCR for PDF pages ${run.first}-${run.last} (no text layer)`)
        const processed = await processPdf(filePath, {
          pageRange: run,
          mode: 'visual',
          vision: false,
          abortSignal: options.abortSignal,
          onNotice: (message) => options.onProgress?.(message),
        }).catch((error: unknown) => ({
          type: 'error' as const,
          code: 'render-failed' as const,
          message: errorMessage(error),
        }))
        if (processed.type !== 'content') {
          if (processed.type === 'error') {
            notes.push(`Local OCR failed for PDF pages ${run.first}-${run.last}: ${processed.message}`)
          } else {
            notes.push(`Local OCR stopped at PDF page ${run.first}: ${processed.reason}.`)
          }
          continue
        }
        for (const part of processed.parts) {
          if (part.type !== 'text') continue
          const match = /^--- PDF page (\d+) of \d+: .*\(local OCR\) ---\n([\s\S]*)$/.exec(part.text)
          if (!match) continue
          const ocrText = match[2]!.trim()
          if (!ocrText) continue
          textByPage.set(Number(match[1]), ocrText)
          ocrPages++
        }
      }
      if (ocrPages > 0) notes.push(`Applied local OCR to ${ocrPages} page(s) without a usable text layer.`)
      if (sparse.length > targets.length) {
        notes.push(
          `OCR was limited to ${MAX_PDF_OCR_PAGES} pages; ${sparse.length - targets.length} more page(s) were not recognized. Pass pages to focus the range.`,
        )
      }
    } else if (sparse.length > 0) {
      notes.push(
        `OCR skipped for ${sparse.length} page(s) without a usable text layer; call again without ocr:false to run local OCR.`,
      )
    }

    const text = pages
      .map((pageNumber) => `--- Page ${pageNumber} ---\n${(textByPage.get(pageNumber) ?? '').trim()}`)
      .join('\n\n')
      .trim()
    const truncated = truncateText(text, maxChars)
    const meaningful = nonSpaceLength(text)
    if (meaningful < 40) {
      notes.push(
        options.ocr === false
          ? 'This PDF has little or no extractable text; it may be a scanned document.'
          : 'This PDF has little or no extractable text, and local OCR produced nothing usable; it may be image-only or encrypted.',
      )
    }
    if (totalPages > MAX_PDF_PAGES && !options.pages) {
      notes.push(`Only the first ${MAX_PDF_PAGES} of ${totalPages} pages were read.`)
    }
    return {
      path: filePath,
      format: 'pdf',
      metadata: { pages: totalPages, readPages: pages.length, ocrPages },
      text: truncated.text,
      truncated: truncated.truncated,
      notes,
    }
  } finally {
    await parser.destroy().catch(() => {})
  }
}

function nonSpaceLength(text: string): number {
  return text.replace(/\s/g, '').length
}

/** 把排好序的页码分组为连续区间，每组最多
 *  MAX_PDF_OCR_PAGES_PER_CALL 页。每次 processPdf 调用都会重新渲染并
 *  重新解析文件，且有自己 120s 的预算，因此非常宽的区间会被拆分，
 *  而不是冒着单次超时的风险。 */
export function pdfOcrRuns(pages: number[]): Array<{ first: number; last: number }> {
  const runs: Array<{ first: number; last: number }> = []
  for (let index = 0; index < pages.length; index++) {
    const first = pages[index]!
    let last = first
    while (index + 1 < pages.length && pages[index + 1] === last + 1 && last - first + 1 < MAX_PDF_OCR_PAGES_PER_CALL) {
      last = pages[++index]!
    }
    runs.push({ first, last })
  }
  return runs
}

// ─── 图片 / 音频 / Office ───────────────────────────────────────────────────

async function readImage(
  filePath: string,
  options: DocumentReadOptions,
  maxChars: number,
): Promise<DocumentReadResult> {
  const metadata: Record<string, string | number> = {}
  let ocrInput: string | Buffer = filePath
  try {
    const canvas = (await import('@napi-rs/canvas')) as unknown as {
      loadImage: (input: string) => Promise<{ width: number; height: number }>
      createCanvas: (
        width: number,
        height: number,
      ) => {
        getContext: (kind: '2d') => {
          drawImage: (image: unknown, dx: number, dy: number, dw: number, dh: number) => void
        }
        encode: (format: 'png') => Promise<Buffer>
      }
    }
    const image = await canvas.loadImage(filePath)
    metadata.width = image.width
    metadata.height = image.height

    // OCR 成本随像素数增长；一张 8192x4608 的照片可能要好几分钟。
    // 对 OCR 副本降采样，同时把原始尺寸保留在元数据里。
    const maxEdge = 1_800
    const longest = Math.max(image.width, image.height)
    if (longest > maxEdge) {
      const scale = maxEdge / longest
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      const resized = canvas.createCanvas(width, height)
      resized.getContext('2d').drawImage(image, 0, 0, width, height)
      ocrInput = await resized.encode('png')
      metadata.ocrSize = `${width}x${height}`
      options.onProgress?.(`Downscaled image to ${width}x${height} for OCR`)
    }
  } catch {
    // 尺寸与降采样都是尽力而为；OCR 仍可使用该文件。
  }
  options.onProgress?.('Running local OCR on image…')
  const ocr = await ocrImage(ocrInput, { abortSignal: options.abortSignal })
  const text = ocr.trim()
  const truncated = truncateText(text, maxChars)
  return {
    path: filePath,
    format: path.extname(filePath).slice(1).toLowerCase(),
    metadata,
    text: truncated.text || '(no text recognized by local OCR)',
    truncated: truncated.truncated,
    notes: text
      ? [
          'OCR is local and may miss layout, diagrams, or photos.',
          'For visual understanding, call readFile with the same path; vision-capable models receive the image itself.',
        ]
      : ['No text was recognized. If the model supports vision, call readFile with the same path to view the image.'],
  }
}

async function readAudio(
  filePath: string,
  options: DocumentReadOptions,
  maxChars: number,
): Promise<DocumentReadResult> {
  const stat = await fs.stat(filePath)
  const metadata: Record<string, string | number> = { size: formatBytes(stat.size) }
  if (options.transcribe === false) {
    return {
      path: filePath,
      format: path.extname(filePath).slice(1).toLowerCase(),
      metadata,
      text: 'Audio transcription was skipped (transcribe:false).',
      truncated: false,
      notes: ['Set transcribe to true to run local whisper.cpp transcription.'],
    }
  }
  options.onProgress?.('Transcribing audio locally (whisper.cpp)…')
  const result = await transcribeAudio(filePath, {
    abortSignal: options.abortSignal,
    onNotice: (message) => options.onProgress?.(message),
  })
  if (typeof result === 'string') {
    return {
      path: filePath,
      format: path.extname(filePath).slice(1).toLowerCase(),
      metadata,
      text: result,
      truncated: false,
      notes: [],
    }
  }
  if (result.language) metadata.language = result.language
  const formatted = formatTranscription(result, filePath)
  const truncated = truncateText(formatted, maxChars)
  return {
    path: filePath,
    format: path.extname(filePath).slice(1).toLowerCase(),
    metadata,
    text: truncated.text,
    truncated: truncated.truncated,
    notes: ['Transcription runs locally via whisper.cpp; model download may be required on first use.'],
  }
}

async function readOffice(
  filePath: string,
  options: DocumentReadOptions,
  maxChars: number,
): Promise<DocumentReadResult> {
  const stat = await fs.stat(filePath)
  const result = await extractOfficeTextResult(filePath, options.abortSignal)
  const truncated = truncateText(result.text, maxChars)
  return {
    path: filePath,
    format: path.extname(filePath).slice(1).toLowerCase(),
    metadata: { size: formatBytes(stat.size) },
    text: truncated.text,
    truncated: truncated.truncated,
    notes: result.ok ? [] : ['Office extraction failed; the text above contains the parser error.'],
  }
}

// ─── 入口点 ────────────────────────────────────────────────────────────────

export async function readDocument(filePath: string, options: DocumentReadOptions = {}): Promise<DocumentReadResult> {
  const resolved = path.resolve(filePath)
  const stat = await fs.stat(resolved)
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`)
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new Error(`File is too large (${formatBytes(stat.size)}; cap ${formatBytes(MAX_SOURCE_BYTES)})`)
  }
  const maxChars = clampMaxChars(options.maxChars)
  const extension = path.extname(resolved).toLowerCase()
  options.abortSignal?.throwIfAborted()

  if (OFFICE_EXTENSIONS.has(extension)) return readOffice(resolved, options, maxChars)
  if (extension === '.pdf') return readPdf(resolved, options, maxChars)
  if (extension === EPUB_EXTENSION) return readEpub(resolved, maxChars)
  if (MOBI_EXTENSIONS.has(extension)) return readMobi(resolved, maxChars)
  if (extension === '.csv' || extension === '.tsv') return readDelimited(resolved, extension, maxChars)
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = await readTextFile(resolved)
    const truncated = truncateText(text, maxChars)
    return {
      path: resolved,
      format: extension.slice(1),
      metadata: { characters: text.length },
      text: truncated.text,
      truncated: truncated.truncated,
      notes: [],
    }
  }
  if (IMAGE_EXTENSIONS.has(extension)) return readImage(resolved, options, maxChars)
  if (AUDIO_EXTENSIONS.has(extension)) return readAudio(resolved, options, maxChars)
  if (VIDEO_EXTENSIONS.has(extension)) return readVideo(resolved, extension, options)

  const classification = await inspectFile(resolved, options.abortSignal)
  if (classification.kind === 'image') return readImage(resolved, options, maxChars)
  if (classification.kind === 'audio') return readAudio(resolved, options, maxChars)
  if (classification.kind === 'pdf') return readPdf(resolved, options, maxChars)
  if (classification.kind === 'office') return readOffice(resolved, options, maxChars)
  if (classification.kind === 'text' || classification.kind === 'notebook') {
    const text = await readTextFile(resolved)
    const truncated = truncateText(text, maxChars)
    return {
      path: resolved,
      format: extension.slice(1) || 'text',
      metadata: { characters: text.length },
      text: truncated.text,
      truncated: truncated.truncated,
      notes: [],
    }
  }
  throw new Error(
    `Unsupported document format${extension ? ` (${extension})` : ''}. Supported: PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP, Markdown, CSV/TSV, EPUB, MOBI/AZW, images, audio, and video.`,
  )
}

export function formatDocumentResult(result: DocumentReadResult): string {
  const lines = [`Document: ${result.path}`, `Format: ${result.format}`]
  for (const [key, value] of Object.entries(result.metadata)) {
    if (value === '' || value === undefined) continue
    lines.push(`${key}: ${value}`)
  }
  for (const note of result.notes) lines.push(`Note: ${note}`)
  lines.push('', '--- content ---', result.text || '(no extractable text)')
  if (result.truncated)
    lines.push('', '[Content truncated. Request a larger maxChars or a narrower page range for more.]')
  return lines.join('\n')
}
