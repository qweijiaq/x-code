// 桌面文档预览：一个请求进来，一个有界视图出去。
//
// 文本来自 core 的 readDocument（本地解析/OCR）；PDF 通过 core 的
// pdf-render worker 分批渲染页面图片（默认 20 页），电子表格则用
// ExcelJS 解析为小的表格预览。用户逐页运行的 OCR 持久化在
// desktop-documents.json 中，并在下次打开时合并回来，直到用户清除。
import fs from 'node:fs/promises'
import path from 'node:path'

import { processPdf, readDocument } from '@x-code-cli/core'

import type { DocumentPageView, DocumentSheetView, DocumentTextPage, DocumentView } from '../shared/protocol.js'
import { ensureBaseline } from './document-review.js'
import { forgetOcr, recentDocuments, rememberDocument, saveOcrPage, storedOcr } from './document-store.js'

const MAX_TEXT_CHARS = 60_000
const MAX_PAGE_TEXT_CHARS = 120_000
const DEFAULT_PAGE_BATCH = 20
const MAX_PAGE_BATCH = 40
/** processPdf 每次调用最多接受 20 页。 */
const PDF_RENDER_CHUNK = 20
const MAX_SHEET_ROWS = 60
const MAX_SHEET_COLUMNS = 30
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_EDGE = 1800
const PAGE_TEXT_CACHE_MS = 5 * 60_000

/** core 在 visual 模式下唯一会产出的“非图片失败块”形状
 *  （见 pdf-ingest 的 `[PDF page N could not be rendered locally: …]`）。
 *  其余文本 part 都是正常内容，不能当作渲染失败。 */
