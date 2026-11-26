// 持久化文档元数据：最近文档和每页 OCR 文本。
//
// 页面图片从不持久化（按需重新渲染）；只保留用户请求的
// OCR 文本，这样重新打开扫描版 PDF 会显示
// 识别出的文本，直到用户清除。
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

/** 统计存储文件本身；它不是目录，不能复用 directoryStats。 */
export async function documentStoreStats(): Promise<{ bytes: number; files: number }> {
  try {
    const stat = await fs.promises.stat(storePath())
    return stat.isFile() ? { bytes: stat.size, files: 1 } : { bytes: 0, files: 0 }
  } catch {
    return { bytes: 0, files: 0 }
  }
}

/** 删除 OCR 文本与变更对比基线。原始文档不受影响，最近文档列表也会清空。 */
export async function clearDocumentStore(): Promise<void> {
  await fs.promises.rm(storePath(), { force: true }).catch(() => undefined)
}

/** 存储文件是不可信输入（可被手工编辑、旧版本写入或写一半损坏）。
 *  逐条归一化，避免缺少 `ocr` 的坏条目让 `Object.keys(document.ocr)`
 *  抛 TypeError，把「最近文档」整块功能带崩。 */
function normalizeDocument(value: unknown): StoredDocument {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<StoredDocument>) : {}
  const ocr: Record<string, string> = {}
  const rawOcr = source.ocr
  if (rawOcr && typeof rawOcr === 'object' && !Array.isArray(rawOcr)) {
    for (const [page, text] of Object.entries(rawOcr as Record<string, unknown>)) {
      if (typeof text === 'string') ocr[page] = text
    }
  }
  const document: StoredDocument = {
    ocr,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString(),
  }
  const baseline = source.baseline
  if (
    baseline &&
    typeof baseline === 'object' &&
    typeof baseline.hash === 'string' &&
    typeof baseline.text === 'string'
  ) {
    document.baseline = {
      hash: baseline.hash,
      text: baseline.text,
      updatedAt: typeof baseline.updatedAt === 'string' ? baseline.updatedAt : new Date(0).toISOString(),
    }
  }
  return document
}

function loadStore(): DocumentStoreFile {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DocumentStoreFile>
    const sourceDocuments = parsed?.documents
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !sourceDocuments ||
      typeof sourceDocuments !== 'object' ||
      Array.isArray(sourceDocuments) ||
      !Array.isArray(parsed.recent)
    ) {
      return emptyStore()
    }
    // 键是文件路径；用无原型对象，避免外部可控键命中原型链。
    const documents: Record<string, StoredDocument> = Object.create(null) as Record<string, StoredDocument>
    for (const [key, value] of Object.entries(sourceDocuments)) {
      if (typeof key !== 'string' || !key) continue
      documents[key] = normalizeDocument(value)
    }
    return {
      version: 1,
      documents,
      recent: parsed.recent.filter((entry) => typeof entry === 'string'),
    }
  } catch {
    return emptyStore()
  }
}

function saveStore(store: DocumentStoreFile): void {
  const dir = userXcodeDir()
  const target = path.join(dir, STORE_FILE)
  const temp = `${target}.${process.pid}.tmp`
  // 持久化最近文档只是附带的副作用：目录只读/磁盘满/Windows 上 rename 撞占用
  // 都不应该让「打开文档」整体失败。
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600 })
    fs.renameSync(temp, target)
  } catch (error) {
    console.warn('[document-store] 保存文档存储失败：', error)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function rememberDocument(filePath: string): void {
  const resolved = path.resolve(filePath)
  const store = loadStore()
  store.recent = [resolved, ...store.recent.filter((entry) => entry !== resolved)].slice(0, MAX_RECENT)
  const document = store.documents[resolved] ?? { ocr: {}, updatedAt: new Date().toISOString() }
  document.updatedAt = new Date().toISOString()
  store.documents[resolved] = document
  // 文档条目只对最近打开列表里的路径有意义（其余路径已无法通过访问策略）。
  // 不裁剪的话文件体积会随「历史打开过的文档总数」无界增长，每次读写
  // 都要解析/序列化整份存储。
  for (const key of Object.keys(store.documents)) {
    if (!store.recent.includes(key)) delete store.documents[key]
  }
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

export function saveOcrPage(filePath: string, page: number, text: string): boolean {
  if (!Number.isInteger(page) || page < 1) return false
  if (typeof text !== 'string') return false
  const resolved = path.resolve(filePath)
  const store = loadStore()
  const document = store.documents[resolved] ?? { ocr: {}, updatedAt: new Date().toISOString() }
  const key = String(page)
  // 上限只拦「新增页」：重新识别已存在的页必须能覆盖旧文本，否则识别结果
  // 会被静默丢弃，而调用方还以为保存成功。
  if (!(key in document.ocr) && Object.keys(document.ocr).length >= MAX_PAGES_PER_DOC) return false
  document.ocr[key] = text.slice(0, MAX_OCR_TEXT_CHARS)
  document.updatedAt = new Date().toISOString()
  store.documents[resolved] = document
  store.recent = [resolved, ...store.recent.filter((entry) => entry !== resolved)].slice(0, MAX_RECENT)
  saveStore(store)
  return true
}

/** 清除某个文档的 OCR 文本。返回被移除的页数。 */
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
const MAX_OCR_TEXT_CHARS = 400_000

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
