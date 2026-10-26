// @x-code-cli/core — webSearch 工具（多 provider）。
//
// Provider 顺序：显式的 X_CODE_WEB_SEARCH_PROVIDER 覆盖，然后是
// SEARCH_PROVIDERS 顺序里第一个已配置密钥的 provider，再然后 —— 仅当当前
// 模型跑在专门的 `deepseek` provider 上时 —— DeepSeek 内建的服务端网页搜索。
// 把 DeepSeek 模型经 OpenAI 兼容的自定义端点路由*不会*触发这个回退（provider
// id 不同）。provider 之间没有运行时故障转移：一个配置好的 provider 出错时
// 会报告错误，而不是悄悄去扣另一个 key。
import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getShellProvider } from './shell-provider.js'

const YEAR = new Date().getFullYear()
const SEARCH_TIMEOUT_MS = 15_000
// DeepSeek 搜索是服务端的一次完整模型轮次，不是普通查询，所以它需要比
// REST 搜索 API 宽得多的预算。
const DEEPSEEK_TIMEOUT_MS = 60_000

interface SearchResult {
  title: string
  url: string
  content: string
}

interface ProviderResponse {
  answer?: string
  results: SearchResult[]
}

interface WebSearchProvider {
  id: string
  label: string
  envKey: string
  signup: string
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse>
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// HTTP 错误正文携带可行动的提示（"model not found"、"invalid api key"）；
// 只有 statusText 会让 provider 故障无法排查。
async function httpError(label: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new Error(`${label} API returned HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
}

async function searchWithTavily(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  // 直接使用 Tavily 的小型 REST 接口。SDK 会把 axios 加完整的 js-tiktoken 表
  // 拉进 CLI 包里，尽管基础搜索两者都不需要；直接 fetch 还能让 Esc 立即
  // 取消请求。
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY!}`,
      'Content-Type': 'application/json',
      'X-Client-Source': 'x-code-cli',
    },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Tavily', res)
  }

  const data = (await res.json()) as { results?: SearchResult[] }
  return { results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content })) }
}

async function searchWithBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 20)))

  const res = await fetch(url, {
    headers: {
      'X-Subscription-Token': process.env.BRAVE_API_KEY!,
      Accept: 'application/json',
    },
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Brave', res)
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }
  return {
    results: (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.description })),
  }
}

async function searchWithExa(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.EXA_API_KEY!}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: maxResults,
      contents: { highlights: { highlightsPerUrl: 1 } },
    }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Exa', res)
  }

  const data = (await res.json()) as {
    results?: Array<{ url?: string; title?: string; highlights?: string[] }>
  }
  return {
    results: (data.results ?? [])
      .filter((r) => !!r.url)
      .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.highlights?.[0] ?? '' })),
  }
}

async function searchWithPerplexity(
  query: string,
  _maxResults: number,
  signal?: AbortSignal,
): Promise<ProviderResponse> {
  // Sonar 是一个 chat-completions 端点，会自己把答案落地：它返回散文加
  // 结构化来源，而不是原始命中。
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY!}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // 若 Perplexity 弃用该 id 或出现更便宜的搜索模型，可覆盖。
      model: process.env.PERPLEXITY_SEARCH_MODEL || 'sonar',
      max_tokens: 1024,
      messages: [{ role: 'user', content: query }],
    }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Perplexity', res)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    search_results?: Array<{ url?: string; title?: string; snippet?: string }>
    citations?: string[]
  }
  const answer = data.choices?.[0]?.message?.content
  const results: SearchResult[] = data.search_results
    ? data.search_results
        .filter((r) => !!r.url)
        .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.snippet ?? '' }))
    : // 较旧的响应只带 URL 列表，没有标题或摘要。
      (data.citations ?? []).map((url) => ({ title: url, url, content: '' }))
  return { answer, results }
}

async function searchWithFirecrawl(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, limit: maxResults }),
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('Firecrawl', res)
  }

  const data = (await res.json()) as {
    data?: { web?: Array<{ url?: string; title?: string; description?: string }> }
  }
  return {
    results: (data.data?.web ?? [])
      .filter((r) => !!r.url)
      .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.description ?? '' })),
  }
}

