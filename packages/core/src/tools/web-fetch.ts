// @x-code-cli/core — webFetch 工具（HTTP 抓取 + HTML→Markdown，带 LRU 缓存 + CF 回退）
import * as cheerio from 'cheerio'
// @ts-expect-error turndown has no types
import TurndownService from 'turndown'
import { Agent, fetch as undiciFetch } from 'undici'

import { lookup as dnsLookup } from 'node:dns'
import { BlockList, isIP } from 'node:net'

import { fetchWithValidatedRedirects } from '@ai-sdk/provider-utils'
import { tool } from 'ai'

import { z } from 'zod'

import { LruCache } from '../utils/lru-cache.js'
import { formatToolError } from '../utils/tool-errors.js'
import { VERSION } from '../version.js'
import { reportProgress } from './progress.js'

const FETCH_TIMEOUT_MS = 15_000
// 返回给模型的 Markdown。从 30 KB（会把文档页拦腰截断）往上调，但仍远低于
// 模型的上下文预算：约 100 KB ≈ 约 25 K token，大致是 Sonnet 200 K 窗口的
// 12%，所以单次抓取不可能撑爆上下文。
// 这是每次调用级别的上限；模型随时可以用更窄的 prompt 再抓一次。
const MAX_CONTENT_CHARS = 100_000
// turndown 之前的原始 HTML 上限。10 MB 对任何真实文档页都绰绰有余；同时由
// content-length 头和流式 body 读取（见 readResponseBody）双重执行，所以
// 分块响应也被限制住。
const MAX_HTTP_BYTES = 10 * 1024 * 1024
const MAX_URL_LENGTH = 2000
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// 用作 Cloudflare 回退：激进的机器人规则常常放行诚实的 CLI UA，而拦截那些
// 通不过 TLS 指纹校验的浏览器伪装者。
const FALLBACK_UA = `x-code-cli/${VERSION} (+https://github.com/qweijiaq/x-code)`

const YEAR = new Date().getFullYear()

// ── SSRF 防护 ──
// 拒绝指向内部/私有网络的 URL。对应 Claude Code 的 validateURL：hostname
// 必须至少有 2 个点分隔的段（拒绝 `localhost`、裸主机名），不能内嵌凭据，
// 不能是非 HTTP 协议，也不能是私有/链路本地/回环范围内的 IP。

const DISALLOWED_ADDRESSES = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  DISALLOWED_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['3fff::', 20],
] as const) {
  DISALLOWED_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}

DISALLOWED_ADDRESSES.addAddress('::', 'ipv6')
DISALLOWED_ADDRESSES.addAddress('::1', 'ipv6')

