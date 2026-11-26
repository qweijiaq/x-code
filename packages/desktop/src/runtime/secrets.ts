/**
 * 桌面应用的本地 API Key 存储。
 *
 * core 只从环境变量读取 API key。桌面设置面板把 key 持久化到
 * `~/.x-code/desktop-secrets.json`（mode 0600），并在构建 provider
 * 注册表之前注入到 `process.env`。renderer 只会看到已配置标志，以及
 * 已存储 key 的最后四个字符。
 *
 * 当 Electron 的 safeStorage（OS 钥匙串）可用时，值用它加密。在没有它的
 * 平台（例如没有 secret service 的 Linux）上，文件回退为 0600 的明文，
 * 设置 UI 会如此说明。旧的明文条目会在可能时于下一次加载迁移到 `enc`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PROVIDERS, WEB_SEARCH_PROVIDERS, acquireFileLock, debugLog, userXcodeDir } from '@x-code-cli/core'

import { requestMain } from './main-bridge.js'

interface StoredEntry {
  enc?: string
  plain?: string
}

interface SecretsFile {
  version?: number
  providers?: Record<string, StoredEntry | string>
  search?: Record<string, StoredEntry | string>
  baseUrls?: Record<string, string>
}

export type ApiKeySource = 'stored' | 'env' | 'none'

export interface ProviderSecretStatus {
  source: ApiKeySource
  hint?: string
  baseUrl?: string
}

export type SecretStorageKind = 'encrypted' | 'plain' | 'unknown'

export interface SecretCipher {
  available(): Promise<boolean>
  encrypt(text: string): Promise<string>
  decrypt(data: string): Promise<string>
}

const CUSTOM_ENV_KEY = 'OPENAI_COMPATIBLE_API_KEY'
const CUSTOM_BASE_URL_ENV = 'OPENAI_COMPATIBLE_BASE_URL'

const ENV_BY_PROVIDER = new Map<string, string>(PROVIDERS.map((provider) => [provider.name, provider.envKey]))
ENV_BY_PROVIDER.set('custom', CUSTOM_ENV_KEY)
const SEARCH_ENV_BY_PROVIDER = new Map<string, string>(
  WEB_SEARCH_PROVIDERS.filter((provider) => !provider.modelKeyOnly).map((provider) => [provider.id, provider.envKey]),
)

let originals: Map<string, string | undefined> | null = null

interface SecretsCache {
  providers: Map<string, string>
  search: Map<string, string>
  baseUrls: Map<string, string>
}

let cache: SecretsCache | null = null
let storageKind: SecretStorageKind = 'unknown'
let availableCache: boolean | null = null

const bridgeCipher: SecretCipher = {
  async available() {
    if (availableCache !== null) return availableCache
    try {
      const result = await requestMain<{ available: boolean }>('app:safe-storage-status', {})
      availableCache = result.available === true
    } catch {
      // 失败通常是暂时的（主桥尚未初始化 / IPC 超时）。绝不能把 false 缓存
      // 下来：之后每次 encodeEntry 都会退化成明文落盘，secretStorageKind()
      // 也会永久误报“平台不支持加密”。保持未知，下次重探。
      return false
    }
    return availableCache ?? false
  },
  async encrypt(text) {
    const result = await requestMain<{ available: boolean; data?: string }>('app:safe-storage-encrypt', {
      data: text,
    })
    if (!result.available || typeof result.data !== 'string') throw new Error('safeStorage is unavailable')
    return result.data
  },
  async decrypt(data) {
    const result = await requestMain<{ available: boolean; data?: string }>('app:safe-storage-decrypt', {
      data,
    })
    if (!result.available || typeof result.data !== 'string') throw new Error('safeStorage is unavailable')
    return result.data
  },
}

let cipher: SecretCipher = bridgeCipher

/** 测试接缝：替换 safeStorage 支撑的加密器（null 还原）。 */
export function setSecretCipher(next: SecretCipher | null): void {
  cipher = next ?? bridgeCipher
  availableCache = null
  cache = null
  storageKind = 'unknown'
}

/** 探测专用的临时路径；设置后所有读写都落到该文件，绝不触碰真实条目。 */
let secretsPathOverride: string | null = null

function secretsPath(): string {
  if (secretsPathOverride) return secretsPathOverride
  return path.join(userXcodeDir(), 'desktop-secrets.json')
}

