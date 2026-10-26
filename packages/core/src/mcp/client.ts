// @x-code-cli/core — 每服务器 MCP 客户端封装
//
// 一个 McpClient 实例 == 一条服务器连接。这个类把 SDK 略显别扭的双对象
// 组装（`new Client(...)` + `new XxxTransport(...)` +
// `client.connect(transport)`）隐藏在一个 `connect()` 方法之后，在
// `close()` 时负责 transport 的拆卸，并暴露 registry 实际需要的窄接口
// （listTools / callTool / listResources / readResource / close）。
//
// abortSignal 贯穿：每个面向服务器的 RPC 方法都接受可选的 AbortSignal
// 并通过 `RequestOptions.signal` 转发。当用户在工具调用中途按下 Esc 时，
// agent loop 的信号会中止 SDK 请求，关闭 JSON-RPC future 而不会杀掉底层
// 连接——下一次调用可以复用同一条 transport。
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { Stream } from 'node:stream'

import { debugLog } from '../utils.js'
import { getShellSandbox, isExtensionSandboxActive, wrapShellSpawn } from '../utils/shell-sandbox.js'
import { VERSION } from '../version.js'
import { McpOAuthProvider } from './oauth/provider.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** 为诊断保留多少行 stderr 尾部。
 *  当 stdio 服务器在启动时死亡或调用中途失败时，在 `/mcp list` 中展示其
 *  stderr 的最后几行，是有意义错误与无用的 "exit code 1" 之间的区别。 */
const STDERR_TAIL_LINES = 20

const CLIENT_INFO = { name: 'x-code-cli', version: VERSION }

