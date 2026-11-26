// @x-code-cli/core — 本地代码索引
//
// 按文件行窗口切块，复用文档库的可选 BGE embedder。语义后端不可用时自动
// 降级为关键词检索；索引是增量的：mtime/size 未变且块哈希可复用时不重读。
import crypto from 'node:crypto'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { EMBEDDING_DIMENSIONS, embedQuery, embedTexts, embedderStatus } from '../library/embedder.js'
import { buildSnippet, tokenize } from '../library/tokenize.js'
import {
  type CodeChunk,
  type CodeFile,
  type CodeIndex,
  MAX_CODE_CHARS,
  MAX_CODE_FILES,
  MAX_CODE_FILE_BYTES,
  clearCodeIndex,
  codeIndexPaths,
  emptyCodeIndex,
  loadCodeIndex,
  loadCodeVectors,
  saveCodeIndex,
} from './store.js'

export { clearCodeIndex, codeIndexPaths }
export type { CodeChunk, CodeFile, CodeIndex }

export interface CodeIndexProgress {
  phase: 'scan' | 'read' | 'embed' | 'save'
  processed: number
  total: number
  chunks: number
}

export interface CodeIndexResult {
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

export interface CodeSearchResult {
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  score: number
  snippet: string
  mode: 'hybrid' | 'keyword'
}

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.vue',
  '.svelte',
])

export const CODE_INDEX_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.x-code',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  '__pycache__',
])

const CHUNK_LINES = 80
const CHUNK_OVERLAP = 10
const EMBED_BATCH = 16

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex')
}

export function isCodeIndexFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function collectCodeFiles(
  root: string,
  out: Array<{ path: string; mtimeMs: number; size: number }>,
  depth = 0,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 子目录读不到（并发删除、权限）只是跳过这一棵子树。根目录读不到则完全不同：
    // 候选集变成空集，下面的“已删除”判定会把整份增量索引清空且不留任何提示。
    // 只有“根目录确实不存在”才是合法的空态，其它错误必须上抛。
    if (depth === 0 && code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const target = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (CODE_INDEX_SKIP_DIRS.has(entry.name)) continue
      await collectCodeFiles(target, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !isCodeIndexFile(target)) continue
    try {
      const stat = await fs.stat(target)
      if (stat.size <= MAX_CODE_FILE_BYTES) out.push({ path: target, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      // 扫描期间消失的文件跳过。
    }
  }
}

function chunkCode(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split(/\r?\n/)
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = []
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES)
    const body = lines.slice(start, end).join('\n')
    if (body.trim()) chunks.push({ startLine: start + 1, endLine: end, text: body })
    if (end >= lines.length) break
  }
  return chunks
}

