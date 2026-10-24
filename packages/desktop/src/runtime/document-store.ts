// Persisted document metadata: recent documents and per-page OCR text.
//
// Page images are never persisted (they are re-rendered on demand); only the
// OCR text the user asked for is kept, so reopening a scanned PDF shows the
// recognised text until the user clears it.
import fs from 'node:fs'
import path from 'node:path'

import { userXcodeDir } from '@x-code-cli/core'

import type { DocumentRecentItem } from '../shared/protocol.js'

const STORE_FILE = 'desktop-documents.json'
const MAX_RECENT = 20
const MAX_PAGES_PER_DOC = 500

interface StoredBaseline {
  hash: string
  text: string
  updatedAt: string
}

interface StoredDocument {
  ocr: Record<string, string>
  baseline?: StoredBaseline
  updatedAt: string
}

interface DocumentStoreFile {
  version: 1
  documents: Record<string, StoredDocument>
  recent: string[]
}

function emptyStore(): DocumentStoreFile {
  return { version: 1, documents: {}, recent: [] }
}

function storePath(): string {
  return path.join(userXcodeDir(), STORE_FILE)
}

function loadStore(): DocumentStoreFile {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DocumentStoreFile>
    if (!parsed || typeof parsed !== 'object' || !parsed.documents || !Array.isArray(parsed.recent)) {
      return emptyStore()
    }
    return {
      version: 1,
      documents: parsed.documents,
      recent: parsed.recent.filter((entry) => typeof entry === 'string'),
    }
  } catch {
    return emptyStore()
  }
}

function saveStore(store: DocumentStoreFile): void {
  const dir = userXcodeDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, STORE_FILE)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600 })
  fs.renameSync(temp, target)
}

export function rememberDocument(filePath: string): void {
  const resolved = path.resolve(filePath)
  const store = loadStore()
  store.recent = [resolved, ...store.recent.filter((entry) => entry !== resolved)].slice(0, MAX_RECENT)
  const document = store.documents[resolved] ?? { ocr: {}, updatedAt: new Date().toISOString() }
  document.updatedAt = new Date().toISOString()
  store.documents[resolved] = document
  saveStore(store)
}

export function storedOcr(filePath: string): Record<number, string> {
  const document = loadStore().documents[path.resolve(filePath)]
  if (!document) return {}
  const pages: Record<number, string> = {}
  for (const [page, text] of Object.entries(document.ocr)) {
    const pageNumber = Number(page)
    if (Number.isInteger(pageNumber) && pageNumber > 0 && typeof text === 'string') pages[pageNumber] = text
  }
  return pages
}

export function saveOcrPage(filePath: string, page: number, text: string): void {
  const resolved = path.resolve(filePath)
  const store = loadStore()
  const document = store.documents[resolved] ?? { ocr: {}, updatedAt: new Date().toISOString() }
  if (Object.keys(document.ocr).length >= MAX_PAGES_PER_DOC) return
  document.ocr[String(page)] = text
  document.updatedAt = new Date().toISOString()
  store.documents[resolved] = document
  store.recent = [resolved, ...store.recent.filter((entry) => entry !== resolved)].slice(0, MAX_RECENT)
  saveStore(store)
}

/** Clear OCR text for one document. Returns the number of pages removed. */
export function forgetOcr(filePath: string): number {
  const resolved = path.resolve(filePath)
  const store = loadStore()
  const document = store.documents[resolved]
  if (!document) return 0
  const cleared = Object.keys(document.ocr).length
  document.ocr = {}
  document.updatedAt = new Date().toISOString()
  saveStore(store)
  return cleared
}

const MAX_BASELINE_CHARS = 400_000

export function storedBaseline(filePath: string): StoredBaseline | null {
  const document = loadStore().documents[path.resolve(filePath)]
  const baseline = document?.baseline
  if (!baseline || typeof baseline.hash !== 'string' || typeof baseline.text !== 'string') return null
  return baseline
}

export function saveBaseline(filePath: string, hash: string, text: string): void {
  if (text.length > MAX_BASELINE_CHARS) return
  const resolved = path.resolve(filePath)
  const store = loadStore()
  const document = store.documents[resolved] ?? { ocr: {}, updatedAt: new Date().toISOString() }
  document.baseline = { hash, text, updatedAt: new Date().toISOString() }
  document.updatedAt = new Date().toISOString()
  store.documents[resolved] = document
  saveStore(store)
}

export function recentDocuments(): DocumentRecentItem[] {
  const store = loadStore()
  return store.recent
    .map((entry) => {
      const document = store.documents[entry]
      return {
        path: entry,
        name: path.basename(entry),
        updatedAt: document?.updatedAt ?? '',
        hasOcr: Boolean(document && Object.keys(document.ocr).length > 0),
        exists: fs.existsSync(entry),
      }
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}
