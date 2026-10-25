/**
 * Local API-key storage for the desktop app.
 *
 * Core reads API keys only from environment variables. The desktop settings
 * panel persists keys in `~/.x-code/desktop-secrets.json` (mode 0600) and
 * injects them into `process.env` before the provider registry is built. The
 * renderer only ever sees a configured flag and, for stored keys, the last four
 * characters.
 *
 * Values are encrypted with Electron's safeStorage (OS keychain) when it is
 * available. On platforms without it (e.g. Linux without a secret service) the
 * file falls back to plaintext with 0600 and the settings UI says so. Legacy
 * plaintext entries are migrated to `enc` on the next load when possible.
 */
import fs from 'node:fs'
import path from 'node:path'

import { PROVIDERS, WEB_SEARCH_PROVIDERS, userXcodeDir } from '@x-code-cli/core'

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
      availableCache = false
    }
    return availableCache
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

/** Test seam: replace the safeStorage-backed cipher (null restores it). */
export function setSecretCipher(next: SecretCipher | null): void {
  cipher = next ?? bridgeCipher
  availableCache = null
  cache = null
  storageKind = 'unknown'
}

function secretsPath(): string {
  return path.join(userXcodeDir(), 'desktop-secrets.json')
}

function readRaw(): SecretsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath(), 'utf-8')) as unknown
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
  } catch {
    // Missing or malformed secrets file.
  }
  return { version: 1, providers: {}, search: {}, baseUrls: {} }
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
    // Fall back to plaintext (still 0600) when encryption fails.
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

/** Read the file, decrypt entries, and migrate legacy plaintext values to
 *  `enc` when the cipher is available. Populates the in-memory cache. */
export async function loadSecrets(): Promise<void> {
  const raw = readRaw()
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

  cache = { providers, search, baseUrls }
  if (providersDecoded.migrated || searchDecoded.migrated) {
    writeRaw({
      providers: providersDecoded.next,
      search: searchDecoded.next,
      baseUrls: Object.fromEntries(baseUrls),
    })
  }
}

async function ensureLoaded(): Promise<SecretsCache> {
  if (!cache) await loadSecrets()
  return cache ?? { providers: new Map(), search: new Map(), baseUrls: new Map() }
}

/** Inject stored keys into the environment. Call after loading the workspace
 *  `.env` and before provider discovery. */
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

export async function saveSearchKey(provider: string, key: string): Promise<void> {
  const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
  if (!envKey) throw new Error(`未知的搜索服务: ${provider}`)
  const trimmed = key.trim()
  if (!trimmed) throw new Error('API Key 不能为空')
  captureOriginals()
  const loaded = await ensureLoaded()
  const raw = readRaw()
  const nextSearch: Record<string, StoredEntry> = {}
  for (const [name, entry] of Object.entries(raw.search ?? {})) {
    if (typeof entry === 'string') nextSearch[name] = await encodeEntry(entry)
    else if (entry && typeof entry === 'object') nextSearch[name] = entry
  }
  nextSearch[provider] = await encodeEntry(trimmed)
  writeRaw({ providers: raw.providers ?? {}, search: nextSearch, baseUrls: raw.baseUrls ?? {} })
  loaded.search.set(provider, trimmed)
  process.env[envKey] = trimmed
}

export async function clearSearchKey(provider: string): Promise<void> {
  const envKey = SEARCH_ENV_BY_PROVIDER.get(provider)
  if (!envKey) throw new Error(`未知的搜索服务: ${provider}`)
  const loaded = await ensureLoaded()
  const raw = readRaw()
  const nextSearch = { ...(raw.search ?? {}) }
  delete nextSearch[provider]
  writeRaw({ providers: raw.providers ?? {}, search: nextSearch, baseUrls: raw.baseUrls ?? {} })
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

export async function saveProviderKey(provider: string, key: string, baseUrl?: string): Promise<void> {
  if (!envKeyFor(provider)) throw new Error(`未知的 provider: ${provider}`)
  const trimmed = key.trim()
  if (!trimmed) throw new Error('API Key 不能为空')
  captureOriginals()
  const loaded = await ensureLoaded()
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
  const raw = readRaw()
  const nextBaseUrls = { ...(raw.baseUrls ?? {}), custom: trimmed }
  writeRaw({ providers: raw.providers ?? {}, search: raw.search ?? {}, baseUrls: nextBaseUrls })
  loaded.baseUrls.set('custom', trimmed)
  process.env[CUSTOM_BASE_URL_ENV] = trimmed
}

export async function clearProviderKey(provider: string): Promise<void> {
  const envKey = envKeyFor(provider)
  if (!envKey) throw new Error(`未知的 provider: ${provider}`)
  const loaded = await ensureLoaded()
  const raw = readRaw()
  const nextEntries = { ...(raw.providers ?? {}) }
  delete nextEntries[provider]
  const nextBaseUrls = { ...(raw.baseUrls ?? {}) }
  if (provider === 'custom') delete nextBaseUrls.custom
  writeRaw({ providers: nextEntries, search: raw.search ?? {}, baseUrls: nextBaseUrls })

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

/** Smoke probe: save a value, verify the file holds ciphertext (when
 *  encryption is available), read it back through the normal path, and clear. */
export async function secretRoundTripProbe(): Promise<{
  available: boolean
  encrypted: boolean
  roundTrip: boolean
}> {
  const value = `smoke-secret-${Date.now()}`
  const available = await cipher.available().catch(() => false)
  await saveProviderKey('anthropic', value)
  let encrypted = false
  try {
    const raw = fs.readFileSync(secretsPath(), 'utf8')
    encrypted = available && !raw.includes(value) && raw.includes('"enc"')
  } catch {
    encrypted = false
  }
  const status = providerSecretStatus('anthropic')
  const roundTrip =
    status.source === 'stored' && status.hint === maskHint(value) && process.env.ANTHROPIC_API_KEY === value
  await clearProviderKey('anthropic')
  return { available, encrypted, roundTrip }
}
