// @x-code-cli/core — 语义代码索引存储
//
// 与文档库分开：代码块按行切分，不需要页码/文档解析；索引位于
// <userDir>/code-index，避免和文档库互相污染。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'

export interface CodeChunk {
  id: string
  filePath: string
  startLine: number
  endLine: number
  text: string
  hash: string
  vectorIndex?: number
}

export interface CodeFile {
  path: string
  mtimeMs: number
  size: number
  characters: number
  chunks: number
  indexedAt: string
}

export interface CodeIndex {
  version: 1
  dimensions: number
  files: CodeFile[]
  chunks: CodeChunk[]
  vectorCount: number
  updatedAt: string
}

export const MAX_CODE_FILES = 1500
export const MAX_CODE_CHARS = 6_000_000
export const MAX_CODE_FILE_BYTES = 1_000_000

export function emptyCodeIndex(): CodeIndex {
  return { version: 1, dimensions: 0, files: [], chunks: [], vectorCount: 0, updatedAt: new Date().toISOString() }
}

export function codeIndexPaths(): { dir: string; indexFile: string; vectorsFile: string } {
  const dir = path.join(userXcodeDir(), 'code-index')
  return { dir, indexFile: path.join(dir, 'index.json'), vectorsFile: path.join(dir, 'vectors.f32') }
}

/** 磁盘上的维度 / 向量数只接受正整数。`Number(x) || 0` 会放过负数与小数
 *  （`Number(-1) || 0 === -1`），让后面的 `vectorCount * dimensions * 4`
 *  算出负数 / 非整数长度。 */
function positiveInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

function isCodeFile(value: unknown): value is CodeFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<CodeFile>
  return typeof file.path === 'string' && file.path.length > 0
}

function isCodeChunk(value: unknown): value is CodeChunk {
  if (!value || typeof value !== 'object') return false
  const chunk = value as Partial<CodeChunk>
  return (
    typeof chunk.id === 'string' &&
    typeof chunk.filePath === 'string' &&
    typeof chunk.text === 'string' &&
    Number.isFinite(chunk.startLine) &&
    Number.isFinite(chunk.endLine)
  )
}

export async function loadCodeIndex(): Promise<CodeIndex> {
  try {
    const raw = await fs.readFile(codeIndexPaths().indexFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CodeIndex>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.chunks)) {
      return emptyCodeIndex()
    }
    return {
      version: 1,
      dimensions: positiveInteger(parsed.dimensions),
      // 索引是外部可写的 JSON：坏元素（null / 字段类型错误）必须在读取时
      // 剔除，否则会在检索阶段以 TypeError 崩掉整次查询而不是安全降级。
      files: parsed.files.filter(isCodeFile),
      chunks: parsed.chunks.filter(isCodeChunk),
      vectorCount: positiveInteger(parsed.vectorCount),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return emptyCodeIndex()
  }
}

export async function loadCodeVectors(index: CodeIndex): Promise<Float32Array | null> {
  if (index.dimensions <= 0 || index.vectorCount <= 0) return null
  const expected = Math.trunc(index.vectorCount * index.dimensions)
  if (!Number.isSafeInteger(expected) || expected <= 0) return null
  try {
    const buffer = await fs.readFile(codeIndexPaths().vectorsFile)
    const bytes = expected * 4
    if (buffer.byteLength < bytes) return null
    // `Float32Array` 要求 byteOffset 是 4 的倍数，而 fs.readFile 在小文件上会从
    // 共享的 Buffer 池里切一段（偏移任意），直接建视图会抛
    // `RangeError: Start offset ... should be a multiple of 4`，被外层 catch 吞掉
    // 之后语义检索就静默退化成 keyword-only。先拷贝成对齐的独立 ArrayBuffer。
    const aligned = new ArrayBuffer(bytes)
    new Uint8Array(aligned).set(buffer.subarray(0, bytes))
    return new Float32Array(aligned)
  } catch {
    return null
  }
}

async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  // 只用 pid 区分不够：同一进程内两次写入（CLI 与桌面 runtime 共享进程，或
  // index/clear 交叠）会争用同一个临时文件，互相覆盖后 rename 出损坏内容。
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    // 先 fsync 再 rename：否则进程被强杀时可能留下"改名成功但内容为空"的文件。
    const handle = await fs.open(temp, 'w', 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, filePath)
  } catch (error) {
    // 失败路径上清掉临时文件，避免在 code-index 目录里长期堆积 .tmp 残留。
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function saveCodeIndex(index: CodeIndex, vectors: Float32Array | null): Promise<void> {
  const paths = codeIndexPaths()
  await fs.mkdir(paths.dir, { recursive: true })
  // 元数据与向量文件必须互相一致：只写其一会让 index.json 声称有向量，而
  // vectors.f32 缺失（检索永远拿不到向量）或长度不足（`vectorIndex * dimensions`
  // 读到错位数据 —— 分数错误而不是报错）。
  const consistent =
    vectors !== null &&
    index.dimensions > 0 &&
    index.vectorCount > 0 &&
    vectors.length === index.vectorCount * index.dimensions
  let persisted: CodeIndex = index
  if (consistent && vectors) {
    await writeAtomic(paths.vectorsFile, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength))
  } else {
    await fs.rm(paths.vectorsFile, { force: true }).catch(() => undefined)
    if (index.dimensions !== 0 || index.vectorCount !== 0) {
      persisted = { ...index, dimensions: 0, vectorCount: 0 }
    }
  }
  await writeAtomic(paths.indexFile, JSON.stringify(persisted))
}

export async function clearCodeIndex(): Promise<void> {
  const paths = codeIndexPaths()
  await fs.rm(paths.indexFile, { force: true }).catch(() => undefined)
  await fs.rm(paths.vectorsFile, { force: true }).catch(() => undefined)
}