/**
 * 多窗口并发保存不同 provider 时，read → encrypt → write 必须是一个
 * 跨进程原子段，否则后写会覆盖前写、丢掉刚保存的 key。
 */
async function withSecretsLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(secretsPath()), { recursive: true })
  const lease = await acquireFileLock(`${secretsPath()}.lock`, {
    waitMs: 3_000,
    retryMs: 25,
    staleMs: 15_000,
    timeoutError: 'secrets-busy',
  })
  if (!lease) throw new Error('secrets-busy')
  try {
    return await fn()
  } finally {
    await lease.release()
  }
}

function emptySecrets(): SecretsFile {
  return { version: 1, providers: {}, search: {}, baseUrls: {} }
}

/** 损坏的文件只搬走一份备份，绝不静默丢弃：调用方（saveProviderKey 等）会
 *  以这里返回的空快照整体重写文件，用户的记录只能靠 `.bak` 找回。 */
function quarantineCorruptSecrets(file: string, reason: unknown): void {
  debugLog('secrets.corrupt', reason instanceof Error ? reason.message : String(reason))
  try {
    let backup = `${file}.bak`
    for (let index = 1; fs.existsSync(backup) && index < 100; index++) backup = `${file}.bak-${index}`
    fs.renameSync(file, backup)
  } catch (error) {
    debugLog('secrets.corrupt-backup-failed', error instanceof Error ? error.message : String(error))
  }
}

function readRaw(): SecretsFile {
  const file = secretsPath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return emptySecrets()
    // EACCES / EBUSY / EIO 等：读不到 ≠ 空文件。抛错让写路径放弃落盘，
    // 否则下一次保存会以空快照覆盖掉用户全部已存条目。
    debugLog('secrets.read-failed', code ?? String(error))
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    quarantineCorruptSecrets(file, error)
    return emptySecrets()
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const data = parsed as SecretsFile
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      providers:
        data.providers && typeof data.providers === 'object' && !Array.isArray(data.providers) ? data.providers : {},
      search: data.search && typeof data.search === 'object' && !Array.isArray(data.search) ? data.search : {},
      baseUrls:
        data.baseUrls && typeof data.baseUrls === 'object' && !Array.isArray(data.baseUrls) ? data.baseUrls : {},
    }
  }
  // 合法 JSON 但不是对象（例如被写成了 `null` 或数组）：同样按损坏处理。
  quarantineCorruptSecrets(file, 'secrets file is not a JSON object')
  return emptySecrets()
}

function writeRaw(data: SecretsFile): void {
  const file = secretsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, ...data }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
}

async function encodeEntry(value: string): Promise<StoredEntry> {
  try {
    if (await cipher.available()) return { enc: await cipher.encrypt(value) }
  } catch {
    // 加密失败时回退到明文（仍为 0600）。
  }
  return { plain: value }
}

function captureOriginals(): void {
  if (originals) return
  originals = new Map()
  for (const envKey of ENV_BY_PROVIDER.values()) originals.set(envKey, process.env[envKey])
  for (const envKey of SEARCH_ENV_BY_PROVIDER.values()) originals.set(envKey, process.env[envKey])
  originals.set(CUSTOM_BASE_URL_ENV, process.env[CUSTOM_BASE_URL_ENV])
}

function envKeyFor(provider: string): string | undefined {
  return ENV_BY_PROVIDER.get(provider)
}

function maskHint(key: string): string | undefined {
  return key.length >= 4 ? `••••${key.slice(-4)}` : undefined
}

async function decodeEntries(
  entries: Record<string, StoredEntry | string> | undefined,
  allowed: Map<string, string> | null,
): Promise<{ values: Map<string, string>; next: Record<string, StoredEntry>; migrated: boolean }> {
  const values = new Map<string, string>()
  const next: Record<string, StoredEntry> = {}
  let migrated = false
  for (const [id, entry] of Object.entries(entries ?? {})) {
    if (allowed && !allowed.has(id)) continue
    let value: string | null = null
    if (typeof entry === 'string') {
      value = entry
      const encoded = await encodeEntry(entry)
      next[id] = encoded
      migrated = migrated || encoded.enc !== undefined
    } else if (entry && typeof entry === 'object') {
      if (typeof entry.enc === 'string') {
        next[id] = entry
        try {
          value = await cipher.decrypt(entry.enc)
        } catch {
          value = null
        }
      } else if (typeof entry.plain === 'string') {
        value = entry.plain
        const encoded = await encodeEntry(entry.plain)
        next[id] = encoded
        migrated = migrated || encoded.enc !== undefined
      }
    }
    if (value && value.trim()) values.set(id, value.trim())
  }
  return { values, next, migrated }
}

