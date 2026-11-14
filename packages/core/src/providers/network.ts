// @x-code-cli/core — provider 网络出口
//
// 两个现实问题：
//   1. Cloudflare 域名可能解析到多个地址，其中一个不可达时 Node 默认可能
//      选中它并卡在 connect timeout。
//   2. macOS 的系统代理（ClashX 等）不会被 Node 的全局 fetch 自动使用。
//      OpenDesign 的 amr-link 域名在某些网络下直连很慢/会重置，但走系统
//      代理就稳定；OpenCode 直连则正常。
//
// 因此这里做两件事：启用 autoSelectFamily，并在检测到系统代理/环境变量时
// 用 undici 的 ProxyAgent 发 provider 请求。测试环境保持全局 fetch，便于 mock。
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'

import { execFileSync } from 'node:child_process'
import net from 'node:net'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

let configured = false
let directDispatcher: Agent | null = null
let proxyDispatcher: ProxyAgent | null = null
let proxyUrl: string | null = null

function readMacSystemProxy(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2_000 })
    const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output)
    const httpEnabled = /HTTPEnable\s*:\s*1/.test(output)
    const proxy = output.match(/(?:HTTPS|HTTP)Proxy\s*:\s*(\S+)/)?.[1]
    const port = output.match(/(?:HTTPS|HTTP)Port\s*:\s*(\d+)/)?.[1]
    if ((httpsEnabled || httpEnabled) && proxy && port) return `http://${proxy}:${port}`
  } catch {
    // 读不到系统代理时回退到直连。
  }
  return null
}

function detectProxy(): string | null {
  const fromEnv =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
  if (fromEnv.trim()) return fromEnv.trim()
  return readMacSystemProxy()
}

function shouldBypassProxy(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local')) return true
  if (host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.')) return true
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return noProxy.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`))
}

export function configureProviderNetwork(): void {
  if (configured) return
  configured = true

  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(true)
  }
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
  }

  // 测试里大量 mock global.fetch；不要替换成 undici fetch。
  if (process.env.VITEST) return

  directDispatcher = new Agent({
    connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, timeout: 30_000 },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  })

  const detected = detectProxy()
  if (detected && /^https?:\/\//i.test(detected)) {
    try {
      proxyDispatcher = new ProxyAgent(detected)
      proxyUrl = detected
    } catch {
      proxyDispatcher = null
      proxyUrl = null
    }
  }
}

/** 供 AI SDK provider 使用的 fetch。检测到代理时走代理，本机地址仍直连。 */
export const providerFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  configureProviderNetwork()
  if (!directDispatcher || !proxyDispatcher) return fetch(input, init)

  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
  let hostname = ''
  try {
    hostname = new URL(rawUrl).hostname
  } catch {
    // 相对/非法 URL 交给默认 fetch 处理。
    return fetch(input, init)
  }
  const dispatcher = shouldBypassProxy(hostname) ? directDispatcher : proxyDispatcher
  return undiciFetch(input as never, { ...(init ?? {}), dispatcher } as never)
}) as typeof fetch

/** 当前是否通过代理发 provider 请求；用于诊断。 */
export function providerProxyStatus(): { proxy: string | null; direct: boolean } {
  return { proxy: proxyUrl, direct: directDispatcher !== null }
}

/** 进程退出时释放连接池。 */
export function closeProviderNetwork(): void {
  void directDispatcher?.close().catch(() => undefined)
  void proxyDispatcher?.close().catch(() => undefined)
}
