// @x-code-cli/core — OpenAI-compatible 模型发现
//
// 自定义端点不再要求用户手填模型 ID：用 base URL + API key 请求 `/models`，
// 让用户从返回的列表里选择。这里只处理最常见的 OpenAI 形状，同时兼容
// `{ data: [...] }`、`{ models: [...] }` 和纯数组三种返回。
//
// 请求走 providerFetch：它会启用 autoSelectFamily，并在检测到系统代理时
// 使用代理。OpenDesign 的 amr-link 域名直连不稳定，走系统代理正常。
import { providerFetch } from './network.js'

export interface ModelDiscoveryOptions {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const MODEL_LIST_SUFFIXES = ['/chat/completions', '/responses', '/messages'] as const

/** 把用户填写的 base URL 规范化成模型列表端点。
 *
 *  接受 `https://host`、`https://host/v1`，也接受误填的
 *  `https://host/v1/chat/completions` / `/responses` / `/messages`。 */
export function normalizeModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https')
  }
  url.search = ''
  url.hash = ''
  let pathname = url.pathname.replace(/\/+$/, '')
  for (const suffix of MODEL_LIST_SUFFIXES) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length)
      break
    }
  }
  if (!pathname.endsWith('/models')) pathname = `${pathname}/models`
  url.pathname = pathname.replace(/\/{2,}/g, '/')
  return url.toString()
}

function extractModelIds(payload: unknown): string[] {
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? [(payload as { data?: unknown }).data, (payload as { models?: unknown }).models]
      : []
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const entry of candidate) {
      if (typeof entry === 'string') {
        if (entry.trim()) ids.add(entry.trim())
        continue
      }
      if (entry && typeof entry === 'object') {
        const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name
        if (typeof id === 'string' && id.trim()) ids.add(id.trim())
      }
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}

/** 请求 OpenAI-compatible `/models`，返回排序后的模型 id。 */
export async function listOpenAICompatibleModels(options: ModelDiscoveryOptions): Promise<string[]> {
  const url = normalizeModelsUrl(options.baseUrl)
  const headers: Record<string, string> = { Accept: 'application/json' }
  const apiKey = options.apiKey?.trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const fetcher = options.fetchImpl ?? providerFetch
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法连接模型列表端点：${reason}`)
  }

  if (!response.ok) {
    throw new Error(`模型列表请求失败：HTTP ${response.status} ${response.statusText}`.trim())
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('模型列表返回的不是有效 JSON')
  }
  const models = extractModelIds(payload)
  if (models.length === 0) {
    throw new Error('模型列表为空，请确认 Base URL 和 Key 是否正确')
  }
  return models
}