/** 默认首次连接超时（毫秒）。可通过配置的 `timeout` 字段按服务器覆盖。
 *  30 秒很宽裕——社区 stdio 服务器通常在 100-500ms 内启动；这个预算
 *  是留给冷缓存下缓慢的 npx 安装的，不是给正常运行用的。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DISCOVERY_TIMEOUT_MS = 15_000
const MAX_DISCOVERED_TOOLS = 256
const MAX_DISCOVERED_RESOURCES = 1_000
const MAX_TOOL_SCHEMA_BYTES = 128 * 1024
const MAX_DISCOVERY_SCHEMA_BYTES = 1024 * 1024
const MAX_DESCRIPTION_BYTES = 16 * 1024
const MAX_ANNOTATIONS_BYTES = 16 * 1024
const MAX_RESOURCE_TEXT_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_BLOCKS = 1_000
const MAX_RESULT_IMAGES = 8
const MAX_RESULT_IMAGE_BASE64_CHARS = 14 * 1024 * 1024

export interface ConnectInfo {
  toolCount: number
  resourceCount: number
}

export class McpClient {
  /** SDK 客户端。仅在成功连接后才存在。 */
  private client: Client | null = null
  /** SDK transport。由我们持有，以便能干净地 `close()` 它。 */
  private transport: Transport | null = null
  /** stderr 的滚动尾部（仅 stdio 服务器）。 */
  private stderrTail: string[] = []
  /** 上次连接的缓存结果，提供给 registry。 */
  private cachedTools: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: Record<string, unknown>
  }> = []
  private cachedResources: McpResourceEntry[] = []
  /** SDK 不会把 onclose 事件重放给在 transport 已断开后才注册的监听器。
   *  维护我们自己的生命周期状态，使迟到的观察者不会把死连接误认为活连接。 */
  private connectionState: 'idle' | 'open' | 'closed' = 'idle'
  private closeHandlers = new Set<() => void | Promise<void>>()

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig,
    /** HTTP 服务器可选 OAuth provider。stdio 服务器忽略它。 */
    private readonly authProvider?: OAuthClientProvider,
  ) {}

  /** 启动 / 拨号服务器并完成 MCP initialize 握手。
   *  成功时填充内部 tool + resource 缓存。失败时清理 transport
   *  （不留僵尸子进程）并重新抛出。 */
  async connect(abortSignal?: AbortSignal): Promise<ConnectInfo> {
    const timeout = this.config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS

    this.transport = this.buildTransport()
    this.client = new Client(CLIENT_INFO, { capabilities: {} })
    this.connectionState = 'open'
    this.client.onclose = () => this.notifyClosed()

    // SDK 的 connect() 执行 initialize 往返，并在服务器确认后 resolve。
    // 用一个显式定时器与它竞速，因为卡住的 stdio 子进程（例如 npx 卡在
    // registry 拉取上）否则不会表现为错误——只会一直挂在那里。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    const signal = abortSignal ? AbortSignal.any([ctrl.signal, abortSignal]) : ctrl.signal
    try {
      await this.client.connect(this.transport, { signal })
    } catch (err) {
      // UnauthorizedError 是 OAuth 流程中预期的抛出：SDK 已调用
      // redirectToAuthorization，现在希望调用方在*同一条* transport 上
      // 执行 finishAuth(code)。如果在这里拆掉，runOAuthDance 会失去句柄
      // 而无法完成交换。让 transport + client 保持存活；调用方
      // （runOAuthDance）或 finally 关闭路径会清理。对于其他任何错误，
      // 我们仍会 safeClose，以避免泄漏子进程 / 悬挂的 HTTP 连接。
      if (!isUnauthorizedError(err)) {
        await this.safeClose()
      }
      throw this.enrichError(err)
    } finally {
      clearTimeout(timer)
    }

    // 发现能力。Tools/resources 相互独立——服务器可以只提供其一——
    // 并且我们容忍任一列举抛错（有些服务器在没有 resources 时会拒绝
    // `listResources`）。
    try {
      const discoverySignal = AbortSignal.timeout(Math.min(timeout, DISCOVERY_TIMEOUT_MS))
      const signal = abortSignal ? AbortSignal.any([discoverySignal, abortSignal]) : discoverySignal
      const tools = await this.client.listTools(undefined, { signal })
      let schemaBytes = 0
      this.cachedTools = []
      for (const t of (tools.tools ?? []).slice(0, MAX_DISCOVERED_TOOLS)) {
        if (typeof t.name !== 'string' || !t.name || t.name.length > 256) continue
        const inputSchema = (t.inputSchema as Record<string, unknown>) ?? {}
        if (typeof inputSchema !== 'object' || Array.isArray(inputSchema)) continue
        let bytes: number
        try {
          bytes = Buffer.byteLength(JSON.stringify(inputSchema), 'utf8')
        } catch {
          continue
        }
        if (bytes > MAX_TOOL_SCHEMA_BYTES || schemaBytes + bytes > MAX_DISCOVERY_SCHEMA_BYTES) continue
        schemaBytes += bytes
        this.cachedTools.push({
          name: t.name,
          description: truncateText(t.description ?? '', MAX_DESCRIPTION_BYTES),
          inputSchema,
          annotations: boundedJsonRecord(
            (t as { annotations?: Record<string, unknown> }).annotations,
            MAX_ANNOTATIONS_BYTES,
          ),
        })
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        await this.safeClose()
        throw err
      }
      debugLog('mcp.listTools-failed', `${this.serverName}: ${String(err)}`)
      this.cachedTools = []
    }

    try {
      const discoverySignal = AbortSignal.timeout(Math.min(timeout, DISCOVERY_TIMEOUT_MS))
      const signal = abortSignal ? AbortSignal.any([discoverySignal, abortSignal]) : discoverySignal
      const resources = await this.client.listResources(undefined, { signal })
      this.cachedResources = (resources.resources ?? [])
        .slice(0, MAX_DISCOVERED_RESOURCES)
        .filter((r) => typeof r.uri === 'string' && r.uri.length > 0 && r.uri.length <= 8192)
        .map((r) => ({
          uri: r.uri,
          name: truncateText(r.name ?? r.uri, MAX_DESCRIPTION_BYTES),
          description: r.description ? truncateText(r.description, MAX_DESCRIPTION_BYTES) : undefined,
          mimeType: r.mimeType ? truncateText(r.mimeType, 256) : undefined,
          serverName: this.serverName,
        }))
    } catch (err) {
      if (abortSignal?.aborted) {
        await this.safeClose()
        throw err
      }
      // JSON-RPC -32601（Method not found）只表示服务器没有实现 resources
      // 能力——对只提供工具的服务器（如 @playwright/mcp）是正常的，
      // 不值得记录日志的失败。其他错误才需要记录。
      const code = (err as { code?: number } | null)?.code
      if (code !== -32601) debugLog('mcp.listResources-failed', `${this.serverName}: ${String(err)}`)
      this.cachedResources = []
    }

    return {
      toolCount: this.cachedTools.length,
      resourceCount: this.cachedResources.length,
    }
  }

  /** 连接时发现的工具。在连接生命周期内稳定；在新的 McpClient 上再次调用
   *  connect() 即可刷新。 */
  tools(): ReadonlyArray<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: Record<string, unknown>
  }> {
    return this.cachedTools
  }

  resources(): ReadonlyArray<McpResourceEntry> {
    return this.cachedResources
  }

  /** 以完整的交互式 OAuth 往返进行连接。
   *
   *  MCP SDK 的 StreamableHTTP transport 惰性处理认证：没有存储 token 的
   *  新连接会调用 `authProvider.redirectToAuthorization`，然后因为 token
   *  交换步骤必须等待用户而抛出 `UnauthorizedError`。调用方应等待重定向
   *  回调落地，把授权码交给 `transport.finishAuth(code)`，然后重试连接——
   *  此时 token 已保存，下一次尝试就会成功。
   *
   *  我们在这里封装这段流程，使 `/mcp auth` 处理器可以在不了解
   *  `finishAuth` 的情况下选择"把 OAuth 驱动到完成"。默认的 `connect()`
   *  路径让 OAuth provider 保持被动——在我们于此处翻转
   *  `setInteractive(true)` 之前，`redirectToAuthorization` 都是 no-op，
   *  因此 CLI 启动不会为处于 `needs_auth` 的服务器意外弹出浏览器窗口。 */
  async connectWithOAuth(hooks: { onBrowserOpen?: (url: string) => void } = {}): Promise<ConnectInfo> {
    if (!this.authProvider) {
      throw new Error(`MCP server "${this.serverName}" has no OAuth provider configured`)
    }
    if (!(this.authProvider instanceof McpOAuthProvider)) {
      // 允许第三方 provider，但跳过我们的 `waitForAuthCode` 钩子——
      // 它们应自行处理流程。
      return this.connect()
    }

    const provider = this.authProvider

    // 提前启动 callback server，使真实的 loopback 端口在 SDK 构建
    // 动态注册请求*之前*就绑定到 `clientMetadata.redirect_uris` 和
    // `redirectUrl`。否则我们会以一个无端口的占位符注册，Sentry（以及
    // 任何不遵守 RFC 8252 §7.3 loopback 任意端口规则的其他认证服务器）
    // 会把认证 URL 里带真实端口的 redirect_uri 判为 "Invalid"。
    await provider.prepareForAuth()

    // 把浏览器打开通知分接到调用方的钩子，使 /mcp auth 处理器能连同 provider
    // 自己的 onOpenBrowser 回调一起打印到 CLI 回滚区。我们只在此次调用的
    // 生命周期内 monkey-patch 该方法（try/finally 会恢复它）。provider 没有
    // 暴露事件 API，但在一个实例上、为一次流程 patch 一个方法，影响范围
    // 足够小，是安全的。
    const originalRedirect = provider.redirectToAuthorization.bind(provider)
    if (hooks.onBrowserOpen) {
      provider.redirectToAuthorization = async (url: URL) => {
        try {
          hooks.onBrowserOpen?.(url.toString())
        } catch {
          // 钩子失败绝不能中止 OAuth 流程。
        }
        return originalRedirect(url)
      }
    }
    try {
      return await this.runOAuthDance()
    } finally {
      provider.setInteractive(false)
      if (hooks.onBrowserOpen) {
        provider.redirectToAuthorization = originalRedirect
      }
    }
  }

  /** 实际的两阶段连接：第一次尝试触发重定向，然后我们等待用户、完成认证，
   *  第二次尝试建立真正的会话。两次尝试共享 `cachedTools` /
   *  `cachedResources`。 */
  private async runOAuthDance(): Promise<ConnectInfo> {
    const provider = this.authProvider as McpOAuthProvider

    // 第一次尝试：大概率在浏览器启动后抛出 UnauthorizedError。如果 token
    // 碰巧仍然有效（磁盘上的旧状态），这里会成功并直接短路返回。
    try {
      return await this.connect()
    } catch (err) {
      // 任何不属于"需要等待用户"的错误都会向上传播。
      if (!isUnauthorizedError(err)) {
        provider.cancel()
        throw err
      }
    }

    // provider 已调用 redirectToAuthorization（SDK 在抛出前内部会这么做）。
    // 现在等待用户通过 callback server 返回，然后完成交换。
    const { code } = await provider.waitForAuthCode()
    const transport = this.transport
    if (!(transport instanceof StreamableHTTPClientTransport)) {
      throw new Error(`Internal error: OAuth flow expected an HTTP transport for "${this.serverName}"`)
    }
    await transport.finishAuth(code)

    // token 现已保存。第一次尝试把 client + transport 留在半开状态
    // （SDK 的 connect 在握手途中抛出）；重试需要一条干净的 transport，
    // 所以先关闭再重建。这也意味着 SDK 的 initialize 往返是在全新 socket 上
    // 进行的，避免了任何 "already connected" / 状态泄漏的意外。
    await this.safeClose()
    return this.connect()
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.callTool(
      { name, arguments: args as Record<string, unknown> | undefined },
      undefined,
      { signal },
    )
    return flattenCallResult(result)
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<{ text: string; mimeType?: string }> {
    if (!this.client) throw new Error(`MCP server "${this.serverName}" is not connected`)
    const result = await this.client.readResource({ uri }, { signal })
    // Resources 返回一个 content block 数组；拼接文本表示，
    // 为调用方保留第一个 mimeType。
    const parts: string[] = []
    let remainingBytes = MAX_RESOURCE_TEXT_BYTES
    let mimeType: string | undefined
    const contents = Array.isArray(result.contents) ? result.contents.slice(0, MAX_CONTENT_BLOCKS) : []
    for (const c of contents) {
      const candidateMime = (c as { mimeType?: string }).mimeType
      if (!mimeType && candidateMime) mimeType = truncateText(candidateMime, 256)
      const text = (c as { text?: string }).text
      if (typeof text === 'string' && remainingBytes > 0) {
        const bounded = truncateText(text, remainingBytes)
        parts.push(bounded)
        remainingBytes -= Buffer.byteLength(bounded, 'utf8')
      } else if ((c as { blob?: string }).blob !== undefined) {
        parts.push(`[binary content omitted, mimeType=${mimeType ?? 'unknown'}]`)
      }
    }
    return { text: parts.join('\n'), mimeType }
  }

  /** 快照最后 N 行 stderr 用于诊断。HTTP 服务器为空。 */
  stderr(): string {
    return this.stderrTail.join('\n')
  }

  async close(): Promise<void> {
    await this.safeClose()
  }

  /** 注册一个在连接断开（stdio 子进程退出、transport 关闭）时触发的处理器。
   *  browser registry 用它在用户关闭浏览器或服务器死亡时使缓存连接失效，
   *  使下一次 acquire 重新连接而不是复用死掉的 client。若关闭事件发生在
   *  注册之前，则返回 false 并立即调用该处理器，使调用方可以拒绝过期缓存。 */
  onClose(handler: () => void | Promise<void>): boolean {
    if (this.connectionState === 'closed') {
      this.invokeCloseHandler(handler)
      return false
    }
    this.closeHandlers.add(handler)
    return true
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private buildTransport(): Transport {
    if (isStdioConfig(this.config)) {
      // 可选的扩展沙箱：stdio 服务器保留网络访问（其上游 API 在沙箱之外），
      // 但失去工作区/temp 之外的写权限，且无法读取凭据路径。
      const sandbox = isExtensionSandboxActive() ? { ...getShellSandbox(), allowNetwork: true } : null
      const wrapped = sandbox ? wrapShellSpawn(this.config.command, this.config.args ?? [], sandbox) : null
      const t = new StdioClientTransport({
        command: wrapped?.executable ?? this.config.command,
        args: wrapped?.args ?? this.config.args,
        env: this.config.env,
        cwd: this.config.cwd,
        // 以 pipe 方式接 stderr 以便捕获诊断信息。默认的 "inherit" 会把
        // 子进程的噪声倒进父 CLI 的终端，打乱我们的 cell-buffer UI。
        stderr: 'pipe',
      })
      const stderr: Stream | null = t.stderr
      if (stderr) {
        stderr.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          for (const line of text.split(/\r?\n/)) {
            if (!line) continue
            this.stderrTail.push(line)
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
          }
        })
      }
      return t
    }

    if (isHttpConfig(this.config)) {
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        authProvider: this.authProvider,
      })
    }

    // 上游的 schema 校验本应防住这种情况，这里只是防御性兜底。
    throw new Error(`mcp server "${this.serverName}": unrecognised config shape`)
  }

  private async safeClose(): Promise<void> {
    // SDK 的 Client.close() 也会关闭 transport。我们先尝试 client，因为它会
    // 发送规范的 shutdown 通知；如果 client 从未构建（例如构造函数在赋值前
    // 抛出），则回退到 transport.close()。
    try {
      if (this.client) {
        await this.client.close()
      } else if (this.transport) {
        await this.transport.close()
      }
    } catch (err) {
      debugLog('mcp.close-error', `${this.serverName}: ${String(err)}`)
    } finally {
      this.notifyClosed()
      this.client = null
      this.transport = null
    }
  }

  private notifyClosed(): void {
    if (this.connectionState === 'closed') return
    this.connectionState = 'closed'
    const handlers = [...this.closeHandlers]
    this.closeHandlers.clear()
    for (const handler of handlers) this.invokeCloseHandler(handler)
  }

  private invokeCloseHandler(handler: () => void | Promise<void>): void {
    try {
      void Promise.resolve(handler()).catch((err) => {
        debugLog('mcp.close-handler-error', `${this.serverName}: ${String(err)}`)
      })
    } catch (err) {
      debugLog('mcp.close-handler-error', `${this.serverName}: ${String(err)}`)
    }
  }

  /** 把 stderr 尾部（如有）附加到连接错误上，使 /mcp list 显示的信息比
   *  "Connection closed" 更有用。 */
  private enrichError(err: unknown): Error {
    const base = err instanceof Error ? err : new Error(String(err))
    if (this.stderrTail.length === 0) return base
    const tail = this.stderrTail.slice(-5).join(' | ')
    const enriched = new Error(`${base.message} — stderr: ${tail}`)
    enriched.stack = base.stack
    return enriched
  }
}

