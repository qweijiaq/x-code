// @x-code-cli/core — 语义代码索引存储
//
// 与文档库分开：代码块按行切分，不需要页码/文档解析；索引位于
// <userDir>/code-index，避免和文档库互相污染。
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

export async function loadCodeIndex(): Promise<CodeIndex> {
  try {
    const raw = await fs.readFile(codeIndexPaths().indexFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CodeIndex>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.chunks)) {
      return emptyCodeIndex()
    }
    return {
      version: 1,
      dimensions: Number(parsed.dimensions) || 0,
      files: parsed.files,
      chunks: parsed.chunks,
      vectorCount: Number(parsed.vectorCount) || 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return emptyCodeIndex()
  }
}

export async function loadCodeVectors(index: CodeIndex): Promise<Float32Array | null> {
  if (index.dimensions <= 0 || index.vectorCount <= 0) return null
  try {
    const buffer = await fs.readFile(codeIndexPaths().vectorsFile)
    const expected = index.vectorCount * index.dimensions
    if (buffer.length < expected * 4) return null
    return new Float32Array(buffer.buffer, buffer.byteOffset, expected).slice()
  } catch {
    return null
  }
}

async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temp, data, { mode: 0o600 })
  await fs.rename(temp, filePath)
}

export async function saveCodeIndex(index: CodeIndex, vectors: Float32Array | null): Promise<void> {
  const paths = codeIndexPaths()
  await fs.mkdir(paths.dir, { recursive: true })
  if (vectors && index.dimensions > 0) {
    await writeAtomic(paths.vectorsFile, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength))
  } else {
    await fs.rm(paths.vectorsFile, { force: true }).catch(() => undefined)
  }
  await writeAtomic(paths.indexFile, JSON.stringify(index))
}

export async function clearCodeIndex(): Promise<void> {
  const paths = codeIndexPaths()
  await fs.rm(paths.indexFile, { force: true }).catch(() => undefined)
  await fs.rm(paths.vectorsFile, { force: true }).catch(() => undefined)
}
