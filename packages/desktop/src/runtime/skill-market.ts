import yauzl from 'yauzl'

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { SkillMarketEntryView, SkillMarketListView, SkillMarketProvider } from '../shared/protocol.js'
import { importSkillIntoUserDir } from './skill-import.js'
import type { CopiedSkill } from './skill-install-command.js'

const SKILLHUB_SEARCH_URL = 'https://api.skillhub.cn/api/v1/search'
const SKILLHUB_DOWNLOAD_URL = 'https://api.skillhub.cn/api/v1/download'
const SKILLSMP_MCP_URL = 'https://skillsmp.com/mcp'
const SKILLSMP_PROTOCOL_VERSION = '2025-06-18'
const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024
const MAX_ZIP_FILES = 500
const CACHE_TTL_MS = 5 * 60_000

const DESKTOP_VERSION = (() => {
  try {
    return String(createRequire(import.meta.url)('../../package.json').version)
  } catch {
    return '0.0.0'
  }
})()

const searchCache = new Map<string, { at: number; view: SkillMarketListView }>()

function truncate(value: unknown, max = 500): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function markInstalled(view: SkillMarketEntryView, installed: Set<string>): SkillMarketEntryView {
  const candidates = [view.name, view.id].map((value) => value.toLowerCase())
  return { ...view, installed: candidates.some((candidate) => installed.has(candidate)) }
}

// ─── SkillHub ───

/** Install id: `@namespace/publicSlug` when the catalog provides a namespace. */
export function parseSkillHubId(id: string): { namespace?: string; slug: string } {
  const trimmed = id.trim()
  const scoped = trimmed.match(/^@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (scoped) return { namespace: scoped[1]!, slug: scoped[2]! }
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return { slug: trimmed }
  throw new Error('无效的 SkillHub 技能 ID')
}

export function parseSkillHubSearch(payload: unknown, installed: Set<string>): SkillMarketEntryView[] {
  const results =
    payload && typeof payload === 'object' && Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: unknown[] }).results as unknown[])
      : []
  const entries: SkillMarketEntryView[] = []
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const slug = optionalString(item.slug)
    if (!slug) continue
    const namespace =
      item.namespace && typeof item.namespace === 'object' ? (item.namespace as Record<string, unknown>) : {}
    const handle = optionalString(namespace.handle)
    const publicSlug = optionalString(namespace.publicSlug) ?? slug
    const name = optionalString(item.displayName) ?? optionalString(item.name) ?? publicSlug
    const labels = item.labels && typeof item.labels === 'object' ? (item.labels as Record<string, unknown>) : {}
    const view: SkillMarketEntryView = {
      id: handle ? `@${handle}/${publicSlug}` : publicSlug,
      provider: 'skillhub',
      name,
      description: truncate(item.description ?? item.summary),
      ...(optionalString(item.description_zh) ? { descriptionZh: truncate(item.description_zh) } : {}),
      ...(optionalString(item.owner_name) ? { author: optionalString(item.owner_name) } : {}),
      ...(optionalString(item.version) ? { version: optionalString(item.version) } : {}),
      ...(optionalNumber(item.stars) !== undefined ? { stars: optionalNumber(item.stars) } : {}),
      ...(optionalNumber(item.downloads) !== undefined ? { downloads: optionalNumber(item.downloads) } : {}),
      ...(optionalString(item.category) ? { category: optionalString(item.category) } : {}),
      ...(optionalString(item.homepage) ? { homepage: optionalString(item.homepage) } : {}),
      ...(labels.requires_api_key === 'true' ? { requiresKey: true } : {}),
      installed: false,
    }
    entries.push(markInstalled(view, installed))
  }
  return entries
}

async function searchSkillHub(
  query: string,
  limit: number,
  installed: Set<string>,
  fetchImpl: FetchLike,
): Promise<SkillMarketListView> {
  const url = new URL(SKILLHUB_SEARCH_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`SkillHub 搜索失败：HTTP ${response.status}`)
  const payload: unknown = await response.json()
  const entries = parseSkillHubSearch(payload, installed)
  return {
    provider: 'skillhub',
    entries,
    ...(typeof (payload as { total?: unknown }).total === 'number'
      ? { total: (payload as { total: number }).total }
      : {}),
  }
}