function isFakeIpAddress(address: string, family: number): boolean {
  if (family !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function isDisallowedAddress(address: string, family: number): boolean {
  if (family === 4) return isIP(address) !== 4 || DISALLOWED_ADDRESSES.check(address, 'ipv4')
  if (family === 6) return isIP(address) !== 6 || DISALLOWED_ADDRESSES.check(address, 'ipv6')
  return true
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true
  // URL 里的 IP 字面量 —— 去掉 IPv6 两侧的方括号
  const bare = lower.startsWith('[') ? lower.slice(1, -1) : lower
  const family = isIP(bare)
  return family !== 0 && isDisallowedAddress(bare, family)
}

/** @internal 仅为 DNS-guard 测试导出。 */
export function validateResolvedAddress(
  hostname: string,
  address: string,
  family: number,
  allowHttpsFakeIp = false,
): void {
  // Clash/Mihomo 的 fake-IP 模式刻意把公网主机名映射进 198.18.0.0/15，并
  // 把这些 socket 路由经过其 TUN 接口。只对 HTTPS 主机名放行这种合成地址。
  // IP 字面量 URL 仍会被 validateFetchUrl 拒绝，且每个重定向都会重新校验。
  if (allowHttpsFakeIp && isIP(hostname) === 0 && isFakeIpAddress(address, family)) return

  if (isDisallowedAddress(address, family)) {
    throw new Error(`Hostname ${hostname} resolved to disallowed IP address ${address}`)
  }
}

type LookupAddress = { address: string; family: number }
type LookupOptions = {
  all?: boolean
  family?: number
  hints?: number
  order?: 'ipv4first' | 'ipv6first' | 'verbatim'
  verbatim?: boolean
}
type LookupAllCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
type LookupOneCallback = (error: NodeJS.ErrnoException | null, address: string, family: number) => void
type Lookup = (hostname: string, options: LookupOptions & { all: true }, callback: LookupAllCallback) => void

function createValidatedLookup(allowHttpsFakeIp: boolean) {
  const lookupAll = dnsLookup as unknown as Lookup
  return (hostname: string, options: LookupOptions, callback: LookupAllCallback | LookupOneCallback): void => {
    lookupAll(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        const rejectLookup = callback as (error: NodeJS.ErrnoException) => void
        rejectLookup(error)
        return
      }

      try {
        const [firstAddress] = addresses
        if (!firstAddress) throw new Error(`Hostname ${hostname} did not resolve to an address`)
        for (const { address, family } of addresses) {
          validateResolvedAddress(hostname, address, family, allowHttpsFakeIp)
        }

        if (options.all === true) (callback as LookupAllCallback)(null, addresses)
        else (callback as LookupOneCallback)(null, firstAddress.address, firstAddress.family)
      } catch (error) {
        const rejectLookup = callback as (error: Error) => void
        rejectLookup(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

const strictAgent = new Agent({ connect: { lookup: createValidatedLookup(false) as never } })
const httpsFakeIpAgent = new Agent({ connect: { lookup: createValidatedLookup(true) as never } })

const fakeIpCompatibleFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
  const dispatcher = url.protocol === 'https:' ? httpsFakeIpAgent : strictAgent
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>
}

function isFakeIpDnsRejection(error: unknown): boolean {
  let current = error
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof Error) {
      if (/resolved to disallowed IP address 198\.(?:18|19)\./i.test(current.message)) return true
      current = current.cause
    } else {
      break
    }
  }
  return false
}

/** @internal 仅为测试导出。 */
export function validateFetchUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `URL exceeds ${MAX_URL_LENGTH} character limit`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Invalid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported protocol: ${parsed.protocol} (only http/https allowed)`
  }
  if (parsed.username || parsed.password) return 'URLs with embedded credentials are not allowed'
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) return `Hostname "${parsed.hostname}" is not a public domain (must have at least two segments)`
  if (isPrivateHost(parsed.hostname)) {
    return `Fetching private/internal address "${parsed.hostname}" is blocked for security`
  }
  return null
}

const fetchCache = new LruCache<string>({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}) as { turndown: (html: string) => string }

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** @internal 仅为重定向校验测试导出。 */
export async function doFetch(
  url: string,
  userAgent: string,
  abortSignal?: AbortSignal,
  customFetch?: typeof fetch,
): Promise<Response> {
  const request = {
    url,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    abortSignal: withTimeout(abortSignal),
    maxRedirects: 10,
  }

  if (customFetch) return fetchWithValidatedRedirects({ ...request, fetch: customFetch })

  try {
    return await fetchWithValidatedRedirects(request)
  } catch (error) {
    if (!isFakeIpDnsRejection(error)) throw error
    return fetchWithValidatedRedirects({ ...request, fetch: fakeIpCompatibleFetch })
  }
}

/** 以硬字节上限流式读取响应 body。防止 content-length 缺失或撒谎的分块响应
 *  造成 OOM。 */
async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(totalBytes, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.byteLength - offset
    if (remaining <= 0) break
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder().decode(merged)
}

function formatOutput(url: string, markdown: string, prompt?: string): string {
  if (prompt) {
    return `# Content from ${url}\n\n${markdown}\n\n---\nExtract instruction: ${prompt}`
  }
  return markdown
}

export const webFetch = tool({
  description:
    `Fetch a web page and extract its content as markdown. No API key needed. ` +
    `When summarizing the returned content for the user, preserve key details, concrete examples, ` +
    `section structure, and numbers — don't over-compress. ` +
    `Results are cached for 15 minutes per URL, so repeated reads of the same page are free. ` +
    `The current year is ${YEAR} — use it whenever the user asks for recent/latest/current information.`,
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    prompt: z.string().optional().describe('What information to extract from the page'),
  }),
  execute: async ({ url, prompt }, { toolCallId, abortSignal }) => {
    try {
      const urlError = validateFetchUrl(url)
      if (urlError) return `Error: ${urlError}`

      const cached = fetchCache.get(url)
      if (cached) {
        reportProgress(toolCallId, 'Using cached copy')
        return formatOutput(url, cached, prompt)
      }

      reportProgress(toolCallId, `Fetching ${url}`)
      let response = await doFetch(url, BROWSER_UA, abortSignal)

      // Cloudflare 机器人挑战回退：在 403 + cf-mitigated 头时，用诚实的 CLI
      // UA 重试。很多 CF 规则会放行已识别的爬虫，而拦截任何通不过浏览器
      // TLS 指纹校验的请求。
      if (response.status === 403 && response.headers.get('cf-mitigated') !== null) {
        response = await doFetch(url, FALLBACK_UA, abortSignal)
      }

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }

      // 当 content-length 超过上限时提前拒绝。
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_HTTP_BYTES) {
        const mb = Math.round(contentLength / 1024 / 1024)
        return `Error: Content too large (${mb} MB, limit ${MAX_HTTP_BYTES / 1024 / 1024} MB)`
      }

      const contentType = response.headers.get('content-type') ?? ''
      // 以硬字节上限流式读取 —— 防止 content-length 缺失或撒谎的分块响应
      // 造成 OOM。
      const body = await readResponseBody(response, MAX_HTTP_BYTES)

      if (contentType.includes('application/json')) {
        const json = body.slice(0, MAX_CONTENT_CHARS)
        fetchCache.set(url, json)
        return formatOutput(url, json, prompt)
      }

      const $ = cheerio.load(body)
      $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ads, .advertisement').remove()

      const mainContent = $('main, article, .content, .post, #content').first()
      const html = mainContent.length ? mainContent.html() : $('body').html()

      if (!html) return 'Error: Could not extract content from page.'

      let markdown: string = turndown.turndown(html)
      if (markdown.length > MAX_CONTENT_CHARS) {
        markdown = markdown.slice(0, MAX_CONTENT_CHARS) + '\n\n... [content truncated]'
      }

      fetchCache.set(url, markdown)
      return formatOutput(url, markdown, prompt)
    } catch (err) {
      return formatToolError('fetching URL', err)
    }
  },
})