/** 读取文件，解密条目，并在加密器可用时把旧的明文值迁移到
 *  `enc`。填充内存缓存。 */
export async function loadSecrets(): Promise<void> {
  // 读取失败不能让启动挂掉；本次会话以空缓存继续（本次不会写盘，文件保持原样，
  // 用户去设置页保存时会拿到明确错误而不是静默清空）。损坏文件的处理见 readRaw。
  let raw: SecretsFile
  try {
    raw = readRaw()
  } catch (error) {
    debugLog('secrets.load-failed', error instanceof Error ? error.message : String(error))
    raw = emptySecrets()
  }
  const canEncrypt = await cipher.available().catch(() => false)
  storageKind = canEncrypt ? 'encrypted' : 'plain'
  const baseUrls = new Map<string, string>()
  for (const [key, value] of Object.entries(raw.baseUrls ?? {})) {
    if (typeof value === 'string' && value.trim()) baseUrls.set(key, value)
  }

  const providersDecoded = await decodeEntries(raw.providers, ENV_BY_PROVIDER)
  const providers = providersDecoded.values
  const searchDecoded = await decodeEntries(raw.search, SEARCH_ENV_BY_PROVIDER)
  const search = searchDecoded.values

  // 旧版本可能存入了中文/Markdown/带换行的“Key”。它们会让任何请求的
  // Authorization header 在 undici 里抛 ByteString 错误；加载时直接忽略，
  // 让设置页显示未配置，用户重新粘贴有效 Key 即可。
  const invalid: string[] = []
  for (const [provider, key] of [...providers]) {
    if (!apiKeyProblem(key)) continue
    providers.delete(provider)
    invalid.push(`provider:${provider}`)
  }
  for (const [provider, key] of [...search]) {
    if (!apiKeyProblem(key, '搜索 API Key')) continue
    search.delete(provider)
    invalid.push(`search:${provider}`)
  }
  if (invalid.length > 0) debugLog('secrets.invalid-key', invalid.join(','))

  cache = { providers, search, baseUrls }
  if (providersDecoded.migrated || searchDecoded.migrated) {
    await persistMigration(providersDecoded.next, searchDecoded.next)
  }
}

/** 把明文条目迁移成密文。必须与其它写入共享同一把锁，否则基于旧快照的
 *  写入会抹掉另一个窗口刚保存的 Key；同时在锁内重读，只替换已迁移的条目，
 *  白名单外的历史条目（未知 provider、modelKeyOnly 搜索源等）保持原样。 */
async function persistMigration(
  providers: Record<string, StoredEntry>,
  search: Record<string, StoredEntry>,
): Promise<void> {
  try {
    await withSecretsLock(async () => {
      const current = readRaw()
      writeRaw({
        providers: { ...(current.providers ?? {}), ...providers },
        search: { ...(current.search ?? {}), ...search },
        baseUrls: current.baseUrls ?? {},
      })
    })
  } catch (error) {
    debugLog('secrets.migrate-failed', error instanceof Error ? error.message : String(error))
  }
}

async function ensureLoaded(): Promise<SecretsCache> {
  if (!cache) await loadSecrets()
  return cache ?? { providers: new Map(), search: new Map(), baseUrls: new Map() }
}

/** 把存储的 key 注入环境变量。在加载工作区 `.env` 之后、
 *  provider 发现之前调用。 */
export async function applyStoredSecrets(): Promise<void> {
  captureOriginals()
  const loaded = await ensureLoaded()
  for (const [provider, key] of loaded.providers) {
    const envKey = envKeyFor(provider)
    if (envKey && key.trim()) process.env[envKey] = key.trim()
  }
  for (const [provider, key] of loaded.search) {
    const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
    if (envKey && key.trim()) process.env[envKey] = key.trim()
  }
  const customBaseUrl = loaded.baseUrls.get('custom')
  if (customBaseUrl) process.env[CUSTOM_BASE_URL_ENV] = customBaseUrl
}

export function searchSecretStatus(provider: string): ProviderSecretStatus {
  const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
  if (!envKey) return { source: 'none' }
  const stored = cache?.search.get(provider)
  if (stored) return { source: 'stored', hint: maskHint(stored) }
  if (process.env[envKey]) return { source: 'env' }
  return { source: 'none' }
}

