import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { palmDocDecompress, readDocument } from '../src/agent/document-extract.js'
import { readDocumentTool } from '../src/tools/read-document.js'

let root = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-doc-extract-'))
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

describe('readDocument text formats', () => {
  it('reads markdown as text', async () => {
    const file = fixture('note.md', '# Title\n\nHello **world**.\n')
    const result = await readDocument(file)
    expect(result.format).toBe('md')
    expect(result.text).toContain('Hello **world**')
    expect(result.truncated).toBe(false)
  })

  it('parses quoted CSV cells and embedded newlines', async () => {
    const file = fixture('table.csv', 'name,note\n"Ada, A.","line1\nline2"\nBob,hi\n')
    const result = await readDocument(file)
    expect(result.metadata.rows).toBe(3)
    expect(result.metadata.columns).toBe(2)
    expect(result.text).toContain('Ada, A. | line1 line2')
  })

  it('truncates extracted text to maxChars', async () => {
    const file = fixture('long.md', 'x'.repeat(5_000))
    const result = await readDocument(file, { maxChars: 1_000 })
    expect(result.text.length).toBe(1_000)
    expect(result.truncated).toBe(true)
  })

  it('formats the tool result with metadata and content', async () => {
    const file = fixture('tool.md', '# Tool\n\nDocument body.\n')
    const output = await readDocumentTool.execute!({ filePath: file }, {
      toolCallId: 'doc-test',
      abortSignal: undefined,
    } as never)
    expect(output).toContain('Document: ')
    expect(output).toContain('Format: md')
    expect(output).toContain('Document body.')
  })
})

describe('readDocument EPUB', () => {
  it('extracts spine chapters and metadata', async () => {
    const fflate = await import('fflate')
    const encoder = new TextEncoder()
    const zip = fflate.zipSync({
      mimetype: encoder.encode('application/epub+zip'),
      'META-INF/container.xml': encoder.encode(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
      'OEBPS/content.opf': encoder.encode(
        `<?xml version="1.0"?><package><metadata>
          <dc:title>Test Book</dc:title><dc:creator>Ada</dc:creator>
        </metadata><manifest>
          <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`,
      ),
      'OEBPS/ch1.xhtml': encoder.encode('<html><body><h1>Chapter 1</h1><p>Hello EPUB.</p></body></html>'),
      'OEBPS/ch2.xhtml': encoder.encode('<html><body><p>Second chapter.</p></body></html>'),
    })
    const file = fixture('book.epub', Buffer.from(zip))
    const result = await readDocument(file)
    expect(result.format).toBe('epub')
    expect(result.metadata.title).toBe('Test Book')
    expect(result.metadata.author).toBe('Ada')
    expect(result.metadata.chapters).toBe(2)
    expect(result.text).toContain('Chapter 1')
    expect(result.text).toContain('Second chapter.')
  })
})

describe('readDocument MOBI', () => {
  function pdbWithText(text: string): Buffer {
    const name = Buffer.alloc(32)
    name.write('TestBook', 'latin1')
    const header = Buffer.alloc(86)
    name.copy(header, 0)
    header.writeUInt16BE(2, 76)
    const record0 = Buffer.alloc(16)
    record0.writeUInt16BE(1, 0) // 无压缩
    record0.writeUInt32BE(Buffer.byteLength(text), 4)
    record0.writeUInt16BE(1, 8)
    record0.writeUInt16BE(4096, 10)
    record0.writeUInt16BE(0, 12)
    const record1 = Buffer.from(text)
    const record0Offset = header.length
    const record1Offset = record0Offset + record0.length
    header.writeUInt32BE(record0Offset, 78)
    header.writeUInt32BE(record1Offset, 82)
    return Buffer.concat([header, record0, record1])
  }

  it('extracts PalmDOC text', async () => {
    const file = fixture('book.mobi', pdbWithText('Hello MOBI reader.'))
    const result = await readDocument(file)
    expect(result.format).toBe('mobi')
    expect(result.metadata.title).toBe('TestBook')
    expect(result.text).toBe('Hello MOBI reader.')
  })

  it('decompresses PalmDOC literals and back-references', () => {
    // "abc" 后跟一个 distance-3/length-3 对 -> "abcabc"。
    const input = Uint8Array.from([0x61, 0x62, 0x63, 0x80, 0x18])
    expect(Buffer.from(palmDocDecompress(input)).toString('utf8')).toBe('abcabc')
    // 0xC3 = 一个空格加三个字面字节。
    expect(Buffer.from(palmDocDecompress(Uint8Array.from([0xc3, 0x78, 0x79, 0x7a]))).toString('utf8')).toBe(' xyz')
  })
})

describe('readDocument video metadata', () => {
  function box(type: string, payload: Buffer): Buffer {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + payload.length, 0)
    header.write(type, 4, 'latin1')
    return Buffer.concat([header, payload])
  }

  it('reads MP4 duration from mvhd', async () => {
    const mvhd = Buffer.alloc(100)
    mvhd.writeUInt32BE(1000, 12) // timescale（时间刻度）
    mvhd.writeUInt32BE(5000, 16) // duration（时长）→ 5 秒
    const moov = box('moov', box('mvhd', mvhd))
    const file = fixture('clip.mp4', moov)
    const result = await readDocument(file)
    expect(result.format).toBe('mp4')
    expect(result.metadata.durationSeconds).toBe(5)
  })
})
