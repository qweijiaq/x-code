// @x-code-cli/core — Document library storage.
//
// Layout under <user dir>/library:
//   index.json   metadata + chunk text (bounded by the character budget)
//   vectors.f32  raw little-endian float32 vectors, `dimensions` per chunk
//
// Both files are replaced atomically. The vector file is written first and the
// index second, so a reader never sees an index that points past the vectors.
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'

export interface LibraryChunk {
  id: string
  filePath: string
  fileName: string
  page?: number
  start: number
  text: string
  hash: string
  vectorIndex?: number
}

export interface LibraryFile {
  path: string
  name: string
  mtimeMs: number
  size: number
  characters: number
  chunks: number
  indexedAt: string
}

export interface LibraryIndex {
  version: 1
  dimensions: number
  files: LibraryFile[]
  chunks: LibraryChunk[]
  vectorCount: number
  updatedAt: string
}

export const MAX_LIBRARY_FILES = 200
export const MAX_LIBRARY_CHARS = 5_000_000

export function emptyLibraryIndex(): LibraryIndex {
  return { version: 1, dimensions: 0, files: [], chunks: [], vectorCount: 0, updatedAt: new Date().toISOString() }
}

export function libraryPaths(): { dir: string; indexFile: string; vectorsFile: string } {
  const dir = path.join(userXcodeDir(), 'library')
  return { dir, indexFile: path.join(dir, 'index.json'), vectorsFile: path.join(dir, 'vectors.f32') }
}

export async function loadLibraryIndex(): Promise<LibraryIndex> {
  try {
    const raw = await fs.readFile(libraryPaths().indexFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LibraryIndex>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.chunks)) {
      return emptyLibraryIndex()
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
    return emptyLibraryIndex()
  }
}

export async function loadVectors(index: LibraryIndex): Promise<Float32Array | null> {
  if (index.dimensions <= 0 || index.vectorCount <= 0) return null
  try {
    const buffer = await fs.readFile(libraryPaths().vectorsFile)
    const expected = index.vectorCount * index.dimensions
    if (buffer.length < expected * 4) return null
    const copy = new Float32Array(buffer.buffer, buffer.byteOffset, expected)
    return copy.slice()
  } catch {
    return null
  }
}

async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const temp = `${filePath}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temp, data, { mode: 0o600 })
  await fs.rename(temp, filePath)
}

export async function saveLibraryIndex(index: LibraryIndex, vectors: Float32Array | null): Promise<void> {
  const paths = libraryPaths()
  await fs.mkdir(paths.dir, { recursive: true })
  if (vectors && index.dimensions > 0) {
    const bytes = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    await writeAtomic(paths.vectorsFile, bytes)
  } else {
    await fs.rm(paths.vectorsFile, { force: true }).catch(() => {})
  }
  await writeAtomic(paths.indexFile, JSON.stringify(index))
}

export async function clearLibrary(): Promise<void> {
  const paths = libraryPaths()
  await fs.rm(paths.indexFile, { force: true }).catch(() => {})
  await fs.rm(paths.vectorsFile, { force: true }).catch(() => {})
}