/** 从 SDK 模式匹配 UnauthorizedError，而不依赖 instanceof（当 SDK 在不同
 *  esm/cjs 根下被复制时，跨打包边界的 instanceof 可能很脆弱）。不过 SDK
 *  直接导出了该类，所以我们两种检查都用。 */
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof Error) {
    if (err.name === 'UnauthorizedError') return true
    if (/unauthorized|401/i.test(err.message)) return true
  }
  return false
}

function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes))
}

function boundedJsonRecord(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) return undefined
  } catch {
    return undefined
  }
  return value as Record<string, unknown>
}

/** 展平 MCP 调用结果的 content block。MCP 响应是 `{ type: "text" | "image" |
 *  ... }` 块的数组。文本块拼接成单个字符串；图片块被提到 `images` 上
 *  （base64 + 媒体类型），使 tool_result 能把它们作为真正的媒体部件传给
 *  视觉模型（浏览器截图）。内联保留一段简短的文本标记，使文本路径（以及
 *  会在下游对图片做 OCR 的纯文本 provider）仍能得知有图片被返回。 */
function flattenCallResult(result: unknown): McpCallResult {
  const r = result as { content?: Array<unknown>; isError?: boolean }
  const blocks = Array.isArray(r.content) ? r.content.slice(0, MAX_CONTENT_BLOCKS) : []
  const parts: string[] = []
  const images: Array<{ data: string; mediaType: string }> = []
  let remainingTextBytes = MAX_RESOURCE_TEXT_BYTES
  let remainingImageChars = MAX_RESULT_IMAGE_BASE64_CHARS
  for (const b of blocks) {
    const block = b as { type?: string; text?: string; data?: unknown; mimeType?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = truncateText(block.text, remainingTextBytes)
      if (text) parts.push(text)
      remainingTextBytes -= Buffer.byteLength(text, 'utf8')
    } else if (block.type === 'image') {
      const mediaType = truncateText(block.mimeType ?? 'image/png', 256)
      if (
        typeof block.data === 'string' &&
        block.data.length > 0 &&
        images.length < MAX_RESULT_IMAGES &&
        block.data.length <= remainingImageChars
      ) {
        images.push({ data: block.data, mediaType })
        remainingImageChars -= block.data.length
        parts.push(`[image returned, ${mediaType}]`)
      } else {
        parts.push(`[image content omitted, mimeType=${mediaType}]`)
      }
    } else if (block.type === 'resource') {
      // 内嵌 resource——展示一行标记 + 任何嵌套文本。
      const nested = (block as { resource?: { text?: string; uri?: string } }).resource
      if (nested?.text) {
        const text = truncateText(nested.text, remainingTextBytes)
        if (text) parts.push(text)
        remainingTextBytes -= Buffer.byteLength(text, 'utf8')
      } else if (nested?.uri) parts.push(`[resource: ${nested.uri}]`)
    } else if (block.type) {
      parts.push(`[${truncateText(block.type, 256)} content]`)
    }
  }
  return {
    text: parts.join('\n').trim() || '(empty response)',
    isError: r.isError === true,
    ...(images.length > 0 ? { images } : {}),
  }
}
