import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { clearDocumentLibrary, indexLibrary, libraryStats, searchLibrary } from '../src/library/index.js'
import { libraryPaths } from '../src/library/store.js'
import { chunkText, tokenize } from '../src/library/tokenize.js'

let root = ''
let previousHome: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-library-'))
  previousHome = process.env.X_CODE_HOME
  process.env.X_CODE_HOME = path.join(root, 'home')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  fs.rmSync(root, { recursive: true, force: true })
})

function writeDoc(name: string, content: string): string {
  const file = path.join(root, 'docs', name)
  fs.writeFileSync(file, content)
  return file
}

describe('library text helpers', () => {
  it('tokenizes latin words and CJK bigrams', () => {
    expect(tokenize('PDF 文档检索 search')).toEqual(expect.arrayContaining(['pdf', 'search', '文档', '档检', '检索']))
  })

  it('splits long text into overlapping chunks', () => {
    const text = '第一段内容。'.repeat(200)
    const chunks = chunkText(text, { maxChars: 300, overlap: 50 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300)
  })
})

describe('document library', () => {
  it('indexes files, skips unchanged ones, and searches by keyword', async () => {
    const alpha = writeDoc('alpha.md', '# 项目甲\n\n机器学习与文档检索。\n')
    writeDoc('beta.md', 'Quarterly budget notes for the office team.\n')

    const first = await indexLibrary(path.join(root, 'docs'), { semantic: false })
    expect(first.files).toBe(2)
    expect(first.indexed).toBe(2)
    expect(first.skipped).toBe(0)
    expect(first.chunks).toBeGreaterThanOrEqual(2)

    const second = await indexLibrary(path.join(root, 'docs'), { semantic: false })
    expect(second.skipped).toBe(2)
    expect(second.indexed).toBe(0)

    const results = await searchLibrary('文档检索', { semantic: false })
    expect(results.mode).toBe('keyword')
    expect(results.results[0]?.filePath).toBe(alpha)
    expect(results.results[0]?.snippet).toContain('文档检索')

    const english = await searchLibrary('budget office', { semantic: false })
    expect(english.results[0]?.fileName).toBe('beta.md')
  })

  it('reindexes a changed file and removes deleted ones', async () => {
    const alpha = writeDoc('alpha.md', 'alpha content\n')
    const beta = writeDoc('beta.md', 'beta content\n')
    await indexLibrary(path.join(root, 'docs'), { semantic: false })

    fs.writeFileSync(alpha, 'alpha content updated with needle\n')
    fs.unlinkSync(beta)

    const updated = await indexLibrary(path.join(root, 'docs'), { semantic: false })
    expect(updated.indexed).toBe(1)
    expect(updated.removed).toBe(1)

    const stats = await libraryStats()
    expect(stats.files).toBe(1)

    const results = await searchLibrary('needle', { semantic: false })
    expect(results.results[0]?.filePath).toBe(alpha)
    const gone = await searchLibrary('beta content', { semantic: false })
    expect(gone.results.some((result) => result.fileName === 'beta.md')).toBe(false)
  })

  it('clears the index', async () => {
    writeDoc('alpha.md', 'alpha content\n')
    await indexLibrary(path.join(root, 'docs'), { semantic: false })
    expect((await libraryStats()).files).toBe(1)

    await clearDocumentLibrary()

    expect((await libraryStats()).files).toBe(0)
    expect(fs.existsSync(libraryPaths().indexFile)).toBe(false)
  })

  it('reports embedding availability without throwing', async () => {
    const stats = await libraryStats()
    expect(typeof stats.semantic.backendInstalled).toBe('boolean')
    expect(stats.semantic.note.length).toBeGreaterThan(0)
  })
})