// ─── SkillsMP (remote MCP, JSON-RPC over HTTP) ───

export function parseSkillsMpSearch(payload: unknown, installed: Set<string>): SkillMarketEntryView[] {
  const skills =
    payload && typeof payload === 'object' && Array.isArray((payload as { skills?: unknown }).skills)
      ? ((payload as { skills: unknown[] }).skills as unknown[])
      : []
  const entries: SkillMarketEntryView[] = []
  for (const raw of skills) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = optionalString(item.id)
    const name = optionalString(item.name)
    if (!id || !name) continue
    const view: SkillMarketEntryView = {
      id,
      provider: 'skillsmp',
      name,
      description: truncate(item.description),
      ...(optionalString(item.author) ? { author: optionalString(item.author) } : {}),
      ...(optionalNumber(item.stars) !== undefined ? { stars: optionalNumber(item.stars) } : {}),
      ...(optionalString(item.githubUrl) ? { sourceUrl: optionalString(item.githubUrl) } : {}),
      ...(optionalString(item.skillUrl) ? { homepage: optionalString(item.skillUrl) } : {}),
      installed: false,
    }
    entries.push(markInstalled(view, installed))
  }
  return entries
}

type FetchLike = typeof fetch

interface RpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  error?: { code?: number; message?: string; data?: unknown }
}

function rpcPayload(text: string): RpcResponse | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as RpcResponse
  // Streamable HTTP servers may answer with SSE frames.
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    try {
      return JSON.parse(data) as RpcResponse
    } catch {
      // Keep scanning frames.
    }
  }
  return null
}

async function callSkillsMpTool(tool: string, args: Record<string, unknown>, fetchImpl: FetchLike): Promise<unknown> {
  const apiKey = process.env.SKILLSMP_API_KEY?.trim()
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }

  const post = async (body: Record<string, unknown>, headers = baseHeaders): Promise<RpcResponse> => {
    const response = await fetchImpl(SKILLSMP_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`SkillsMP 请求失败：HTTP ${response.status}${detail ? ` ${truncate(detail, 200)}` : ''}`)
    }
    return rpcPayload(await response.text()) ?? {}
  }

  const initialize = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: SKILLSMP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'x-code-desktop', version: DESKTOP_VERSION },
    },
  })
  if (initialize.error) throw new Error(`SkillsMP 初始化失败：${initialize.error.message ?? 'unknown'}`)

  await fetchImpl(SKILLSMP_MCP_URL, {
    method: 'POST',
    headers: { ...baseHeaders, 'MCP-Protocol-Version': SKILLSMP_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)

  const response = await post(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
    { ...baseHeaders, 'MCP-Protocol-Version': SKILLSMP_PROTOCOL_VERSION },
  )
  if (response.error) throw new Error(`SkillsMP 错误：${response.error.message ?? 'unknown'}`)
  const content = response.result?.content ?? []
  const text = content.find((part) => part.type === 'text')?.text ?? ''
  if (response.result?.isError) throw new Error(`SkillsMP 错误：${truncate(text, 300)}`)
  if (!text) throw new Error('SkillsMP 返回了空响应')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('SkillsMP 返回了无法解析的内容')
  }
}

async function searchSkillsMp(
  query: string,
  limit: number,
  installed: Set<string>,
  fetchImpl: FetchLike,
): Promise<SkillMarketListView> {
  const payload = await callSkillsMpTool('search_skills', { query, limit }, fetchImpl)
  return { provider: 'skillsmp', entries: parseSkillsMpSearch(payload, installed) }
}

// ─── Public search API ───

export interface SearchSkillMarketOptions {
  fetchImpl?: FetchLike
}

export async function searchSkillMarket(
  provider: SkillMarketProvider,
  query: string,
  limit: number,
  installed: Set<string>,
  options: SearchSkillMarketOptions = {},
): Promise<SkillMarketListView> {
  const normalized = query.trim()
  if (!normalized) throw new Error('请输入搜索关键词')
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit) || 20))
  const key = `${provider}:${normalized.toLowerCase()}:${safeLimit}`
  const cached = searchCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return {
      ...cached.view,
      entries: cached.view.entries.map((entry) => markInstalled(entry, installed)),
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const view =
    provider === 'skillhub'
      ? await searchSkillHub(normalized, safeLimit, installed, fetchImpl)
      : await searchSkillsMp(normalized, safeLimit, installed, fetchImpl)
  searchCache.set(key, { at: Date.now(), view })
  return view
}