const API_KEY_MAX_LENGTH = 8_192

/** 返回 Key 不适合放进 HTTP header 的原因；null 表示可用。 */
export function apiKeyProblem(key: string, label = 'API Key'): string | null {
  const trimmed = key.trim()
  if (!trimmed) return `${label} 不能为空`
  if (trimmed.length > API_KEY_MAX_LENGTH) return `${label} 过长（超过 ${API_KEY_MAX_LENGTH} 个字符）`
  if (trimmed.includes('```')) return `${label} 不能是 Markdown 代码块；请只粘贴服务商提供的 Key`
  for (let index = 0; index < trimmed.length; index++) {
    const code = trimmed.charCodeAt(index)
    if (code >= 0x21 && code <= 0x7e) continue
    const char = trimmed[index] ?? ''
    const shown = code >= 0x20 && code < 0x7f ? char : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
    return `${label} 只能包含 ASCII 可见字符；第 ${index + 1} 个字符是 ${shown}。请只粘贴服务商提供的 Key，不要带空格、换行、中文或 Markdown`
  }
  return null
}

export function validateApiKey(key: string, label = 'API Key'): string {
  const problem = apiKeyProblem(key, label)
  if (problem) throw new Error(problem)
  return key.trim()
}

export async function saveSearchKey(provider: string, key: string): Promise<void> {
  const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
  if (!envKey) throw new Error(`未知的搜索服务: ${provider}`)
  const trimmed = validateApiKey(key, '搜索 API Key')
  captureOriginals()
  const loaded = await ensureLoaded()
  await withSecretsLock(async () => {
    const raw = readRaw()
    const nextSearch: Record<string, StoredEntry> = {}
    for (const [name, entry] of Object.entries(raw.search ?? {})) {
      if (typeof entry === 'string') nextSearch[name] = await encodeEntry(entry)
      else if (entry && typeof entry === 'object') nextSearch[name] = entry
    }
    nextSearch[provider] = await encodeEntry(trimmed)
    writeRaw({ providers: raw.providers ?? {}, search: nextSearch, baseUrls: raw.baseUrls ?? {} })
  })
  loaded.search.set(provider, trimmed)
  process.env[envKey] = trimmed
}

export async function clearSearchKey(provider: string): Promise<void> {
  const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
  if (!envKey) throw new Error(`未知的搜索服务: ${provider}`)
  const loaded = await ensureLoaded()
  await withSecretsLock(async () => {
    const raw = readRaw()
    const nextSearch = { ...(raw.search ?? {}) }
    delete nextSearch[provider]
    writeRaw({ providers: raw.providers ?? {}, search: nextSearch, baseUrls: raw.baseUrls ?? {} })
  })
  loaded.search.delete(provider)

  captureOriginals()
  const original = originals?.get(envKey)
  if (original === undefined) delete process.env[envKey]
  else process.env[envKey] = original
}

export function secretStorageKind(): SecretStorageKind {
  return storageKind
}

export function providerSecretStatus(provider: string): ProviderSecretStatus {
  const envKey = envKeyFor(provider)
  const loaded = cache
  const stored = loaded?.providers.get(provider)
  const baseUrl = provider === 'custom' ? loaded?.baseUrls.get('custom') : undefined
  if (stored) {
    return { source: 'stored', hint: maskHint(stored), baseUrl }
  }
  if (envKey && process.env[envKey]) {
    return {
      source: 'env',
      baseUrl: provider === 'custom' ? (baseUrl ?? process.env[CUSTOM_BASE_URL_ENV]) : undefined,
    }
  }
  return { source: 'none', baseUrl: provider === 'custom' ? (baseUrl ?? process.env[CUSTOM_BASE_URL_ENV]) : undefined }
}

/** 供主进程侧调用（例如模型发现）读取解密后的 key；绝不暴露给 renderer。 */
export function providerSecretValue(provider: string): string | undefined {
  const stored = cache?.providers.get(provider)
  if (stored) return stored
  const envKey = envKeyFor(provider)
  return envKey ? process.env[envKey] : undefined
}

