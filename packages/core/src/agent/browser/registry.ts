// @x-code-cli/core — 托管浏览器 MCP 的启动引导
//
// 一次性的根级视觉检查和交互式 `browser` 子代理共享一个由 @playwright/mcp 驱动的真实浏览器。
// 该 server 只存在于一个私有的 McpRegistry 中——而非主循环持有的那个全局 registry——这样
// 完整的浏览器工具集就不会进入主系统提示词，也不会进入任何无关的代理。根级只能通过其
// 精简的 browserVisualCheck 编排器触达它。
//
// 该 server（及其浏览器）在首个浏览器任务时才惰性启动，并按会话缓存，因此重复的检查/交互
// 会复用它。它是一个 stdio 子进程；CLI 的 gracefulShutdown 会调用 shutdownBrowserMcp，
// 让浏览器随 CLI 一起退出。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { type BrowserConfig, loadUserConfig } from '../../config/index.js'
import { buildCallableName } from '../../mcp/name-mangling.js'
import { McpPermissionStore } from '../../mcp/permissions.js'
import { McpRegistry, connectOneServer } from '../../mcp/registry.js'
import type { McpServerConfig, McpToolEntry } from '../../mcp/types.js'
import { debugLog, errorMessage } from '../../utils.js'
import { sanitizeBrowserDiagnostic } from './diagnostics.js'
import { acquireBrowserProfileLease } from './profile-lease.js'

/** 绝不暴露给代理的浏览器工具。`browser_run_code_unsafe` 会在 MCP server 进程内运行任意
 *  Node 代码（包括 fs 访问等），它绕过了浏览器代理的沙箱（该沙箱有意禁止 shell /
 *  writeFile / edit），并且测试中模型总是不停坠入它、用暴力方式完成任务，而不是使用
 *  snapshot/screenshot 工具。视觉检查编排器只私下用一处硬编码调用，来关闭它持有的稳定
 *  Playwright Page 句柄；模型或页面内容都无法提供那段代码。
 *  （同类 CLI 用二次确认来门控页面脚本执行，而不是暴露一个原始代码运行器——
 *  见 SENSITIVE_BROWSER_TOOLS。） */
const EXCLUDED_BROWSER_TOOLS = new Set(['browser_run_code_unsafe'])
const PRIVATE_BROWSER_CODE_TOOL = 'browser_run_code_unsafe'
const TAB_CLEANUP_MARKER = '__X_CODE_VISUAL_TAB_CLEANUP__:'
const TAB_PREPARED_MARKER = '__X_CODE_VISUAL_TAB_PREPARED__:'
const TAB_OWNED_MARKER = '__X_CODE_VISUAL_TAB_OWNED__:'

/** 保持可用但不会被预批准的浏览器工具，因此每次调用都会询问用户。`browser_evaluate` 会在
 *  （不可信的）页面里运行任意 JavaScript：它能读取 cookies / localStorage，并以登录态页面
 *  的身份发起请求，所以页面注入的指令可能把它变成数据外泄的一步。即便浏览器代理是 opt-in
 *  的，也值得为每次调用都确认一次——常规的 navigate/click/snapshot/screenshot 仍保持预批准，
 *  因此只有这一个工具会弹确认。（我们见过的“乱扑腾停不下来”，来自代理在模糊任务上过度使用
 *  evaluate；“把投入匹配到任务”的提示词指导能抑制它，所以弹窗很少出现。）真正危险的
 *  `browser_run_code_unsafe`——原始 Node/fs——是被完全 EXCLUDED，而不是门控。 */
const SENSITIVE_BROWSER_TOOLS = new Set(['browser_evaluate'])
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.79'

let managedOutputDirectory: string | undefined

function browserOutputDirectory(): string {
  if (!managedOutputDirectory) {
    // 每个进程一个随机目录，可以避免跨工作区文件名冲突和可预测的 /tmp 路径。
    // 最终清理由操作系统临时目录负责。
    managedOutputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-code-browser-'))
  } else {
    // 长时间运行的 CLI 空闲时，缓存清理工具可能删掉该目录。
    fs.mkdirSync(managedOutputDirectory, { recursive: true, mode: 0o700 })
  }
  if (process.platform !== 'win32') fs.chmodSync(managedOutputDirectory, 0o700)
  return managedOutputDirectory
}