export function clearSkillMarketCache(): void {
  searchCache.clear()
}

// ─── Install ───

export function assertGitHubSkillUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('无效的 GitHub 技能地址')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('SkillsMP 技能只能从 github.com 安装')
  }
  if (!/^\/[^/]+\/[^/]+(?:\/tree\/[^/]+\/.+)?$/.test(url.pathname)) {
    throw new Error('无效的 GitHub 技能地址')
  }
  return `${url.origin}${url.pathname}`
}

/** Download a SkillHub zip, verify its shape, and copy the skill into the user
 *  skill directory. Never extracts outside the temp directory. */
export async function installSkillHubSkill(
  id: string,
  version: string | undefined,
  options: SearchSkillMarketOptions = {},
): Promise<CopiedSkill> {
  const { namespace, slug } = parseSkillHubId(id)
  const url = new URL(SKILLHUB_DOWNLOAD_URL)
  url.searchParams.set('slug', slug)
  if (namespace) url.searchParams.set('namespace', namespace)
  if (version?.trim()) url.searchParams.set('version', version.trim())
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`SkillHub 下载失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) throw new Error('技能包超过 20 MB')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_ZIP_BYTES) throw new Error('技能包超过 20 MB')
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('SkillHub 返回的不是 zip 技能包')
  }

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xcode-skillhub-'))
  try {
    await extractZipBuffer(buffer, temp)
    const skillRoot = await findSkillRoot(temp)
    if (!skillRoot) throw new Error('技能包中没有 SKILL.md')
    return await importSkillIntoUserDir(skillRoot)
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}

function safeEntryPath(root: string, name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return null
  const target = path.resolve(root, normalized)
  return target.startsWith(path.resolve(root) + path.sep) ? target : null
}

export async function extractZipBuffer(buffer: Buffer, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let files = 0
    let total = 0
    let archive: yauzl.ZipFile | null = null
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      try {
        archive?.close()
      } catch {
        // Already closed.
      }
      reject(error)
    }
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('无法读取 zip'))
        return
      }
      archive = zip
      zip.on('error', (zipError) => fail(zipError))
      zip.on('end', () => {
        if (settled) return
        settled = true
        resolve()
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        if (settled) return
        const target = safeEntryPath(targetDir, entry.fileName)
        if (!target) {
          fail(new Error(`技能包包含不安全的路径：${entry.fileName}`))
          return
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (mode === 0o120000) {
          fail(new Error(`技能包包含符号链接：${entry.fileName}`))
          return
        }
        if (entry.fileName.endsWith('/') || mode === 0o040000) {
          fs.promises
            .mkdir(target, { recursive: true })
            .then(() => zip.readEntry())
            .catch((mkdirError: unknown) => fail(mkdirError as Error))
          return
        }
        files += 1
        total += entry.uncompressedSize
        if (files > MAX_ZIP_FILES) {
          fail(new Error(`技能包文件数超过 ${MAX_ZIP_FILES}`))
          return
        }
        if (total > MAX_EXTRACTED_BYTES) {
          fail(new Error('技能包解压后超过 50 MB'))
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`无法读取 ${entry.fileName}`))
            return
          }
          void (async () => {
            try {
              await fs.promises.mkdir(path.dirname(target), { recursive: true })
              await pipeline(stream, fs.createWriteStream(target))
              zip.readEntry()
            } catch (writeError) {
              fail(writeError as Error)
            }
          })()
        })
      })
      zip.readEntry()
    })
  })
}

async function findSkillRoot(root: string): Promise<string | null> {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return root
  const entries = await fs.promises.readdir(root, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  const withSkill: string[] = []
  for (const dir of dirs) {
    const candidate = path.join(root, dir.name)
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) withSkill.push(candidate)
  }
  if (withSkill.length === 1) return withSkill[0]!
  if (withSkill.length > 1) throw new Error('技能包包含多个技能，无法确定要安装哪一个')
  return null
}