export async function saveProviderKey(provider: string, key: string, baseUrl?: string): Promise<void> {
  if (!envKeyFor(provider)) throw new Error(`未知的 provider: ${provider}`)
  const trimmed = validateApiKey(key)
  captureOriginals()
  const loaded = await ensureLoaded()
  await withSecretsLock(async () => {
    const raw = readRaw()
    const nextEntries: Record<string, StoredEntry> = {}
    for (const [name, entry] of Object.entries(raw.providers ?? {})) {
      if (typeof entry === 'string') nextEntries[name] = await encodeEntry(entry)
      else if (entry && typeof entry === 'object') nextEntries[name] = entry
    }
    nextEntries[provider] = await encodeEntry(trimmed)
    const nextBaseUrls = { ...(raw.baseUrls ?? {}) }
    if (provider === 'custom' && baseUrl?.trim()) nextBaseUrls.custom = baseUrl.trim()
    writeRaw({ providers: nextEntries, search: raw.search ?? {}, baseUrls: nextBaseUrls })
  })

  loaded.providers.set(provider, trimmed)
  if (provider === 'custom' && baseUrl?.trim()) loaded.baseUrls.set('custom', baseUrl.trim())
  process.env[envKeyFor(provider)!] = trimmed
  if (provider === 'custom' && baseUrl?.trim()) process.env[CUSTOM_BASE_URL_ENV] = baseUrl.trim()
}

export async function saveCustomBaseUrl(baseUrl: string): Promise<void> {
  const trimmed = baseUrl.trim()
  if (!trimmed) throw new Error('Base URL 不能为空')
  captureOriginals()
  const loaded = await ensureLoaded()
  await withSecretsLock(async () => {
    const raw = readRaw()
    const nextBaseUrls = { ...(raw.baseUrls ?? {}), custom: trimmed }
    writeRaw({ providers: raw.providers ?? {}, search: raw.search ?? {}, baseUrls: nextBaseUrls })
  })
  loaded.baseUrls.set('custom', trimmed)
  process.env[CUSTOM_BASE_URL_ENV] = trimmed
}

export async function clearProviderKey(provider: string): Promise<void> {
  const envKey = envKeyFor(provider)
  if (!envKey) throw new Error(`未知的 provider: ${provider}`)
  const loaded = await ensureLoaded()
  await withSecretsLock(async () => {
    const raw = readRaw()
    const nextEntries = { ...(raw.providers ?? {}) }
    delete nextEntries[provider]
    const nextBaseUrls = { ...(raw.baseUrls ?? {}) }
    if (provider === 'custom') delete nextBaseUrls.custom
    writeRaw({ providers: nextEntries, search: raw.search ?? {}, baseUrls: nextBaseUrls })
  })

  loaded.providers.delete(provider)
  if (provider === 'custom') loaded.baseUrls.delete('custom')

  captureOriginals()
  const original = originals?.get(envKey)
  if (original === undefined) delete process.env[envKey]
  else process.env[envKey] = original
  if (provider === 'custom') {
    const originalBase = originals?.get(CUSTOM_BASE_URL_ENV)
    if (originalBase === undefined) delete process.env[CUSTOM_BASE_URL_ENV]
    else process.env[CUSTOM_BASE_URL_ENV] = originalBase
  }
}

/** 冒烟探测：保存一个值，验证文件持有密文（当加密可用时），
 *  通过正常路径读回，然后清除。
 *
 *  整个过程只作用于一次性的临时 secrets 文件：旧实现在真实的
 *  `desktop-secrets.json` 上 save → 读 → clear，等于跑一次体检就把用户
 *  已保存的 Anthropic Key 覆盖成探测值、再整条删除（连 env 一起清掉）。
 *  现在改成隔离路径 + 直接走 `encodeEntry`/`decodeEntries`，
 *  既不写用户的文件，也不改内存缓存和 `process.env`。 */
export async function secretRoundTripProbe(): Promise<{
  available: boolean
  encrypted: boolean
  roundTrip: boolean
}> {
  const value = `smoke-secret-${Date.now()}`
  const available = await cipher.available().catch(() => false)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-secret-probe-'))
  const previousOverride = secretsPathOverride
  secretsPathOverride = path.join(dir, 'desktop-secrets.json')
  try {
    writeRaw({ providers: { anthropic: await encodeEntry(value) }, search: {}, baseUrls: {} })
    let encrypted = false
    try {
      const raw = fs.readFileSync(secretsPath(), 'utf8')
      encrypted = available && !raw.includes(value) && raw.includes('"enc"')
    } catch {
      encrypted = false
    }
    const decoded = await decodeEntries(readRaw().providers, ENV_BY_PROVIDER)
    const roundTrip = decoded.values.get('anthropic') === value
    return { available, encrypted, roundTrip }
  } finally {
    secretsPathOverride = previousOverride
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