/** 构造用于启动浏览器 MCP 的 stdio 配置。`command` 覆盖优先（进阶场景：离线 / 固定版本 /
 *  自定义 server）。否则默认使用一个经过测试、固定版本的 @playwright/mcp 发布版，这样自动
 *  视觉检查就不会在不同会话之间静默地执行不同版本的包。
 *  在 Windows 上，npx 必须通过 cmd.exe 运行——直接拉起裸 `npx` shim 会失败（它解析到
 *  `npx.cmd`）。
 *
 *  除非 cfg.vision 为 false，否则 `--caps vision` 会在无障碍树之上增加坐标鼠标工具
 *  （browser_take_screenshot 本身是核心工具）。command 覆盖拥有完整 argv，因此会忽略此设置。 */
export function buildBrowserServerConfig(cfg: BrowserConfig): McpServerConfig {
  // 首次连接超时给得很宽：冷启动的 npx 可能要下载 @playwright/mcp，再启动浏览器，
  // 远超默认的 30 秒。
  const timeout = 120_000
  if (cfg.command) {
    return { command: cfg.command, args: cfg.args ?? [], timeout }
  }
  const args = ['-y', PLAYWRIGHT_MCP_PACKAGE, '--browser', cfg.browser ?? 'chrome']
  if (cfg.headless) args.push('--headless')
  // 让 server 能力在不同 active model 之间保持稳定。坐标工具保持私有，并从一个无法理解
  // 截图的浏览器代理中被过滤掉；启动超集可以避免后续切换到支持视觉的模型时重启 Chrome
  // （并丢失标签页）。
  if (cfg.vision !== false) args.push('--caps', 'vision')
  // 限制 viewport，使（非 fullPage 的）截图分辨率有上限。视觉模型的 token 成本随图像
  // 尺寸（而非字节数）增长，所以小 viewport 是抑制截图 token 失控最便宜的杠杆。
  // 1280x800 能覆盖典型首屏布局；代理需要更多内容时会滚动，而不是拍一张巨大的 fullPage 截图。
  args.push('--viewport-size', cfg.viewport ?? '1280,800')
  // 保存的截图 / trace 落到临时目录，而不是 CLI cwd 下默认的 `.playwright-mcp/`
  // （那会污染用户的仓库）。代理本来就被要求不带文件名截图（内联图片），
  // 所以这里只兜住偶尔的显式保存。
  args.push('--output-dir', browserOutputDirectory())
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'npx', ...args], timeout }
  }
  return { command: 'npx', args, timeout }
}

export interface BrowserMcp {
  ok: boolean
  registry: McpRegistry
  permissions: McpPermissionStore
  toolCount: number
  /** 当已连接的 server 确实暴露了坐标视觉工具时为 true。 */
  vision: boolean
  /** 同步的生命周期探针，在缓存边界处用来堵上连接建立与 promise 接管之间残留的事件循环间隙。 */
  isLive(): boolean
  /** 把 MCP 当前的 Page 固定为恢复目标。 */
  prepareVisualCheck(ownerId: string, abortSignal?: AbortSignal): Promise<boolean>
  /** 把 MCP 当前的 Page 固定为本次检查的临时 Page，导航到已规范化的 URL，
   *  并校验最终 URL 仍留在本地。 */
  markVisualCheckTab(ownerId: string, url: string, abortSignal?: AbortSignal): Promise<boolean>
  /** 关闭被固定的临时 Page，并返回原 Page 当前的 MCP 标签页索引。调用方必须通过
   *  browser_tabs 选中该索引，server 内部的 current-tab 状态才会一并恢复。 */
  finishVisualCheck(ownerId: string, abortSignal?: AbortSignal): Promise<BrowserVisualCleanup>
  error?: string
}

export interface BrowserVisualCleanup {
  closed: boolean
  originalTabIndex?: number
}

let cached: BrowserMcp | null = null
let generation = 0
const profileReleases = new WeakMap<BrowserMcp, () => Promise<void>>()
const pendingProfileReleases = new Set<Promise<void>>()

