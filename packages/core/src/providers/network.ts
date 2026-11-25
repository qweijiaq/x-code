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

import { debugLog } from '../utils.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

let configured = false
let directDispatcher: Agent | null = null
let proxyDispatcher: ProxyAgent | null = null
let proxyUrl: string | null = null

function readMacSystemProxy(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2_000 })
    // `scutil --proxy` 会同时列出 HTTP 与 HTTPS 两组，且两组的 host / port 可能
    // 完全不同（企业环境常见，甚至其中一组是 SOCKS 混合端口）。跨组各取一个
    // 拼出 `http://proxyA:portB` 是个无效地址，而它仍能通过下面的
    // /^https?:\/\// 校验，只在真正请求时才莫名其妙连不上。因此必须按组配对。
    const pick = (enableKey: string, hostKey: string, portKey: string): string | null => {
      if (!new RegExp(`${enableKey}\\s*:\\s*1`).test(output)) return null
      const host = output.match(new RegExp(`${hostKey}\\s*:\\s*(\\S+)`))?.[1]
      const port = output.match(new RegExp(`${portKey}\\s*:\\s*(\\d+)`))?.[1]
      if (!host || !port) return null
      return `http://${host}:${port}`
    }
    const paired = pick('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort') ?? pick('HTTPEnable', 'HTTPProxy', 'HTTPPort')
    if (paired) return paired
    if (/ProxyAutoConfigEnable\s*:\s*1/.test(output)) {
      // PAC 脚本需要执行 JS 才能算出代理，undici 的 ProxyAgent 做不到；静默
      // 直连会让用户只看到「配了代理但没生效」。
      debugLog('providers.pac-proxy-unsupported', 'system proxy uses a PAC script; connecting directly')
    }
  } catch {
    // 读不到系统代理时回退到直连。
  }
  return null
}

function detectProxy(): string | null {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  if (fromEnv.trim()) return fromEnv.trim()
  return readMacSystemProxy()
}

/** 去掉 `scheme://user:password@host` 里的 userinfo。代理 URL 里带账号密码是
 *  合法写法，但诊断输出、debug 日志和错误上报都会原样打印它。 */
function redactProxyUrl(url: string): string {
  return url.replace(/:\/\/[^/@]*@/, '://***@')
}

/** `10.0.0.0/8` 这类 CIDR 条目只对 IP 字面量的主机有意义，主机名一律不匹配。 */
function cidrMatches(host: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/')
  const version = net.isIP(host)
  if (!network || version === 0 || net.isIP(network) !== version) return false
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) return false
  const block = new net.BlockList()
  block.addSubnet(network, prefix, version === 4 ? 'ipv4' : 'ipv6')
  return block.check(host, version === 4 ? 'ipv4' : 'ipv6')
}

/** NO_PROXY 条目的常见写法都要归一化后再比：`*.example.com` 与 `.example.com`
 *  既不等于 host 也不满足 `endsWith('.<entry>')`，`example.com:443` 带端口，
 *  `10.0.0.0/8` 是 CIDR 段。不归一化意味着这些条目全部静默失效。 */
function noProxyEntryMatches(host: string, rawEntry: string): boolean {
  if (rawEntry === '*') return true
  const entry = rawEntry.replace(/:\d+$/, '').replace(/^\*?\.?/, '')
  if (!entry) return false
  if (entry.includes('/')) return cidrMatches(host, entry)
  return host === entry || host.endsWith(`.${entry}`)
}

function shouldBypassProxy(hostname: string): boolean {
  // IPv6 字面量在 `URL#hostname` 里带方括号（`[::1]`），与 LOCAL_HOSTS 里的
  // `'::1'` 不相等，于是本机请求会被错误地丢给代理。
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local')) return true
  // 只在 hostname 是 IP 字面量时做网段判断：对主机名用 `startsWith('10.')` /
  // `'127.'` 会把 `10.internal.attacker.com`、`127.evil.com` 误判为本机而绕过
  // 代理（与 NO_PROXY 一起构成出口策略绕过）。
  if (net.isIP(host) !== 0 && (host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.'))) {
    return true
  }
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return noProxy.some((entry) => noProxyEntryMatches(host, entry))
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
  if (detected) {
    if (!/^https?:\/\//i.test(detected)) {
      // undici 的 ProxyAgent 只支持 http(s) 代理。SOCKS（Clash 常见的
      // `socks5://127.0.0.1:7891`）目前无法转发——静默丢弃会让用户只看到
      // 「配了代理但没生效」，排障成本极高，所以至少留一条面包屑。
      debugLog('providers.proxy-unsupported', `ignoring non-http(s) proxy ${redactProxyUrl(detected)}`)
    } else {
      try {
        proxyDispatcher = new ProxyAgent({
          uri: detected,
          proxyTunnel: true,
          // 直连 dispatcher 上的调优必须一并带给代理连接：代理本身是「解析到
          // 多个地址的域名」时，默认参数会重新踩回最初的 connect 超时问题。
          connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, timeout: 30_000 },
        })
        proxyUrl = detected
      } catch {
        proxyDispatcher = null
        proxyUrl = null
      }
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
  // 代理 URL 里带 userinfo 是合法写法，而这是给诊断 / `--verbose` 输出用的
  // 接口——原样返回等于把代理账号密码写进日志。
  return { proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null, direct: directDispatcher !== null }
}

/** 进程退出时释放连接池。 */
export function closeProviderNetwork(): void {
  const closing = [directDispatcher?.close(), proxyDispatcher?.close()]
  // close() 之后连接池已关闭，但句柄还挂着：`providerProxyStatus()` 会继续报
  // `direct: true`，而 providerFetch 会把已关闭的 dispatcher 交给 undiciFetch，
  // 抛 `The dispatcher is closed` 而不是回退到全局 fetch。
  directDispatcher = null
  proxyDispatcher = null
  proxyUrl = null
  void Promise.allSettled(closing)
}