// DeepSeek 没有独立的搜索 API。网页搜索是它兼容 Anthropic 的 Messages 端点
// 上的一个服务端工具：请求声明 web_search_20250305，响应携带
// web_search_tool_result 块。每次搜索花费一次完整的（便宜的）模型轮次。
interface AnthropicContentBlock {
  type: string
  text?: string
  content?: Array<{ type?: string; url?: string; title?: string }> | { type?: string }
  citations?: Array<{ url?: string; cited_text?: string }>
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string
}

async function searchWithDeepseek(query: string, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY!
  // 接受带或不带 /v1 段的文档化 base（https://api.deepseek.com/anthropic），
  // 然后自己拼接剩余路径。
  const rawBase = (process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '')
  const messagesURL = rawBase.endsWith('/v1') ? `${rawBase}/messages` : `${rawBase}/v1/messages`
  const res = await fetch(messagesURL, {
    method: 'POST',
    headers: {
      // 官方 DeepSeek 期望 x-api-key；兼容 Anthropic 的代理期望
      // Authorization。两个都发，好让任意一条路由都能工作。
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // 每次搜索由一次完整的（便宜的）模型轮次驱动；若 DeepSeek 弃用该 id
      // 或出现更便宜的可搜索模型，可覆盖。
      model: process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      // 每次使用都在服务端计费，所以别授予比调用方请求结果数更多的搜索；
      // 上限 5，这样 maxResults=20 也保持便宜。
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(maxResults, 5) }],
    }),
    signal: withTimeout(signal, DEEPSEEK_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw await httpError('DeepSeek search', res)
  }

  const data = (await res.json()) as AnthropicMessagesResponse
  const blocks = data.content ?? []

  // 摘要不属于结果项；在 Anthropic 上它们作为单独文本块上的引文到达。
  // DeepSeek 的兼容性表把文本块引文标为 Ignored，所以针对官方端点这段拼接
  // 永远不会触发、contents 保持为空 —— 它是为确实会发出这些引文的
  // Anthropic 兼容代理（DEEPSEEK_SEARCH_BASE_URL）而存在的。每个 URL 以
  // 第一条引文为准。文本块本身是模型的落地摘要，作为 `answer` 呈现。
  const snippets = new Map<string, string>()
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
    for (const citation of block.citations ?? []) {
      if (citation.url && citation.cited_text && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text)
      }
    }
  }

  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const item of block.content) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      results.push({ title: item.title ?? item.url, url: item.url, content: snippets.get(item.url) ?? '' })
    }
  }

  // 严格模式：绝不从模型散文里抠 URL。如果服务端没有跑搜索，就如实说明，
  // 而不是返回一个看起来很自信的空列表。
  if (results.length === 0) {
    // 在第一个搜索块之前就被 max_tokens 截断，是预算问题而不是搜索被拒绝
    // —— 把这一点点明，让用户别排查错方向。
    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        'DeepSeek hit the max_tokens limit before returning any search result ' +
          '(the search turn is billed per token); retry with a narrower query',
      )
    }
    throw new Error('DeepSeek chose not to run a web search for this query (no web_search_tool_result block returned)')
  }
  return { answer: texts.join('\n\n') || undefined, results: results.slice(0, maxResults) }
}

const deepseekProvider: WebSearchProvider = {
  id: 'deepseek',
  label: 'DeepSeek built-in search',
  envKey: 'DEEPSEEK_API_KEY',
  signup: 'https://platform.deepseek.com',
  search: searchWithDeepseek,
}

// 自动选择的优先级顺序。DeepSeek 刻意不在这张列表里：它每次搜索计费一次
// 模型轮次，所以只作为 DeepSeek 模型用户的回退、或经显式覆盖才启用。
const SEARCH_PROVIDERS: WebSearchProvider[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    envKey: 'TAVILY_API_KEY',
    signup: 'https://tavily.com',
    search: searchWithTavily,
  },
  {
    id: 'brave',
    label: 'Brave',
    envKey: 'BRAVE_API_KEY',
    signup: 'https://api.search.brave.com',
    search: searchWithBrave,
  },
  {
    id: 'exa',
    label: 'Exa',
    envKey: 'EXA_API_KEY',
    signup: 'https://exa.ai',
    search: searchWithExa,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    envKey: 'PERPLEXITY_API_KEY',
    signup: 'https://www.perplexity.ai/settings/api',
    search: searchWithPerplexity,
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    envKey: 'FIRECRAWL_API_KEY',
    signup: 'https://firecrawl.dev',
    search: searchWithFirecrawl,
  },
]