interface BrowserConnectAttempt {
  controller: AbortController
  promise: Promise<BrowserMcp>
  waiters: number
}

let connecting: BrowserConnectAttempt | null = null

function browserFailure(error: string): BrowserMcp {
  return {
    ok: false,
    registry: new McpRegistry({ servers: [], tools: [], resources: [] }),
    permissions: new McpPermissionStore(),
    toolCount: 0,
    vision: false,
    isLive: () => false,
    prepareVisualCheck: async () => false,
    markVisualCheckTab: async () => false,
    finishVisualCheck: async () => ({ closed: false }),
    error: sanitizeBrowserDiagnostic(error, 1_000, 'Browser unavailable'),
  }
}

function resultContainsExactString(text: string, expected: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('"') || !line.endsWith('"')) continue
    try {
      if (JSON.parse(line) === expected) return true
    } catch {
      // 忽略 MCP 响应中非结果类带引号的行。
    }
  }
  return false
}

function abortReason(signal: AbortSignal, fallback = 'Browser startup aborted'): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(fallback, 'AbortError')
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err) => {
        cleanup()
        reject(err)
      },
    )
  })
}

function releaseBrowserProfile(browser: BrowserMcp): Promise<void> {
  const release = profileReleases.get(browser)
  if (!release) return Promise.resolve()
  const pending = release().catch((err) => {
    debugLog('browser.profile-release-failed', String(err))
  })
  pendingProfileReleases.add(pending)
  pending.then(() => {
    pendingProfileReleases.delete(pending)
  })
  return pending
}

async function closeBrowser(browser: BrowserMcp): Promise<void> {
  if (browser.ok) await browser.registry.shutdown().catch(() => undefined)
  await releaseBrowserProfile(browser)
}

/** 连接浏览器 MCP，并为视觉检查或浏览器子代理返回其私有 registry + permission store。
 *  会话内缓存一个存活连接，同时对并发的首次获取去重并自愈：如果浏览器/server 连接断开
 *  （用户关闭 Chrome、崩溃），缓存会失效，下一次获取会重连。失败的连接不会被缓存，
 *  因此用户修复环境后重试即可生效。 */
export async function getBrowserMcp(abortSignal?: AbortSignal): Promise<BrowserMcp> {
  if (abortSignal?.aborted) throw abortReason(abortSignal)
  if (cached) return cached
  // 断开的 stdio 连接会从 SDK 的 onClose 回调里异步释放其 profile。
  // 不要让立即自愈去和那次 unlink 竞争。
  if (pendingProfileReleases.size > 0) {
    await waitWithSignal(
      Promise.allSettled([...pendingProfileReleases]).then(() => undefined),
      abortSignal,
    )
  }

  // 前一个调用方可能已取消了唯一在途的冷启动。先等那个子进程完成关闭，再拉起替换者；
  // 把新调用方挂到一个已中止的 attempt 上会返回误导性失败，而两个 Chrome profile 竞争
  // 也可能撞上锁。
  if (connecting?.controller.signal.aborted) {
    const stale = connecting
    await stale.promise
    if (connecting === stale) connecting = null
    if (abortSignal?.aborted) throw abortReason(abortSignal)
    if (cached) return cached
  }

  let attempt = connecting
  if (!attempt) {
    const controller = new AbortController()
    const attemptGeneration = generation
    const created = {} as BrowserConnectAttempt
    created.controller = controller
    created.waiters = 0
    created.promise = connectBrowser(controller.signal)
      .then(async (value) => {
        if (attemptGeneration !== generation || controller.signal.aborted) {
          await closeBrowser(value)
          return browserFailure('Browser startup was cancelled')
        }
        if (value.ok && !value.isLive()) {
          await closeBrowser(value)
          return browserFailure('Browser connection closed during startup; retry to reconnect')
        }
        if (value.ok) cached = value
        return value
      })
      .catch((err) => browserFailure(errorMessage(err)))
      .finally(() => {
        if (connecting === created) connecting = null
      })
    connecting = created
    attempt = created
  }

  attempt.waiters++
  let callerAborted = false
  try {
    return await waitWithSignal(attempt.promise, abortSignal)
  } catch (err) {
    callerAborted = abortSignal?.aborted === true
    throw err
  } finally {
    attempt.waiters--
    if (
      callerAborted &&
      abortSignal &&
      attempt.waiters === 0 &&
      connecting === attempt &&
      !attempt.controller.signal.aborted
    ) {
      attempt.controller.abort(abortReason(abortSignal))
    }
  }
}

