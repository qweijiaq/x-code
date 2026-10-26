// @x-code-cli/core — 本地文档库：索引、统计、混合检索。
//
// 文件由 readDocument 解析（本地抽取），切成带重叠的块，
// 连同文本一起存入 index.json。向量是可选的：BGE 后端可用时
// 它们存在 vectors.f32 里，否则库降级为关键词检索。mtime 和
// 大小未变化的文件会被跳过，未变化的块保留其现有向量（哈希复用）。
import crypto from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { readDocument } from '../agent/document-extract.js'
import { EMBEDDING_DIMENSIONS, embedQuery, embedTexts, embedderStatus } from './embedder.js'
import {
  MAX_LIBRARY_CHARS,
  MAX_LIBRARY_FILES,
  clearLibrary,
  emptyLibraryIndex,
  libraryPaths,
  loadLibraryIndex,
  loadVectors,
  saveLibraryIndex,
} from './store.js'
import type { LibraryChunk, LibraryFile, LibraryIndex } from './store.js'
import { buildSnippet, chunkText, tokenize } from './tokenize.js'

export interface IndexProgress {
  phase: 'scan' | 'read' | 'embed' | 'save'
  processed: number
  total: number
  chunks: number
}

export interface IndexResult {
  files: number
  indexed: number
  skipped: number
  removed: number
  chunks: number
  characters: number
  vectors: number
  semantic: boolean
  note?: string
  errors: string[]
}

export interface LibraryStats {
  files: number
  chunks: number
  characters: number
  vectors: number
  dimensions: number
  updatedAt: string
  indexPath: string
  semantic: { backendInstalled: boolean; modelReady: boolean; note: string }
}

export interface LibrarySearchResult {
  filePath: string
  fileName: string
  page?: number
  score: number
  snippet: string
  kind: 'hybrid' | 'keyword'
}

const INDEXABLE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
  '.epub',
  '.mobi',
  '.azw',
  '.azw3',
])
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.x-code',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
])
const MAX_FILE_CHARS = 300_000
const EMBED_BATCH = 16

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex')
}

function isIndexable(filePath: string): boolean {
  return INDEXABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function collectFiles(
  input: string,
  recursive: boolean,
  out: Array<{ path: string; mtimeMs: number; size: number }>,
): Promise<void> {
  const entry = path.resolve(input)
  let stat: Stats
  try {
    stat = await fs.stat(entry)
  } catch {
    return
  }
  if (stat.isFile()) {
    if (isIndexable(entry)) out.push({ path: entry, mtimeMs: stat.mtimeMs, size: stat.size })
    return
  }
  if (!stat.isDirectory()) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(entry, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of entries) {
    if (item.name.startsWith('.')) continue
    if (SKIP_DIRS.has(item.name)) continue
    const full = path.join(entry, item.name)
    if (item.isDirectory()) {
      if (recursive) await collectFiles(full, true, out)
      continue
    }
    if (!item.isFile() || !isIndexable(full)) continue
    try {
      const fileStat = await fs.stat(full)
      out.push({ path: full, mtimeMs: fileStat.mtimeMs, size: fileStat.size })
    } catch {
      // 不可读的文件：跳过。
    }
  }
}

interface RawChunk {
  page?: number
  start: number
  text: string
}

/** 把抽取出的文档切成块，保留 PDF 页码。 */
function documentChunks(text: string, extension: string): RawChunk[] {
  if (extension === '.pdf') {
    const segments = text.split(/^--- Page (\d+) ---$/m)
    if (segments.length > 1) {
      const chunks: RawChunk[] = []
      for (let index = 1; index < segments.length; index += 2) {
        const page = Number(segments[index])
        const pageText = (segments[index + 1] ?? '').trim()
        for (const chunk of chunkText(pageText)) chunks.push({ page, start: chunk.start, text: chunk.text })
      }
      return chunks
    }
  }
  return chunkText(text).map((chunk) => ({ start: chunk.start, text: chunk.text }))
}

function vectorMap(index: LibraryIndex, vectors: Float32Array | null): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>()
  if (!vectors || index.dimensions <= 0) return map
  for (const chunk of index.chunks) {
    if (chunk.vectorIndex === undefined) continue
    const offset = chunk.vectorIndex * index.dimensions
    const vector = vectors.slice(offset, offset + index.dimensions)
    if (vector.length === index.dimensions) map.set(chunk.hash, vector)
  }
  return map
}