const ALL_PROVIDERS: WebSearchProvider[] = [...SEARCH_PROVIDERS, deepseekProvider]

/** 供设置 UI 使用的公开元数据；不含搜索函数或密钥。 */
export interface WebSearchProviderInfo {
  id: string
  label: string
  envKey: string
  signup: string
  /** 使用当前模型的密钥（DeepSeek 内建搜索），而不是单独存储的搜索密钥。 */
  modelKeyOnly?: boolean
}

export const WEB_SEARCH_PROVIDERS: WebSearchProviderInfo[] = ALL_PROVIDERS.map((provider) => ({
  id: provider.id,
  label: provider.label,
  envKey: provider.envKey,
  signup: provider.signup,
  ...(provider.id === 'deepseek' ? { modelKeyOnly: true } : {}),
}))

/** 旁路通道：当前模型的 provider 名（modelId 按 ':' 切分）。每轮由 agent loop
 *  设置，与 setZhipuReasoningEffort 类似，让这个静态注册的工具能判断用户
 *  是否跑在 DeepSeek 上。 */
let currentModelProvider: string | undefined

export function setWebSearchModelProvider(provider: string | undefined): void {
  currentModelProvider = provider
}

type PickResult = { provider: WebSearchProvider } | { error: string } | { none: true }

function pickProvider(modelProvider: string | undefined): PickResult {
  const forced = process.env.X_CODE_WEB_SEARCH_PROVIDER?.trim().toLowerCase()
  if (forced) {
    const p = ALL_PROVIDERS.find((candidate) => candidate.id === forced)
    if (!p) {
      return {
        error:
          `Unknown web search provider "${forced}" in X_CODE_WEB_SEARCH_PROVIDER. ` +
          `Valid values: ${ALL_PROVIDERS.map((candidate) => candidate.id).join(', ')}.`,
      }
    }
    if (!process.env[p.envKey]) {
      return { error: `X_CODE_WEB_SEARCH_PROVIDER=${forced} is set but ${p.envKey} is missing.` }
    }
    return { provider: p }
  }
  for (const p of SEARCH_PROVIDERS) {
    if (process.env[p.envKey]) return { provider: p }
  }
  if (modelProvider === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    return { provider: deepseekProvider }
  }
  return { none: true }
}

/** 此刻一次 webSearch 调用会用哪个 provider，用于启动提示。显式传入已解析
 *  模型的 provider；否则回退到 loop 注入的旁路通道。 */
export function resolveWebSearchProvider(modelProvider?: string): { id: string; label: string } | null {
  const picked = pickProvider(modelProvider ?? currentModelProvider)
  return 'provider' in picked ? { id: picked.provider.id, label: picked.provider.label } : null
}

export interface WebSearchTestResult {
  ok: boolean
  provider: string
  results: number
  latencyMs: number
  message: string
}

/** 设置 UI 使用的在线探测。`key` 是尚未保存的草稿：只在请求期间放进环境里，
 *  好让 provider 函数保持不变。DeepSeek 会被拒绝 —— 它的搜索是一次计费的
 *  模型轮次，不是密钥检查。 */