async function connectBrowser(abortSignal: AbortSignal): Promise<BrowserMcp> {
  const browserConfig = loadUserConfig().browser ?? {}
  const profileLease = browserConfig.command ? undefined : await acquireBrowserProfileLease(browserConfig)
  let releasePromise: Promise<void> | undefined
  const releaseProfile = () => (releasePromise ??= profileLease?.release() ?? Promise.resolve())

  try {
    const config = buildBrowserServerConfig(browserConfig)
    const result = await connectOneServer('browser', config, undefined, undefined, abortSignal)

    // 与启动时 loader 相同的方式对 server 工具做名称混淆。
    // 危险工具在这里按原始名称丢弃，因此无论 callable 名称如何混淆，它们都不会进入 registry。
    const tools: McpToolEntry[] = []
    const taken = new Set<string>()
    for (const t of result.tools) {
      if (EXCLUDED_BROWSER_TOOLS.has(t.name)) continue
      const callable = buildCallableName('browser', t.name, taken)
      taken.add(callable)
      tools.push({
        callableName: callable,
        rawName: t.name,
        serverName: 'browser',
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }

    const status = result.server.status
    if (status.kind === 'failed' || tools.length === 0) {
      const reason = sanitizeBrowserDiagnostic(
        status.kind === 'failed' ? status.error : 'the browser MCP server exposed no tools',
        600,
      )
      const tail = result.server.stderrTail
        ? ` — ${sanitizeBrowserDiagnostic(result.server.stderrTail, 300, 'no browser diagnostics reported')}`
        : ''
      debugLog('browser.connect-failed', `${reason}${tail}`)
      await result.server.client.close().catch(() => undefined)
      await releaseProfile()
      // 不要缓存失败：用户安装 Chrome / 修好 npx 后重试应无需重启 CLI 即可生效。
      return browserFailure(`${reason}${tail}`)
    }

    const registry = new McpRegistry({
      servers: [result.server],
      tools,
      resources: [...result.resources],
      configs: new Map([['browser', config]]),
    })
    // 启用交互式浏览器代理即视为同意常规导航。这些权限只被该子代理使用；
    // 根级视觉检查直接调用固定的、范围很窄的操作序列，无法选择任意工具。
    const permissions = new McpPermissionStore()
    for (const t of tools) {
      if (SENSITIVE_BROWSER_TOOLS.has(t.rawName)) continue
      permissions.approveForSession(t.callableName)
    }

    let connectionLive = true
    const value: BrowserMcp = {
      ok: true,
      registry,
      permissions,
      toolCount: tools.length,
      vision: tools.some((tool) => tool.rawName.startsWith('browser_mouse_')),
      isLive: () => connectionLive,
      prepareVisualCheck: async (ownerId, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return false
        const originalKey = `x-code-visual-original:${ownerId}`
        const preparedMarker = `${TAB_PREPARED_MARKER}${ownerId}`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const originalKey = Symbol.for(${JSON.stringify(originalKey)}); ` +
          `context[originalKey] = page; ` +
          `return ${JSON.stringify(preparedMarker)} }`
        try {
          const prepared = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          return !prepared.isError && resultContainsExactString(prepared.text, preparedMarker)
        } catch {
          return false
        }
      },
      markVisualCheckTab: async (ownerId, url, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return false
        const originalKey = `x-code-visual-original:${ownerId}`
        const temporaryKey = `x-code-visual-temporary:${ownerId}`
        const ownedMarker = `${TAB_OWNED_MARKER}${ownerId}`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const original = context[Symbol.for(${JSON.stringify(originalKey)})]; ` +
          `if (!original || page === original) return ''; ` +
          `context[Symbol.for(${JSON.stringify(temporaryKey)})] = page; ` +
          `page[Symbol.for(${JSON.stringify(temporaryKey)})] = true; ` +
          `const loopback = /^https?:\\/\\/(?:(?:[^/?#:@]+\\.)*localhost\\.?|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d+)?(?:[/?#]|$)/i; ` +
          `try { await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' }); } catch {} ` +
          `return loopback.test(page.url()) ? ${JSON.stringify(ownedMarker)} : '' }`
        try {
          const marked = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          return !marked.isError && resultContainsExactString(marked.text, ownedMarker)
        } catch {
          return false
        }
      },
      finishVisualCheck: async (ownerId, signal) => {
        if (!result.tools.some((tool) => tool.name === PRIVATE_BROWSER_CODE_TOOL)) return { closed: false }
        const originalKey = `x-code-visual-original:${ownerId}`
        const temporaryKey = `x-code-visual-temporary:${ownerId}`
        const cleanupMarker = `${TAB_CLEANUP_MARKER}${ownerId}:`
        const code =
          `async (page) => { const context = page.context(); ` +
          `const originalKey = Symbol.for(${JSON.stringify(originalKey)}); ` +
          `const temporaryKey = Symbol.for(${JSON.stringify(temporaryKey)}); ` +
          `const original = context[originalKey]; ` +
          `const temporary = context[temporaryKey] ?? context.pages().find(candidate => candidate[temporaryKey] === true); ` +
          `delete context[originalKey]; ` +
          `delete context[temporaryKey]; ` +
          `if (temporary && !temporary.isClosed()) await temporary.close(); ` +
          `const pages = context.pages(); ` +
          `const originalIndex = original && !original.isClosed() ? pages.indexOf(original) : -1; ` +
          `return ${JSON.stringify(cleanupMarker)} + JSON.stringify({ closed: Boolean(temporary?.isClosed()), originalIndex }) }`
        try {
          const cleaned = await result.server.client.callTool(PRIVATE_BROWSER_CODE_TOOL, { code }, signal)
          if (cleaned.isError) return { closed: false }
          for (const rawLine of cleaned.text.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line.startsWith('"') || !line.endsWith('"') || !line.includes(cleanupMarker)) continue
            try {
              const value = JSON.parse(line) as unknown
              if (typeof value !== 'string' || !value.startsWith(cleanupMarker)) continue
              const payload = JSON.parse(value.slice(cleanupMarker.length)) as {
                closed?: unknown
                originalIndex?: unknown
              }
              return {
                closed: payload.closed === true,
                ...(Number.isInteger(payload.originalIndex) && Number(payload.originalIndex) >= 0
                  ? { originalTabIndex: Number(payload.originalIndex) }
                  : {}),
              }
            } catch {
              // 继续扫描，找到精确的结构化结果行。
            }
          }
          return { closed: false }
        } catch {
          return { closed: false }
        }
      },
    }
    profileReleases.set(value, releaseProfile)
    // 自愈：当 server/浏览器连接断开（Chrome 关闭、崩溃）时，
    // 丢弃缓存和 profile 租约，让下一次获取可以重连。
    const observingLiveConnection = result.server.client.onClose(async () => {
      connectionLive = false
      if (cached === value) cached = null
      await releaseBrowserProfile(value)
    })
    if (!observingLiveConnection) {
      await result.server.client.close().catch(() => undefined)
      await releaseBrowserProfile(value)
      return browserFailure('Browser connection closed during startup; retry to reconnect')
    }
    return value
  } catch (err) {
    await releaseProfile().catch(() => undefined)
    throw err
  }
}

/** 关闭浏览器 MCP 子进程（及其浏览器）。接入 CLI 的 gracefulShutdown；幂等。 */
export async function shutdownBrowserMcp(): Promise<void> {
  generation++
  const attempt = connecting
  const current = cached
  cached = null
  if (attempt && !attempt.controller.signal.aborted) {
    attempt.controller.abort(new DOMException('Browser shutdown requested', 'AbortError'))
  }
  await Promise.all([
    current ? closeBrowser(current) : Promise.resolve(),
    attempt?.promise.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve(),
  ])
}