const PDF_PAGE_FAILURE = /^\[PDF page \d+ could not be rendered locally:/

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const PDF_EXTENSION = '.pdf'
const SHEET_EXTENSIONS = new Set(['.xlsx'])
const CSV_EXTENSIONS = new Set(['.csv', '.tsv'])

/** 以绝对路径为键的提取页面文本；避免为每一次「加载更多」
 *  批次重新解析大 PDF。 */
const pageTextCache = new Map<string, { at: number; pageTexts: Map<number, string>; totalPages: number }>()

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [preview truncated at ${maxChars} chars]` : text
}

function imageMime(extension: string): string {
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'
  return 'image/png'
}

async function imageDataUrl(filePath: string, extension: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  if (buffer.length <= MAX_IMAGE_BYTES) {
    return `data:${imageMime(extension)};base64,${buffer.toString('base64')}`
  }
  try {
    const canvas = (await import('@napi-rs/canvas')) as unknown as {
      loadImage: (input: Buffer) => Promise<{ width: number; height: number }>
      createCanvas: (
        width: number,
        height: number,
      ) => {
        getContext: (kind: '2d') => {
          drawImage: (image: unknown, dx: number, dy: number, dw: number, dh: number) => void
        }
        encode: (format: 'jpeg') => Promise<Buffer>
      }
    }
    const image = await canvas.loadImage(buffer)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const surface = canvas.createCanvas(width, height)
    surface.getContext('2d').drawImage(image, 0, 0, width, height)
    const resized = await surface.encode('jpeg')
    return `data:image/jpeg;base64,${resized.toString('base64')}`
  } catch {
    return `data:${imageMime(extension)};base64,${buffer.toString('base64')}`
  }
}

function parseDelimited(
  text: string,
  delimiter: string,
): { rows: string[][]; totalRows: number; totalColumns: number } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  const totalRows = rows.length
  const totalColumns = rows.reduce((max, entry) => Math.max(max, entry.length), 0)
  const preview = rows.slice(0, MAX_SHEET_ROWS).map((entry) => entry.slice(0, MAX_SHEET_COLUMNS))
  return { rows: preview, totalRows, totalColumns }
}

/** ExcelJS 的 `cell.value` 不只有标量：超链接是 `{ text, hyperlink }`、公式是
 *  `{ formula, result }`、富文本是 `{ richText: [...] }`、错误值是
 *  `{ error: '#DIV/0!' }`，日期是 `Date`。直接 `String(value)` 会把前几种渲染成
 *  `[object Object]`——而这是用户直接看到的预览文本。 */
function excelCellText(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (raw instanceof Date) return raw.toLocaleString()
  if (typeof raw === 'object') {
    const cell = raw as {
      text?: unknown
      result?: unknown
      richText?: unknown
      error?: unknown
      hyperlink?: unknown
    }
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((run) => (run as { text?: string }).text ?? '').join('')
    }
    if (cell.text !== undefined && cell.text !== null) return String(cell.text)
    if (cell.result !== undefined && cell.result !== null) return String(cell.result)
    if (cell.error !== undefined) return String(cell.error)
    if (typeof cell.hyperlink === 'string') return cell.hyperlink
    return ''
  }
  return String(raw)
}

async function readSheetsWithExcel(filePath: string): Promise<DocumentSheetView[]> {
  const module = (await import('exceljs')) as unknown as {
    default?: { Workbook: new () => ExcelWorkbook }
    Workbook?: new () => ExcelWorkbook
  }
  interface ExcelCell {
    value: unknown
  }
  interface ExcelRow {
    getCell(index: number): ExcelCell
  }
  interface ExcelSheet {
    name: string
    rowCount: number
    columnCount: number
    getRow(index: number): ExcelRow
  }
  interface ExcelWorkbook {
    xlsx: { readFile(path: string): Promise<void> }
    worksheets: ExcelSheet[]
  }
  const WorkbookClass = module.default?.Workbook ?? module.Workbook
  if (!WorkbookClass) throw new Error('ExcelJS is unavailable')
  const workbook = new WorkbookClass()
  await workbook.xlsx.readFile(filePath)
  return workbook.worksheets.slice(0, 6).map((sheet) => {
    const rows: string[][] = []
    const rowLimit = Math.min(sheet.rowCount, MAX_SHEET_ROWS)
    const columnLimit = Math.min(sheet.columnCount, MAX_SHEET_COLUMNS)
    for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const cells: string[] = []
      for (let column = 1; column <= columnLimit; column++) {
        cells.push(excelCellText(row.getCell(column).value))
      }
      rows.push(cells)
    }
    return { name: sheet.name, rows, totalRows: sheet.rowCount, totalColumns: sheet.columnCount }
  })
}

/** 拆分 readDocument 输出的 `--- Page N ---` 块。 */
export function parsePageTexts(text: string): Map<number, string> {
  const pages = new Map<number, string>()
  const segments = text.split(/^--- Page (\d+) ---$/m)
  for (let index = 1; index < segments.length; index += 2) {
    pages.set(Number(segments[index]), (segments[index + 1] ?? '').trim())
  }
  return pages
}

function pageTextList(pageTexts: Map<number, string>, totalPages: number): DocumentTextPage[] {
  const pages: DocumentTextPage[] = []
  let budget = MAX_PAGE_TEXT_CHARS
  for (let page = 1; page <= totalPages; page++) {
    const text = pageTexts.get(page) ?? ''
    if (budget <= 0) {
      pages.push({ page, text: '' })
      continue
    }
    const bounded = text.length > budget ? text.slice(0, budget) : text
    budget -= bounded.length
    pages.push({ page, text: bounded })
  }
  return pages
}

function pageView(
  page: number,
  dataUrl: string,
  pageTexts: Map<number, string>,
  ocr: Record<number, string>,
): DocumentPageView {
  const extracted = pageTexts.get(page) ?? ''
  if (extracted) return { page, dataUrl, text: extracted }
  const ocrText = ocr[page]
  if (ocrText) return { page, dataUrl, text: ocrText, ocr: true }
  return { page, dataUrl, text: '' }
}

async function renderPdfPages(
  filePath: string,
  start: number,
  count: number,
  pageTexts: Map<number, string>,
  ocr: Record<number, string>,
  totalPages: number,
): Promise<{ pages: DocumentPageView[]; error?: string; warning?: string }> {
  const boundedStart = Math.max(1, start)
  const end = Math.min(totalPages, boundedStart + count - 1)
  if (count <= 0 || boundedStart > totalPages) return { pages: [] }
  const pages: DocumentPageView[] = []
  const notices: string[] = []
  let cutShort = false
  for (let first = boundedStart; first <= end; first += PDF_RENDER_CHUNK) {
    const last = Math.min(end, first + PDF_RENDER_CHUNK - 1)
    const result = await processPdf(filePath, {
      mode: 'visual',
      vision: true,
      pageRange: { first, last },
      maxRenderedPages: last - first + 1,
      rawImages: true,
    })
    if (result.type === 'error') {
      notices.push(result.message)
      cutShort = true
      continue
    }
    if (result.type !== 'content') {
      notices.push(`rendering stopped at page ${first}: ${result.reason}`)
      cutShort = true
      break
    }
    // 预算截断（continuation）时这一块剩余页本来就不会渲染，原因已经由
    // core 记在 continuation 里，不能当成“渲染失败”。
    if (result.continuation) cutShort = true
    for (const part of result.parts) {
      if (part.type !== 'image') {
        // `mode: 'visual'` 下非图片 part 有两类：每页正文块 / 图片前的层级标签
        // （正常输出，占绝大多数），以及真正的渲染失败块。只把后者算作 notice，
        // 否则任何带文本层的 PDF 都会被报成 “Some page images could not be
        // rendered”，甚至整批文本页被当成 error 抛出。
        if (part.type === 'text' && PDF_PAGE_FAILURE.test(part.text)) notices.push(part.text)
        continue
      }
      const page = part.source?.page ?? first
      pages.push(pageView(page, `data:${part.mediaType};base64,${part.data.toString('base64')}`, pageTexts, ocr))
    }
  }
  const sorted = pages.sort((a, b) => a.page - b.page)
  // 以“实际拿到图片的页码”和请求区间求差集，缺页才有据可依。只在整块都处理完
  // （没有被预算截断）时计算，否则会把正常的 continuation 当成渲染失败。
  if (!cutShort) {
    const renderedPages = new Set(sorted.map((page) => page.page))
    const missing: number[] = []
    for (let page = boundedStart; page <= end; page++) {
      if (!renderedPages.has(page)) missing.push(page)
    }
    if (missing.length > 0) {
      notices.push(`missing page image(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`)
    }
  }
  const note = notices.join(' ').slice(0, 600)
  if (notices.length === 0) return { pages: sorted }
  // 无论全失败还是部分失败都要报出来：只在「一张图都没渲染出来」时报错时，
  // 一到某页失败就 `continue`/`break` 的部分结果会静默缺页（`lastLoaded` 取最后
  // 一张成功图片的页码，`hasMore` 仍为 true，前端反复重试同一批）。
  if (sorted.length === 0) return { pages: sorted, error: note }
  return { pages: sorted, warning: `Some page images could not be rendered: ${note}` }
}

/** 总页数只认解析器给出的 metadata.pages：页面文本会被 core 在
 *  MAX_TEXT_CHARS 处截断（长 PDF 只有前几页有 `--- Page N ---` 块），
 *  扫描版 PDF 甚至完全没有文本层。用它推导上界会让「加载更多」提前结束。 */
function totalPagesOf(metadataPages: unknown, pageTexts: Map<number, string>): number {
  const declared = Number(metadataPages ?? 0)
  let highestTextPage = 0
  for (const page of pageTexts.keys()) {
    if (Number.isFinite(page) && page > highestTextPage) highestTextPage = page
  }
  const total = Math.max(Number.isFinite(declared) ? Math.floor(declared) : 0, highestTextPage, 1)
  return total
}

async function pdfPageInfo(filePath: string): Promise<{ pageTexts: Map<number, string>; totalPages: number }> {
  const cached = pageTextCache.get(filePath)
  if (cached && Date.now() - cached.at < PAGE_TEXT_CACHE_MS) {
    return { pageTexts: cached.pageTexts, totalPages: cached.totalPages }
  }
  const document = await readDocument(filePath, { maxChars: MAX_TEXT_CHARS, ocr: false })
  const pageTexts = parsePageTexts(document.text)
  const totalPages = totalPagesOf(document.metadata.pages, pageTexts)
  pageTextCache.set(filePath, { at: Date.now(), pageTexts, totalPages })
  return { pageTexts, totalPages }
}

function clampBatch(start: number | undefined, count: number | undefined): { start: number; count: number } {
  const normalizedStart = Number.isFinite(start) ? Math.max(1, Math.floor(start!)) : 1
  const normalizedCount = Number.isFinite(count)
    ? Math.max(1, Math.min(MAX_PAGE_BATCH, Math.floor(count!)))
    : DEFAULT_PAGE_BATCH
  return { start: normalizedStart, count: normalizedCount }
}

export async function openDocumentView(
  input: string,
  options: { start?: number; count?: number } = {},
): Promise<DocumentView> {
  const resolved = path.resolve(input)
  const extension = path.extname(resolved).toLowerCase()
  const view: DocumentView = {
    path: resolved,
    name: path.basename(resolved),
    format: extension.slice(1) || 'file',
    text: '',
    notes: [],
    metadata: {},
  }
  const stats = await fs.stat(resolved)
  if (!stats.isFile()) throw new Error(`Not a file: ${resolved}`)
  rememberDocument(resolved)
  const review = await ensureBaseline(resolved).catch(() => null)
  if (review?.editable) {
    view.editable = true
    view.baselineHash = review.hash
    view.changed = review.changed
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    view.dataUrl = await imageDataUrl(resolved, extension)
    view.metadata = { bytes: stats.size }
    return view
  }

  if (SHEET_EXTENSIONS.has(extension)) {
    view.sheets = await readSheetsWithExcel(resolved)
    view.metadata = { sheets: view.sheets.length, bytes: stats.size }
    return view
  }

  if (CSV_EXTENSIONS.has(extension)) {
    const raw = await fs.readFile(resolved, 'utf8')
    const parsed = parseDelimited(raw, extension === '.tsv' ? '\t' : ',')
    view.sheets = [{ name: path.basename(resolved), ...parsed }]
    view.metadata = { rows: parsed.totalRows, columns: parsed.totalColumns, bytes: stats.size }
    return view
  }

  // 页面图片覆盖扫描版 PDF，因此此处跳过（慢速的）OCR 回退。
  const document = await readDocument(resolved, {
    maxChars: MAX_TEXT_CHARS,
    ocr: extension === PDF_EXTENSION ? false : undefined,
  })
  view.text = clampText(document.text, MAX_TEXT_CHARS)
  // 预览从不针对 PDF 运行 OCR（改为显示页面图片），所以
  // 「不带 ocr:false 再次调用」的提示会误导。
  view.notes = document.notes.filter((note) => !/^OCR skipped for \d+ page\(s\)/.test(note))
  view.metadata = document.metadata

  if (extension === PDF_EXTENSION) {
    const pageTexts = parsePageTexts(document.text)
    // 与 loadDocumentPages 共用同一份总页数口径，避免分页上界两处不一致。
    const totalPages = totalPagesOf(document.metadata.pages, pageTexts)
    pageTextCache.set(resolved, { at: Date.now(), pageTexts, totalPages })
    const ocr = storedOcr(resolved)
    view.pageTexts = pageTextList(pageTexts, totalPages)
    view.totalPages = totalPages
    view.ocrPages = Object.keys(ocr)
      .map(Number)
      .sort((a, b) => a - b)
    if (totalPages > 0) {
      const batch = clampBatch(options.start, options.count)
      try {
        const rendered = await renderPdfPages(
          resolved,
          batch.start,
          Math.min(batch.count, totalPages - batch.start + 1),
          pageTexts,
          ocr,
          totalPages,
        )
        view.pages = rendered.pages
        if (rendered.error) view.notes.push(`Page images could not be rendered: ${rendered.error}`)
        if (rendered.warning) view.notes.push(rendered.warning)
      } catch (error) {
        view.notes.push(`Page images could not be rendered: ${error instanceof Error ? error.message : String(error)}`)
      }
      // 进度以「本批请求到的最后页码」兜底推进：部分页面渲染失败时最后一张
      // 成功图片的页码可能落后，若用它判定 hasMore，前端会反复请求同一批。
      const requestedLast = Math.min(totalPages, batch.start + batch.count - 1)
      const lastLoaded = Math.max(view.pages?.at(-1)?.page ?? batch.start - 1, requestedLast)
      view.hasMore = lastLoaded < totalPages
    }
  }
  return view
}

/** 加载下一批 PDF 页面图片，而不重新读取整个文档。 */
export async function loadDocumentPages(
  input: string,
  start: number,
  count: number,
): Promise<{ pages: DocumentPageView[]; hasMore: boolean }> {
  const resolved = path.resolve(input)
  if (path.extname(resolved).toLowerCase() !== PDF_EXTENSION) return { pages: [], hasMore: false }
  // 原始错误（含绝对路径、ENOENT）不该原样经 IPC 抛给 renderer，与
  // openDocumentView 保持一致地包装成可读消息。
  let pageTexts: Map<number, string>
  let totalPages: number
  try {
    ;({ pageTexts, totalPages } = await pdfPageInfo(resolved))
  } catch (error) {
    throw new Error(
      `无法读取 PDF 页信息：${path.basename(resolved)}（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
  // start/count 经 IPC 原样从 renderer 传来——`count: number` 只是编译期类型。
  // 不复用 clampBatch 时：count 可以任意大（对长 PDF 触发上百次串行渲染 + 海量
  // base64 回传），非数字/NaN 则让 `for (let first = NaN; ...)` 直接不执行，
  // 前端只看到「没有更多页面」而没有任何错误信息。
  const batch = clampBatch(start, count)
  const ocr = storedOcr(resolved)
  let rendered: Awaited<ReturnType<typeof renderPdfPages>>
  try {
    rendered = await renderPdfPages(resolved, batch.start, batch.count, pageTexts, ocr, totalPages)
  } catch (error) {
    throw new Error(
      `渲染 PDF 页面失败：${path.basename(resolved)}（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
  if (rendered.error) throw new Error(rendered.error)
  // 与 openDocumentView 同一口径：部分页失败时也不能让 hasMore 停在原地，
  // 否则前端会一遍遍请求同一批却看不到任何提示。
  const requestedLast = Math.min(totalPages, batch.start + batch.count - 1)
  const lastLoaded = Math.max(rendered.pages.at(-1)?.page ?? batch.start - 1, requestedLast)
  return { pages: rendered.pages, hasMore: lastLoaded < totalPages }
}

/** 按需对单个渲染后的 PDF 页面做 OCR（扫描页没有文本
 *  层）。结果被持久化，因此重新打开文档时仍保留。 */
export async function ocrDocumentPage(filePath: string, page: number): Promise<string> {
  const resolved = path.resolve(filePath)
  // `page` 与路径都直接来自 IPC 参数，`number` 只是编译期类型：非法页码会一路
  // 传给 processPdf，非 PDF 文件则只换来一条难以理解的错误。
  if (path.extname(resolved).toLowerCase() !== PDF_EXTENSION) throw new Error(`Not a PDF: ${resolved}`)
  if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid PDF page number: ${String(page)}`)
  const result = await processPdf(resolved, {
    mode: 'visual',
    vision: false,
    pageRange: { first: page, last: page },
    maxRenderedPages: 1,
    rawImages: true,
  })
  if (result.type === 'error') throw new Error(result.message)
  if (result.type !== 'content') throw new Error(`OCR stopped: ${result.reason}`)
  const text = result.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .replace(/^--- PDF page \d+ of \d+: .*\(local OCR\) ---\n/, '')
    .trim()
  // OCR 失败但 `result.type` 仍是 `content` 时 text 是空串。把空串持久化会让
  // 「该页无文字」与真实空白页无法区分，而且下次打开会命中这条空缓存。
  if (!text) throw new Error(`No text could be recognized on page ${page}.`)
  saveOcrPage(resolved, page, text)
  return text
}

export function forgetDocumentOcr(filePath: string): number {
  return forgetOcr(filePath)
}

export { recentDocuments }