export async function testWebSearchProvider(
  providerId: string,
  key?: string,
  signal?: AbortSignal,
): Promise<WebSearchTestResult> {
  const started = Date.now()
  const provider = SEARCH_PROVIDERS.find((candidate) => candidate.id === providerId)
  if (!provider) {
    return {
      ok: false,
      provider: providerId,
      results: 0,
      latencyMs: 0,
      message: `Unknown standalone search provider: ${providerId}`,
    }
  }
  const draft = key?.trim()
  const previous = process.env[provider.envKey]
  if (draft) process.env[provider.envKey] = draft
  if (!process.env[provider.envKey]) {
    return {
      ok: false,
      provider: provider.label,
      results: 0,
      latencyMs: 0,
      message: `${provider.envKey} is not configured`,
    }
  }
  try {
    const response = await provider.search('x-code search connection test', 1, signal)
    return {
      ok: true,
      provider: provider.label,
      results: response.results.length,
      latencyMs: Date.now() - started,
      message: `Connected to ${provider.label}`,
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(
      process.env[provider.envKey] ?? '',
      '••••',
    )
    return { ok: false, provider: provider.label, results: 0, latencyMs: Date.now() - started, message }
  } finally {
    if (draft) {
      if (previous === undefined) delete process.env[provider.envKey]
      else process.env[provider.envKey] = previous
    }
  }
}

function buildMissingKeyError(): string {
  const { type } = getShellProvider()
  let setupBlock: string

  if (type === 'powershell') {
    setupBlock = [
      '  # current session:',
      '  $env:TAVILY_API_KEY = "tvly-xxx"',
      '  # persistent (new shells):',
      '  [Environment]::SetEnvironmentVariable("TAVILY_API_KEY","tvly-xxx","User")',
    ].join('\n')
  } else {
    const rc = type === 'zsh' ? '~/.zshrc' : '~/.bashrc'
    setupBlock = [
      '  # current session:',
      '  export TAVILY_API_KEY="tvly-xxx"',
      '  # persistent (new shells):',
      `  echo 'export TAVILY_API_KEY="tvly-xxx"' >> ${rc}`,
    ].join('\n')
  }

  return [
    'Error: WebSearch requires a search API key. Options (set any one):',
    '',
    '  Desktop app: Settings → Tools → Search service → paste a key (applies immediately).',
    '  CLI: export one of the variables below and restart the shell.',
    '',
    '  1. Tavily     — 1000 searches/month free, recommended',
    '     Sign up: https://tavily.com → copy API key from dashboard (TAVILY_API_KEY)',
    '',
    '  2. Brave      — paid, $5 free credit (BRAVE_API_KEY, https://api.search.brave.com)',
    '  3. Exa        — 1000 requests/month free (EXA_API_KEY, https://exa.ai)',
    '  4. Perplexity — paid Sonar API (PERPLEXITY_API_KEY, https://www.perplexity.ai/settings/api)',
    '  5. Firecrawl  — free credits tier (FIRECRAWL_API_KEY, https://firecrawl.dev)',
    '',
    '  Using a DeepSeek model? No extra key needed — webSearch automatically uses',
    "  DeepSeek's built-in web search with your DEEPSEEK_API_KEY.",
    '',
    `Setup (${type}):`,
    setupBlock,
    '',
    'After setting, restart this shell for the variable to take effect.',
  ].join('\n')
}

function formatResults(response: ProviderResponse): string {
  const parts: string[] = []
  if (response.answer) parts.push(response.answer)
  if (response.results.length > 0) {
    parts.push(response.results.map((r) => `### ${r.title}\n${r.url}\n${r.content}`).join('\n\n'))
  }
  if (parts.length === 0) return 'No results found.'
  return parts.join('\n\n')
}

export const webSearch = tool({
  description:
    `Search the web for information. Useful for looking up documentation, error messages, or current information. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information ` +
    `(e.g. prefer "React 19 release notes ${YEAR}" over "React latest release notes").`,
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().int().min(1).max(20).optional().describe('Max results (default: 5, max: 20)'),
  }),
  // 每请求的模型 provider，经 streamText toolsContext 提供。这条通道对并发
  // 的子 agent loop 是竞态安全的；模块级 setWebSearchModelProvider 的值只是
  // 回退。
  contextSchema: z.object({ modelProvider: z.string().optional() }),
  execute: async ({ query, maxResults }, { toolCallId, abortSignal, context }) => {
    const n = maxResults ?? 5
    const picked = pickProvider(context?.modelProvider ?? currentModelProvider)

    if ('none' in picked) return buildMissingKeyError()
    if ('error' in picked) return `Error: ${picked.error}`

    const { provider } = picked
    reportProgress(toolCallId, `Searching (${provider.label}): ${query}`)
    try {
      const response = await provider.search(query, n, abortSignal)
      // 统一上限：有些 provider（Perplexity）无法在服务端限制结果数，所以
      // 在这里执行接缝级的边界。
      return formatResults({ ...response, results: response.results.slice(0, n) })
    } catch (err) {
      return formatToolError(`searching (${provider.label})`, err)
    }
  },
})