function vectorMap(index: CodeIndex, vectors: Float32Array | null): Map<string, Float32Array> {
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

export async function scanCodeFiles(root: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  await collectCodeFiles(path.resolve(root), files)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** 把从 `from` 起尚未处理的候选文件标记为"本轮未确认删除，需保留"。
 *  扫描因上限提前 break 时，后面的文件仍在磁盘上，只是这一轮没扫到。 */
function markUnprocessed(candidates: ReadonlyArray<{ path: string }>, from: number, into: Set<string>): void {
  for (let index = from; index < candidates.length; index++) {
    const candidate = candidates[index]
    if (candidate) into.add(candidate.path)
  }
}

export async function indexCode(
  target: string,
  options: { semantic?: boolean; onProgress?: (progress: CodeIndexProgress) => void } = {},
): Promise<CodeIndexResult> {
  const root = path.resolve(target)
  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = []
  options.onProgress?.({ phase: 'scan', processed: 0, total: 0, chunks: 0 })
  try {
    await collectCodeFiles(root, candidates)
  } catch (error) {
    // 根目录不可读（EACCES / EIO / 卷未挂载）：保留既有索引，不写盘。
    // 空候选集会走“已删除”判定，把整份增量索引静默清空。
    const previous = await loadCodeIndex()
    const message = `${root}: ${error instanceof Error ? error.message : String(error)}`
    return {
      files: previous.files.length,
      indexed: 0,
      skipped: 0,
      removed: 0,
      chunks: previous.chunks.length,
      characters: previous.files.reduce((total, file) => total + file.characters, 0),
      vectors: previous.vectorCount,
      semantic: previous.dimensions > 0,
      note: 'Code index could not be scanned; the existing index was left untouched.',
      errors: [message],
    }
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path))

  const previous = await loadCodeIndex()
  const previousVectors = await loadCodeVectors(previous)
  const reusable = vectorMap(previous, previousVectors)
  const previousByPath = new Map(previous.files.map((file) => [file.path, file]))
  const previousChunksByPath = new Map<string, CodeChunk[]>()
  for (const chunk of previous.chunks) {
    const list = previousChunksByPath.get(chunk.filePath) ?? []
    list.push(chunk)
    previousChunksByPath.set(chunk.filePath, list)
  }

  const files: CodeFile[] = []
  const chunks: CodeChunk[] = []
  const pendingEmbedding: CodeChunk[] = []
  // 本轮扫描到、但没能产出 chunk 的文件（瞬时读错误、目录/字符上限截断、空
  // 文件）。它们仍然在磁盘上，绝不能当作"已删除"从索引里剔除：否则每次运行
  // 都在第 N 个文件截断，靠后的文件永远进不了索引。
  const keptWithoutChunks = new Set<string>()
  let characters = 0
  let indexed = 0
  let skipped = 0
  let note: string | undefined
  const errors: string[] = []

  for (const [position, candidate] of candidates.entries()) {
    if (files.length >= MAX_CODE_FILES) {
      note = `File limit reached (${MAX_CODE_FILES}); remaining files were not indexed.`
      markUnprocessed(candidates, position, keptWithoutChunks)
      break
    }
    if (characters >= MAX_CODE_CHARS) {
      note = `Character budget reached (${MAX_CODE_CHARS}); remaining files were not indexed.`
      markUnprocessed(candidates, position, keptWithoutChunks)
      break
    }
    options.onProgress?.({ phase: 'read', processed: position, total: candidates.length, chunks: chunks.length })
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
      // 复用分支只为缺向量的块补嵌（例如上次语义后端不可用时没嵌成）。
      // `reusable` 是"已有向量"的哈希表，本轮 embed 阶段又会用 `!vectorsByHash.has`
      // 过滤一遍，所以这里必须是 `!reusable.has(...)`，否则这些块永远回填不上。
      if (options.semantic) {
        for (const chunk of oldChunks) {
          if (chunk.vectorIndex === undefined && !reusable.has(chunk.hash)) pendingEmbedding.push(chunk)
        }
      }
      skipped++
      continue
    }

    try {
      const text = await fs.readFile(candidate.path, 'utf8')
      const raws = chunkCode(text)
      if (raws.length === 0) {
        // 空文件/只剩空白：文件存在，只是没有可索引内容。保留其既有条目。
        keptWithoutChunks.add(candidate.path)
        continue
      }
      const charCount = raws.reduce((total, chunk) => total + chunk.text.length, 0)
      if (characters + charCount > MAX_CODE_CHARS) {
        note = `Character budget reached (${MAX_CODE_CHARS}); ${candidate.path} was not indexed.`
        markUnprocessed(candidates, position, keptWithoutChunks)
        break
      }
      files.push({
        path: candidate.path,
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        characters: charCount,
        chunks: raws.length,
        indexedAt: new Date().toISOString(),
      })
      for (const [chunkIndex, raw] of raws.entries()) {
        const chunk: CodeChunk = {
          id: `${candidate.path}#${chunkIndex}`,
          filePath: candidate.path,
          startLine: raw.startLine,
          endLine: raw.endLine,
          text: raw.text,
          hash: sha1(raw.text),
        }
        if (!reusable.has(chunk.hash) && options.semantic) pendingEmbedding.push(chunk)
        chunks.push(chunk)
      }
      characters += charCount
      indexed++
    } catch (error) {
      // EACCES/EBUSY/EIO 之类瞬时错误：文件还在，只是这次读不到。保留既有条目。
      keptWithoutChunks.add(candidate.path)
      errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const knownPaths = new Set(files.map((file) => file.path))
  const isUnderIndexRoot = (filePath: string): boolean => filePath.startsWith(root + path.sep)
  // "已删除"只包括本轮未复现、且不是因为错误/上限/空文件而跳过的条目。
  const removedPaths = new Set(
    previous.files
      .filter((file) => isUnderIndexRoot(file.path) && !knownPaths.has(file.path) && !keptWithoutChunks.has(file.path))
      .map((file) => file.path),
  )
  const removed = removedPaths.size
  for (const file of previous.files) {
    if (removedPaths.has(file.path)) continue
    if (!knownPaths.has(file.path)) {
      files.push(file)
      characters += file.characters
      chunks.push(...(previousChunksByPath.get(file.path) ?? []))
    }
  }

  const vectorsByHash = new Map(reusable)
  let semantic = false
  // 不要比较 `vectorsByHash.size` 与 `chunks.length`：前者只覆盖往轮已嵌的块，
  // 与本轮块总数没有可比性。索引基本未变时该不等式恒不成立，新块会被静默丢掉
  // 向量。下面已经用 `unique` 去重，为空自然不进入循环。
  if (options.semantic && pendingEmbedding.length > 0) {
    const unique = new Map<string, CodeChunk>()
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
  const nextIndex: CodeIndex = {
    ...emptyCodeIndex(),
    dimensions: vectorData ? EMBEDDING_DIMENSIONS : 0,
    files,
    chunks,
    vectorCount: vectorList.length,
    updatedAt: new Date().toISOString(),
  }
  await saveCodeIndex(nextIndex, vectorData)

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

function keywordScore(chunk: CodeChunk, terms: string[]): number {
  const lowerText = chunk.text.toLowerCase()
  const lowerPath = chunk.filePath.toLowerCase()
  let score = 0
  for (const term of terms) {
    let occurrences = 0
    let cursor = lowerText.indexOf(term)
    while (cursor !== -1 && occurrences < 20) {
      occurrences++
      cursor = lowerText.indexOf(term, cursor + term.length)
    }
    if (occurrences > 0) score += 1 + Math.log(occurrences)
    if (lowerPath.includes(term)) score += 3
  }
  return score
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export async function searchCodeIndex(
  query: string,
  options: { limit?: number; path?: string; semantic?: boolean } = {},
): Promise<{ results: CodeSearchResult[]; mode: 'hybrid' | 'keyword' }> {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], mode: 'keyword' }
  const index = await loadCodeIndex()
  if (index.chunks.length === 0) return { results: [], mode: 'keyword' }
  let chunks = index.chunks
  if (options.path) {
    const scope = path.resolve(options.path)
    chunks = chunks.filter((chunk) => chunk.filePath === scope || chunk.filePath.startsWith(scope + path.sep))
  }
  const terms = [...new Set(tokenize(trimmed))].slice(0, 32)
  let vectors: Float32Array | null = null
  let queryVector: Float32Array | null = null
  if (options.semantic !== false && index.dimensions > 0) {
    vectors = await loadCodeVectors(index)
    if (vectors) queryVector = await embedQuery(trimmed)
  }
  const mode: 'hybrid' | 'keyword' = queryVector ? 'hybrid' : 'keyword'
  const scored = chunks.map((chunk) => {
    const keyword = keywordScore(chunk, terms)
    let vector = 0
    if (vectors && queryVector && chunk.vectorIndex !== undefined) {
      const offset = chunk.vectorIndex * index.dimensions
      vector = cosine(queryVector, vectors.slice(offset, offset + index.dimensions))
    }
    return { chunk, score: keyword + vector * 4 }
  })
  const results = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(options.limit ?? 8, 30)))
    .map(({ chunk, score }) => ({
      filePath: chunk.filePath,
      fileName: path.basename(chunk.filePath),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      snippet: buildSnippet(chunk.text, terms),
      mode,
    }))
  return { results, mode }
}

export async function codeIndexStats(): Promise<{
  files: number
  chunks: number
  characters: number
  vectors: number
  dimensions: number
  updatedAt: string
  indexPath: string
  semantic: Awaited<ReturnType<typeof embedderStatus>>
}> {
  const index = await loadCodeIndex()
  return {
    files: index.files.length,
    chunks: index.chunks.length,
    characters: index.files.reduce((total, file) => total + file.characters, 0),
    vectors: index.vectorCount,
    dimensions: index.dimensions,
    updatedAt: index.updatedAt,
    indexPath: codeIndexPaths().indexFile,
    semantic: await embedderStatus(),
  }
}
