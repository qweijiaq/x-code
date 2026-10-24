import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { batchRename } from '../src/tools/batch-rename.js'
import { convert } from '../src/tools/convert.js'
import { documentExport, setDocumentRenderers } from '../src/tools/document-export.js'
import { spreadsheet } from '../src/tools/spreadsheet.js'
import { transcribe } from '../src/tools/transcribe.js'

let root = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-doc-tools-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function fixture(name: string, content: string | Buffer): string {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

async function run(tool: object, input: unknown): Promise<string> {
  const execute = (tool as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute
  const result = await execute(input, { toolCallId: 'test', messages: [], abortSignal: undefined })
  return String(result)
}

async function makePdf(file: string, pages: number, size: [number, number]): Promise<void> {
  const document = await PDFDocument.create()
  for (let index = 0; index < pages; index++) document.addPage(size)
  fs.writeFileSync(file, await document.save())
}

describe('batchRename', () => {
  it('defaults to a dry run and leaves files untouched', async () => {
    const dir = path.join(root, 'dry')
    fixture('dry/a.txt', 'a')
    fixture('dry/b.txt', 'b')

    const output = await run(batchRename, { directory: dir, prefix: 'x-' })

    expect(output).toContain('Dry run')
    expect(output).toContain('a.txt → x-a.txt')
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'x-a.txt'))).toBe(false)
  })

  it('applies find/replace and numbering when dryRun is false', async () => {
    const dir = path.join(root, 'apply')
    fixture('apply/photo-old.txt', '1')
    fixture('apply/photo-two.txt', '2')

    const output = await run(batchRename, { directory: dir, find: 'photo-', replace: 'pic-', dryRun: false })

    expect(output).toContain('Renamed 2 file(s)')
    expect(fs.existsSync(path.join(dir, 'pic-old.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pic-two.txt'))).toBe(true)

    const numbered = await run(batchRename, {
      directory: dir,
      numbering: { start: 1, padding: 2 },
      dryRun: false,
    })
    expect(numbered).toContain('Renamed 2 file(s)')
    expect(fs.existsSync(path.join(dir, '01.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '02.txt'))).toBe(true)
  })

  it('blocks the whole run and renames nothing when a target exists', async () => {
    const dir = path.join(root, 'conflict')
    fixture('conflict/a.txt', 'a')
    fixture('conflict/x-a.txt', 'existing')

    const output = await run(batchRename, { directory: dir, prefix: 'x-', dryRun: false })

    expect(output).toContain('blocked')
    expect(output).toContain('target exists')
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a')
    expect(fs.readFileSync(path.join(dir, 'x-a.txt'), 'utf8')).toBe('existing')
  })

  it('filters by extension', async () => {
    const dir = path.join(root, 'filter')
    fixture('filter/a.png', '1')
    fixture('filter/b.txt', '2')

    const output = await run(batchRename, { directory: dir, prefix: 'img-', extensions: ['png'], dryRun: false })

    expect(output).toContain('Renamed 1 file(s)')
    expect(fs.existsSync(path.join(dir, 'img-a.png'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true)
  })
})

describe('convert', () => {
  it('merges PDFs in order', async () => {
    const first = path.join(root, 'merge-a.pdf')
    const second = path.join(root, 'merge-b.pdf')
    await makePdf(first, 2, [200, 300])
    await makePdf(second, 1, [400, 500])
    const output = path.join(root, 'merged.pdf')

    const message = await run(convert, { action: 'pdf-merge', inputs: [first, second], output })

    expect(message).toContain('Merged 2 PDFs (3 pages)')
    const merged = await PDFDocument.load(fs.readFileSync(output))
    expect(merged.getPageCount()).toBe(3)
    expect(merged.getPage(2).getSize()).toEqual({ width: 400, height: 500 })
  })

  it('extracts a page range', async () => {
    const source = path.join(root, 'three-pages.pdf')
    await makePdf(source, 3, [200, 300])
    const output = path.join(root, 'page-2.pdf')

    const message = await run(convert, { action: 'pdf-extract', input: source, pages: '2', output })

    expect(message).toContain('Extracted 1 page(s)')
    const extracted = await PDFDocument.load(fs.readFileSync(output))
    expect(extracted.getPageCount()).toBe(1)
  })

  it('refuses to overwrite an existing output', async () => {
    const source = path.join(root, 'overwrite-src.pdf')
    await makePdf(source, 1, [200, 300])
    const output = fixture('existing.pdf', 'keep me')

    const message = await run(convert, { action: 'pdf-extract', input: source, pages: '1', output })

    expect(message).toContain('refusing to overwrite')
    expect(fs.readFileSync(output, 'utf8')).toBe('keep me')
  })
})

describe('transcribe', () => {
  it('rejects non-audio files without starting the model', async () => {
    const file = fixture('notes.txt', 'not audio')

    const message = await run(transcribe, { filePath: file })

    expect(message).toContain('Not an audio file')
  })
})

async function makeSheet(file: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['name', 'dept', 'amount'])
  sheet.addRow(['Ada', 'eng', 100])
  sheet.addRow(['Bob', 'eng', 50])
  sheet.addRow(['Cara', 'ops', 70])
  await workbook.xlsx.writeFile(file)
}

describe('spreadsheet', () => {
  it('reads a range with the header row', async () => {
    const file = path.join(root, 'table.xlsx')
    await makeSheet(file)

    const output = JSON.parse(await run(spreadsheet, { action: 'read', filePath: file, range: 'A1:C3' }))

    expect(output.sheet).toBe('Data')
    expect(output.headers).toEqual(['name', 'dept', 'amount'])
    expect(output.rows).toEqual([
      ['Ada', 'eng', 100],
      ['Bob', 'eng', 50],
    ])
  })

  it('filters and aggregates by group', async () => {
    const file = path.join(root, 'query.xlsx')
    await makeSheet(file)

    const output = JSON.parse(
      await run(spreadsheet, {
        action: 'query',
        filePath: file,
        filters: [{ column: 'dept', op: 'eq', value: 'eng' }],
        groupBy: 'dept',
        aggregates: [{ column: 'amount', op: 'sum' }],
      }),
    )

    expect(output.matched).toBe(1)
    expect(output.rows[0]).toMatchObject({ dept: 'eng', 'sum(amount)': 150 })
  })

  it('appends and sets cells, then reads them back', async () => {
    const file = path.join(root, 'write.xlsx')
    await makeSheet(file)

    const appended = await run(spreadsheet, {
      action: 'write',
      filePath: file,
      write: { mode: 'append', rows: [['Dan', 'ops', 30]] },
    })
    expect(appended).toContain('Wrote 1 row(s)')

    const updated = await run(spreadsheet, {
      action: 'write',
      filePath: file,
      write: { mode: 'set', startCell: 'B2', rows: [['research']] },
    })
    expect(updated).toContain('(set)')

    const output = JSON.parse(await run(spreadsheet, { action: 'read', filePath: file, range: 'A1:C5' }))
    expect(output.rows).toEqual([
      ['Ada', 'research', 100],
      ['Bob', 'eng', 50],
      ['Cara', 'ops', 70],
      ['Dan', 'ops', 30],
    ])
  })

  it('renders a chart and refuses to overwrite it', async () => {
    const output = path.join(root, 'chart.svg')
    const first = await run(spreadsheet, {
      action: 'chart',
      labels: ['a', 'b'],
      values: [1, 3],
      title: 'Smoke chart',
      output,
    })
    expect(first).toContain('Chart written')

    const source = fs.readFileSync(output, 'utf8')
    expect(source).toContain('<svg')
    expect(source).toContain('fill="#3f5f7f"')

    const second = await run(spreadsheet, { action: 'chart', labels: ['a'], values: [1], output })
    expect(second).toContain('refusing to overwrite')
  })
})

describe('documentExport', () => {
  it('renders Markdown to PDF through the registered renderer', async () => {
    let captured = ''
    setDocumentRenderers({
      pdf: async (html) => {
        captured = html
        return Buffer.from('%PDF-1.4 mock')
      },
    })
    const output = path.join(root, 'export.pdf')

    const message = await run(documentExport, {
      content: '# Title\n\nHello **world**',
      format: 'pdf',
      output,
      title: 'Doc',
    })

    expect(message).toContain('Exported PDF')
    expect(fs.readFileSync(output, 'utf8')).toBe('%PDF-1.4 mock')
    expect(captured).toContain('<h1>Title</h1>')
    expect(captured).toContain('<strong>world</strong>')
    setDocumentRenderers({})
  })

  it('explains that PDF export needs the desktop app', async () => {
    setDocumentRenderers({})
    const output = path.join(root, 'no-renderer.pdf')

    const message = await run(documentExport, { content: 'x', format: 'pdf', output })

    expect(message).toContain('needs the desktop app')
    expect(fs.existsSync(output)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('exports DOCX through textutil', async () => {
    const output = path.join(root, 'export.docx')

    const message = await run(documentExport, {
      content: '# 标题\n\n正文内容',
      format: 'docx',
      output,
      title: '文档',
    })

    expect(message).toContain('Exported DOCX')
    const bytes = fs.readFileSync(output)
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })
})
