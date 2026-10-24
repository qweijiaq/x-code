// Desktop document previews: one request in, one bounded view out.
//
// Text comes from core's readDocument (local parsing/OCR); PDFs render page
// images in batches (20 by default) through core's pdf-render worker, and
// spreadsheets are parsed into small sheet previews with ExcelJS. OCR the user
// runs page by page is persisted in desktop-documents.json and merged back on
// the next open until the user clears it.
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
/** processPdf accepts at most 20 pages per call. */
const PDF_RENDER_CHUNK = 20
const MAX_SHEET_ROWS = 60
const MAX_SHEET_COLUMNS = 30
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_EDGE = 1800
const PAGE_TEXT_CACHE_MS = 5 * 60_000

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const PDF_EXTENSION = '.pdf'
const SHEET_EXTENSIONS = new Set(['.xlsx'])
const CSV_EXTENSIONS = new Set(['.csv', '.tsv'])

/** Extracted page text keyed by absolute path; avoids re-parsing a large PDF
 *  for every "load more" batch. */
const pageTextCache = new Map<string, { at: number; pageTexts: Map<number, string> }>()

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
        const value = row.getCell(column).value
        cells.push(value === null || value === undefined ? '' : String(value))
      }
      rows.push(cells)
    }
    return { name: sheet.name, rows, totalRows: sheet.rowCount, totalColumns: sheet.columnCount }
  })
}

/** Split the `--- Page N ---` blocks emitted by readDocument. */
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
): Promise<{ pages: DocumentPageView[]; error?: string }> {
  const boundedStart = Math.max(1, start)
  const end = Math.min(totalPages, boundedStart + count - 1)
  if (count <= 0 || boundedStart > totalPages) return { pages: [] }
  const pages: DocumentPageView[] = []
  const notices: string[] = []
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
      continue
    }
    if (result.type !== 'content') {
      notices.push(`rendering stopped at page ${first}: ${result.reason}`)
      break
    }
    for (const part of result.parts) {
      if (part.type !== 'image') {
        if (part.type === 'text') notices.push(part.text)
        continue
      }
      const page = part.source?.page ?? first
      pages.push(pageView(page, `data:${part.mediaType};base64,${part.data.toString('base64')}`, pageTexts, ocr))
    }
  }
  return {
    pages: pages.sort((a, b) => a.page - b.page),
    ...(pages.length === 0 && notices.length > 0 ? { error: notices.join(' ').slice(0, 600) } : {}),
  }
}

async function pdfPageTexts(filePath: string): Promise<Map<number, string>> {
  const cached = pageTextCache.get(filePath)
  if (cached && Date.now() - cached.at < PAGE_TEXT_CACHE_MS) return cached.pageTexts
  const document = await readDocument(filePath, { maxChars: MAX_TEXT_CHARS, ocr: false })
  const pageTexts = parsePageTexts(document.text)
  pageTextCache.set(filePath, { at: Date.now(), pageTexts })
  return pageTexts
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

  // Page images cover scanned PDFs, so skip the (slow) OCR fallback here.
  const document = await readDocument(resolved, {
    maxChars: MAX_TEXT_CHARS,
    ocr: extension === PDF_EXTENSION ? false : undefined,
  })
  view.text = clampText(document.text, MAX_TEXT_CHARS)
  // Previews never run OCR for PDFs (page images are shown instead), so the
  // "call again without ocr:false" hint would be misleading.
  view.notes = document.notes.filter((note) => !/^OCR skipped for \d+ page\(s\)/.test(note))
  view.metadata = document.metadata

  if (extension === PDF_EXTENSION) {
    const totalPages = Number(document.metadata.pages ?? 0)
    const pageTexts = parsePageTexts(document.text)
    pageTextCache.set(resolved, { at: Date.now(), pageTexts })
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
      } catch (error) {
        view.notes.push(`Page images could not be rendered: ${error instanceof Error ? error.message : String(error)}`)
      }
      const lastLoaded = view.pages?.at(-1)?.page ?? batch.start - 1
      view.hasMore = lastLoaded < totalPages
    }
  }
  return view
}

/** Load the next PDF page-image batch without re-reading the whole document. */
export async function loadDocumentPages(
  input: string,
  start: number,
  count: number,
): Promise<{ pages: DocumentPageView[]; hasMore: boolean }> {
  const resolved = path.resolve(input)
  if (path.extname(resolved).toLowerCase() !== PDF_EXTENSION) return { pages: [], hasMore: false }
  const pageTexts = await pdfPageTexts(resolved)
  const totalPages = pageTexts.size > 0 ? Math.max(...pageTexts.keys()) : 1
  const ocr = storedOcr(resolved)
  const rendered = await renderPdfPages(resolved, start, count, pageTexts, ocr, totalPages)
  if (rendered.error) throw new Error(rendered.error)
  const lastLoaded = rendered.pages.at(-1)?.page ?? start - 1
  return { pages: rendered.pages, hasMore: lastLoaded < totalPages }
}

/** OCR a single rendered PDF page on demand (scanned pages have no text
 *  layer). The result is persisted so reopening the document keeps it. */
export async function ocrDocumentPage(filePath: string, page: number): Promise<string> {
  const resolved = path.resolve(filePath)
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
  saveOcrPage(resolved, page, text)
  return text
}

export function forgetDocumentOcr(filePath: string): number {
  return forgetOcr(filePath)
}

export { recentDocuments }
