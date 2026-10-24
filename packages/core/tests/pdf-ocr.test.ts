import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const processPdf = vi.fn()

vi.mock('../src/agent/pdf-ingest.js', () => ({
  processPdf: (...args: unknown[]) => processPdf(...args),
}))

// Page 1 and 3 have no usable text layer; page 2 is a normal text page.
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getInfo(): Promise<{ total: number }> {
      return { total: 3 }
    }

    async getText(): Promise<{ pages: Array<{ num: number; text: string }> }> {
      return {
        pages: [
          { num: 1, text: 'Cover' },
          { num: 2, text: 'Lorem ipsum dolor sit amet. '.repeat(10) },
          { num: 3, text: '' },
        ],
      }
    }

    async destroy(): Promise<void> {}
  },
}))

const { pdfOcrRuns, readDocument } = await import('../src/agent/document-extract.js')

let root = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-pdf-ocr-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  processPdf.mockReset()
})

function fixture(name: string, content: string | Buffer): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, content)
  return file
}

function ocrContent(pageNumber: number, text: string) {
  return {
    type: 'content' as const,
    analysis: { totalPages: 3, pages: [] },
    parts: [{ type: 'text' as const, text: `--- PDF page ${pageNumber} of 3: scan.pdf (local OCR) ---\n${text}` }],
  }
}

describe('scanned PDF OCR fallback', () => {
  it('renders and OCRs only the pages without a text layer', async () => {
    const file = fixture('scan.pdf', '%PDF-1.4\n scanned')
    processPdf
      .mockResolvedValueOnce(ocrContent(1, '第一页扫描文字'))
      .mockResolvedValueOnce(ocrContent(3, '第三页扫描文字'))

    const result = await readDocument(file)

    expect(processPdf).toHaveBeenCalledTimes(2)
    expect(processPdf).toHaveBeenNthCalledWith(
      1,
      file,
      expect.objectContaining({ pageRange: { first: 1, last: 1 }, mode: 'visual', vision: false }),
    )
    expect(processPdf).toHaveBeenNthCalledWith(
      2,
      file,
      expect.objectContaining({ pageRange: { first: 3, last: 3 }, mode: 'visual', vision: false }),
    )
    expect(result.text).toContain('第一页扫描文字')
    expect(result.text).toContain('第三页扫描文字')
    expect(result.text).toContain('Lorem ipsum')
    expect(result.metadata.ocrPages).toBe(2)
    expect(result.notes.join(' ')).toContain('Applied local OCR to 2 page(s)')
  })

  it('skips OCR when ocr:false and says how to retry', async () => {
    const file = fixture('scan-opt-out.pdf', '%PDF-1.4\n scanned')

    const result = await readDocument(file, { ocr: false })

    expect(processPdf).not.toHaveBeenCalled()
    expect(result.metadata.ocrPages).toBe(0)
    expect(result.notes.join(' ')).toContain('without ocr:false')
  })

  it('reports a failed OCR run without failing the whole read', async () => {
    const file = fixture('scan-fail.pdf', '%PDF-1.4\n scanned')
    processPdf.mockResolvedValue({ type: 'error', code: 'render-failed', message: 'worker crashed' })

    const result = await readDocument(file)

    expect(result.text).toContain('Cover')
    expect(result.notes.join(' ')).toContain('Local OCR failed for PDF pages 1-1: worker crashed')
  })
})

describe('pdfOcrRuns', () => {
  it('groups consecutive pages and splits wide runs', () => {
    expect(pdfOcrRuns([1, 2, 3, 8, 9, 12])).toEqual([
      { first: 1, last: 3 },
      { first: 8, last: 9 },
      { first: 12, last: 12 },
    ])
  })

  it('caps each run at four pages', () => {
    expect(pdfOcrRuns([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([
      { first: 1, last: 4 },
      { first: 5, last: 8 },
      { first: 9, last: 10 },
    ])
  })
})