export async function indexLibrary(
  target: string,
  options: { recursive?: boolean; semantic?: boolean; onProgress?: (progress: IndexProgress) => void } = {},
): Promise<IndexResult> {
  const recursive = options.recursive !== false
  const root = path.resolve(target)
  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = []
  options.onProgress?.({ phase: 'scan', processed: 0, total: 0, chunks: 0 })
  await collectFiles(root, recursive, candidates)
  candidates.sort((a, b) => a.path.localeCompare(b.path))

  const previous = await loadLibraryIndex()
  const previousVectors = await loadVectors(previous)
  const reusable = vectorMap(previous, previousVectors)
  const previousByPath = new Map(previous.files.map((file) => [file.path, file]))
  const previousChunksByPath = new Map<string, LibraryChunk[]>()
  for (const chunk of previous.chunks) {
    const list = previousChunksByPath.get(chunk.filePath) ?? []
    list.push(chunk)
    previousChunksByPath.set(chunk.filePath, list)
  }

  const files: LibraryFile[] = []
  const chunks: LibraryChunk[] = []
  const pendingEmbedding: LibraryChunk[] = []
  let characters = 0
  let skipped = 0
  let indexed = 0
  const errors: string[] = []
  let note: string | undefined

  for (const [index, candidate] of candidates.entries()) {
    if (files.length >= MAX_LIBRARY_FILES) {
      note = `File limit reached (${MAX_LIBRARY_FILES}); remaining files were not indexed.`
      break
    }
    if (characters >= MAX_LIBRARY_CHARS) {
      note = `Character budget reached (${MAX_LIBRARY_CHARS}); remaining files were not indexed.`
      break
    }
    options.onProgress?.({ phase: 'read', processed: index, total: candidates.length, chunks: chunks.length })
    const existing = previousByPath.get(candidate.path)
    if (
      existing &&
      existing.mtimeMs === candidate.mtimeMs &&
      existing.size === candidate.size &&
      previousChunksByPath.has(candidate.path)
    ) {
      files.push(existing)
      const oldChunks = previousChunksByPath.get(candidate.path) ?? []
      chunks.push(...oldChunks)
      characters += existing.characters
      for (const chunk of oldChunks) {
        if (chunk.vectorIndex === undefined && reusable.has(chunk.hash)) pendingEmbedding.push(chunk)
      }
      skipped++
      continue
    }

    try {
      const document = await readDocument(candidate.path, { maxChars: MAX_FILE_CHARS })
      const extension = path.extname(candidate.path).toLowerCase()
      const raws = documentChunks(document.text, extension)
      if (raws.length === 0) {
        errors.push(`${candidate.path}: no extractable text`)
        continue
      }
      const fileName = path.basename(candidate.path)
      const charCount = raws.reduce((total, chunk) => total + chunk.text.length, 0)
      if (characters + charCount > MAX_LIBRARY_CHARS) {
        note = `Character budget reached (${MAX_LIBRARY_CHARS}); ${candidate.path} was not indexed.`
        break
      }
      files.push({
        path: candidate.path,
        name: fileName,
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        characters: charCount,
        chunks: raws.length,
        indexedAt: new Date().toISOString(),
      })
      for (const [chunkIndex, raw] of raws.entries()) {
        const chunk: LibraryChunk = {
          id: `${candidate.path}#${chunkIndex}`,
          filePath: candidate.path,
          fileName,
          page: raw.page,
          start: raw.start,
          text: raw.text,
          hash: sha1(raw.text),
        }
        if (!reusable.has(chunk.hash) && options.semantic) pendingEmbedding.push(chunk)
        chunks.push(chunk)
      }
      characters += charCount
      indexed++
    } catch (error) {
      errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 删除已不存在且不属于本次运行的文件条目。
  const knownPaths = new Set(files.map((file) => file.path))
  // 只遗忘索引根目录内消失的文件；来自其他文件夹的
  // 无关库条目会被保留。
  const removed = previous.files.filter(
    (file) => file.path.startsWith(root + path.sep) && !knownPaths.has(file.path),
  ).length
  for (const file of previous.files) {
    if (file.path.startsWith(root + path.sep) && !knownPaths.has(file.path)) continue
    if (!knownPaths.has(file.path)) {
      // 保留本次运行未触及的文件夹中的条目。
      files.push(file)
      characters += file.characters
      const oldChunks = previousChunksByPath.get(file.path) ?? []
      chunks.push(...oldChunks)
    }
  }

  // 对还没有可复用向量的块做嵌入。
  const vectorsByHash = new Map(reusable)
  let semantic = false
  if (options.semantic && pendingEmbedding.length > 0 && vectorsByHash.size < chunks.length) {
    const unique = new Map<string, LibraryChunk>()
    for (const chunk of pendingEmbedding) if (!vectorsByHash.has(chunk.hash)) unique.set(chunk.hash, chunk)
    const list = [...unique.values()]
    for (let offset = 0; offset < list.length; offset += EMBED_BATCH) {
      const batch = list.slice(offset, offset + EMBED_BATCH)
      options.onProgress?.({ phase: 'embed', processed: offset, total: list.length, chunks: chunks.length })
      const embedded = await embedTexts(batch.map((chunk) => chunk.text))
      if (!embedded) {
        note = [note, 'Semantic embedding unavailable; indexed keyword-only.'].filter(Boolean).join(' ')
        break
      }
      for (const [index, vector] of embedded.entries()) {
        const chunk = batch[index]
        if (chunk) vectorsByHash.set(chunk.hash, vector)
      }
    }
  }

  options.onProgress?.({ phase: 'save', processed: files.length, total: files.length, chunks: chunks.length })
  const vectorList: Float32Array[] = []
  for (const chunk of chunks) {
    const vector = vectorsByHash.get(chunk.hash)
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      delete chunk.vectorIndex
      continue
    }
    chunk.vectorIndex = vectorList.length
    vectorList.push(vector)
  }
  const vectorData = vectorList.length > 0 ? new Float32Array(vectorList.length * EMBEDDING_DIMENSIONS) : null
  if (vectorData) {
    for (const [index, vector] of vectorList.entries()) vectorData.set(vector, index * EMBEDDING_DIMENSIONS)
    semantic = true
  }
  const nextIndex: LibraryIndex = {
    ...emptyLibraryIndex(),
    dimensions: vectorData ? EMBEDDING_DIMENSIONS : 0,
    files,
    chunks,
    vectorCount: vectorList.length,
    updatedAt: new Date().toISOString(),
  }
  await saveLibraryIndex(nextIndex, vectorData)

  return {
    files: files.length,
    indexed,
    skipped,
    removed,
    chunks: chunks.length,
    characters,
    vectors: vectorList.length,
    semantic,
    ...(note ? { note } : {}),
    errors: errors.slice(0, 10),
  }
}

export async function libraryStats(): Promise<LibraryStats> {
  const index = await loadLibraryIndex()
  const semantic = await embedderStatus()
  return {
    files: index.files.length,
    chunks: index.chunks.length,
    characters: index.files.reduce((total, file) => total + file.characters, 0),
    vectors: index.vectorCount,
    dimensions: index.dimensions,
    updatedAt: index.updatedAt,
    indexPath: libraryPaths().indexFile,
    semantic,
  }
}

export async function clearDocumentLibrary(): Promise<void> {
  await clearLibrary()
}

function keywordScores(
  chunks: LibraryChunk[],
  terms: string[],
): { scores: number[]; documentFrequency: Map<string, number> } {
  const documentFrequency = new Map<string, number>()
  for (const chunk of chunks) {
    const present = new Set(tokenize(`${chunk.fileName} ${chunk.text}`))
    for (const term of terms) if (present.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  const total = Math.max(1, chunks.length)
  const scores: number[] = []
  for (const chunk of chunks) {
    const lowerName = chunk.fileName.toLowerCase()
    const lowerText = chunk.text.toLowerCase()
    let score = 0
    for (const term of terms) {
      const idf = Math.log(1 + total / Math.max(1, documentFrequency.get(term) ?? 0))
      let occurrences = 0
      let cursor = lowerText.indexOf(term)
      while (cursor !== -1 && occurrences < 20) {
        occurrences++
        cursor = lowerText.indexOf(term, cursor + term.length)
      }
      if (occurrences > 0) score += (1 + Math.log(occurrences)) * idf
      if (lowerName.includes(term)) score += 3 * idf
    }
    if (terms.length > 0 && lowerText.includes(terms.join(''))) score += 2
    scores.push(score)
  }
  return { scores, documentFrequency }
}

export async function searchLibrary(
  query: string,
  options: { limit?: number; path?: string; semantic?: boolean } = {},
): Promise<{ results: LibrarySearchResult[]; mode: 'hybrid' | 'keyword' }> {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], mode: 'keyword' }
  const index = await loadLibraryIndex()
  let chunks = index.chunks
  if (options.path) {
    const scope = path.resolve(options.path)
    chunks = chunks.filter((chunk) => chunk.filePath === scope || chunk.filePath.startsWith(scope + path.sep))
  }
  if (chunks.length === 0) return { results: [], mode: 'keyword' }

  const terms = [...new Set(tokenize(trimmed))].slice(0, 32)
  const { scores } = keywordScores(chunks, terms)
  const keywordRank = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score)
    .filter((entry) => entry.score > 0)

  let vectorRank: Array<{ score: number; index: number }> = []
  let mode: 'hybrid' | 'keyword' = 'keyword'
  if (options.semantic !== false) {
    const vectors = await loadVectors(index)
    if (vectors && index.dimensions > 0) {
      const queryVector = await embedQuery(trimmed)
      if (queryVector && queryVector.length === index.dimensions) {
        vectorRank = chunks
          .map((chunk, position) => {
            if (chunk.vectorIndex === undefined) return null
            const offset = chunk.vectorIndex * index.dimensions
            let dot = 0
            for (let dimension = 0; dimension < index.dimensions; dimension++) {
              dot += queryVector[dimension]! * vectors[offset + dimension]!
            }
            return { score: dot, index: position }
          })
          .filter((entry): entry is { score: number; index: number } => entry !== null)
          .sort((a, b) => b.score - a.score)
        if (vectorRank.length > 0) mode = 'hybrid'
      }
    }
  }

  const fused = new Map<number, number>()
  const RRF = 60
  for (const [rank, entry] of keywordRank.slice(0, 100).entries()) {
    fused.set(entry.index, (fused.get(entry.index) ?? 0) + 1 / (RRF + rank + 1))
  }
  for (const [rank, entry] of vectorRank.slice(0, 100).entries()) {
    fused.set(entry.index, (fused.get(entry.index) ?? 0) + 1 / (RRF + rank + 1))
  }
  const ordered = [...fused.entries()]
    .map(([position, score]) => ({ position, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, options.limit ?? 8)))

  const results: LibrarySearchResult[] = ordered.map(({ position, score }) => {
    const chunk = chunks[position]!
    return {
      filePath: chunk.filePath,
      fileName: chunk.fileName,
      page: chunk.page,
      score: Number(score.toFixed(4)),
      snippet: buildSnippet(chunk.text, terms),
      kind: mode,
    }
  })
  return { results, mode }
}
