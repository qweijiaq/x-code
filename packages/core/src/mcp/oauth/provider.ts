// @x-code-cli/core — OAuthClientProvider 实现
//
// 把 MCP SDK 的认证流程接到我们的持久化 + UX 上：
//
//   - tokens()                 — 从 McpTokenStorage 读取
//   - saveTokens()             — 写入 McpTokenStorage
//   - clientInformation()      — 从 McpTokenStorage 读取
//   - saveClientInformation()  — 写入 McpTokenStorage（涵盖
//                                RFC 7591 动态注册结果）
//   - codeVerifier() / save    — 保存在进程内存中；PKCE verifier
//                                每次认证流程只使用一次
//   - redirectUrl              — 设为刚启动的本地回调服务器 URL
//   - redirectToAuthorization  — 在用户浏览器中打开 URL
//
// 每个服务器一个实例。由 loader.ts 中的工厂惰性构建。
//
// 外部浏览器启动器：我们用 `node:child_process` 来 spawn 平台默认的打开器
// （Windows 上 `start`，macOS 上 `open`，Linux 上 `xdg-open`）。不引入
// npm 依赖——跨平台的 `open` 包虽好，但会多拉入 200KB。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { spawn } from 'node:child_process'

import { debugLog } from '../../utils.js'
import { type RunningCallbackServer, startCallbackServer } from './callback-server.js'
import { McpTokenStorage } from './token-storage.js'

const CLIENT_METADATA_BASE: Omit<OAuthClientMetadata, 'redirect_uris'> = {
  client_name: 'X-Code CLI',
  client_uri: 'https://github.com/qweijiaq/x-code',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

export interface CreateProviderOptions {
  serverName: string
  serverUrl: string
  storage: McpTokenStorage
  /** 应在浏览器打开前一刻调用的回调，
   *  例如向 CLI UI 打印 "Opening browser for sentry auth..."。 */
  onOpenBrowser?: (url: string) => void
}

/** 具体 provider，接上读取的持久化状态 + 一个按需启动的回调服务器。
 *  跨同一服务器的多次 connect / refresh 尝试复用。 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** 当前运行中的回调服务器。我们保留句柄，使（第一次尝试失败后的）第二次
   *  redirectToAuthorization 调用复用同一端口，而不是再开一个监听器。 */
  private callbackServer: RunningCallbackServer | null = null
  /** PKCE verifier——仅保存在内存中，每次新流程都会替换。 */
  private memoryCodeVerifier: string | null = null
  /** SDK 将在 transport 上通过 `finishAuth` 消费的待处理回调。
   *  `waitForAuthCode()` 的调用方会取走它。 */
  private pendingCode: Promise<{ code: string; state?: string }> | null = null
  /** `redirectToAuthorization` 是否真的应该启动浏览器。
   *  默认 false——带着一个没有存储 token 的 HTTP MCP 服务器启动 CLI
   *  绝不能悄悄打开浏览器窗口。该标志在 `connectWithOAuth` 期间（由
   *  `/mcp auth <name>` 驱动）翻转为 true，并在 `finally` 中翻回 false。 */
  private interactive = false

  constructor(private readonly opts: CreateProviderOptions) {}

  /** 调用方（client.ts:connectWithOAuth）在一段认证流程前后切换它。
   *  在该窗口之外我们保持被动。 */
  setInteractive(value: boolean): void {
    this.interactive = value
  }

  /** 提前启动回调服务器，使真实的 loopback 端口在 SDK 构建动态注册请求
   *  *之前*就可用于 `redirectUrl` 和 `clientMetadata.redirect_uris`。
   *
   *  为什么重要：Sentry（以及任何不严格遵循 RFC 8252 §7.3 的认证服务器）
   *  会用客户端注册时的值校验认证 URL 的 `redirect_uri`。如果我们用无端口
   *  占位符注册，随后重定向到具体端口，服务器会回复 "Invalid redirect URI"，
   *  整个流程就失败了。预先启动服务器可保证注册与授权使用*同一个*具体的
   *  `http://127.0.0.1:<port>/callback`。 */
  async prepareForAuth(): Promise<void> {
    this.interactive = true
    await this.ensureCallbackServer()
  }

  // ── OAuthClientProvider ────────────────────────────────────────────────

  get redirectUrl(): string {
    // SDK 实际上是在 `redirectToAuthorization` 触发*之前*读取 `redirectUrl`
    // 的（例如在没有任何存储 token 的首次连接尝试期间构造授权 URL 时）。
    // 早先的版本在这里抛出，导致 HTTP 服务器在 `/mcp add` 后的首次启动时
    // 表现为 `failed` 而非预期的 `needs_auth`。
    //
    // 我们返回 `clientMetadata.redirect_uris` 已经在用的同一个 loopback
    // 占位符。RFC 8252 §7.3 说授权服务器必须接受已注册 loopback redirect_uri
    // 上的任何端口，所以无端口的占位符对注册往返来说是没问题的；
    // `redirectToAuthorization` 会在启动浏览器之前，用真实端口重写实际的
    // `redirect_uri` 查询参数。
    return this.callbackServer?.url ?? 'http://127.0.0.1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...CLIENT_METADATA_BASE,
      // 服务器起来后由 redirectToAuthorization 填充。在那之前，SDK 可能在
      // 动态注册期间检查此对象——我们用占位符；反正 SDK 会覆盖注册响应。
      redirect_uris: [this.callbackServer?.url ?? 'http://127.0.0.1/callback'],
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.clientInformation
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.opts.storage.setClientInformation(this.opts.serverName, this.opts.serverUrl, info)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.opts.storage.get(this.opts.serverName)
    return stored?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.storage.setTokens(this.opts.serverName, this.opts.serverUrl, tokens)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error('No PKCE verifier set — auth flow not in progress')
    }
    return this.memoryCodeVerifier
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 被动（启动）模式：SDK 正处在没有存储 token 的"惰性"首次连接中途。
    // 我们绝不能未经提示就打开浏览器窗口——其他每个 MCP 感知的 CLI
    // （Claude Code、Gemini、OpenCode）都会等用户明确操作后才这么做，
    // 而一个劫持用户浏览器的 CLI 启动是充满敌意的惊吓。这里直接返回即可：
    // SDK 接下来会抛出 UnauthorizedError，registry 把它归类为 `needs_auth`，
    // 而 `/mcp auth <name>` 可以驱动真正的流程（在 setInteractive(true)
    // 把我们翻转到下面的交互路径之后）。
    if (!this.interactive) {
      return
    }

    // 在把认证 URL 交给浏览器前一刻惰性启动回调服务器，使我们（通过
    // `redirectUrl`）宣告的 URL 与我们实际监听的 URL 一致。我们用反映真实
    // 端口的更新后 redirect_uri 重建认证 URL。
    await this.ensureCallbackServer()
    authorizationUrl.searchParams.set('redirect_uri', this.callbackServer!.url)

    this.opts.onOpenBrowser?.(authorizationUrl.toString())
    await openInBrowser(authorizationUrl.toString())

    // 暂存待处理回调，使调用方能通过 `waitForAuthCode()` await 它，
    // 同时 transport 机制处理 token 交换步骤。
    this.pendingCode = this.callbackServer!.waitForCallback()
  }

  // ── /mcp auth 处理器使用的辅助方法 ─────────────────────────────────

  /** 阻塞直到认证服务器重定向回来。以捕获的 code resolve；调用方随后在
   *  SDK 的 StreamableHTTPClientTransport 上调用
   *  `transport.finishAuth(code)`。
   *
   *  这里关闭回调服务器是因为我们已经拿到 code——Sentry 不会在此流程中
   *  再次回调我们。但我们保留 `memoryCodeVerifier`：SDK 会在
   *  `transport.finishAuth(code)` 期间读取它，而调用方是在此 promise
   *  resolve *之后*才运行的。曾在这个 finally 块中置空 verifier，正是
   *  "No PKCE verifier set — auth flow not in progress" 的成因。
   *  verifier 的清理要么通过 `cancel()`（中止路径）完成，要么在下一次
   *  `saveCodeVerifier(...)` 调用时自然完成。 */
  async waitForAuthCode(): Promise<{ code: string; state?: string }> {
    if (!this.pendingCode) {
      throw new Error('Auth flow not started — redirectToAuthorization was never invoked')
    }
    try {
      return await this.pendingCode
    } finally {
      this.pendingCode = null
      this.callbackServer?.close()
      this.callbackServer = null
    }
  }

  /** 丢弃任何进行中的流程而不保存。任何时候调用都安全。 */
  cancel(): void {
    this.callbackServer?.close()
    this.callbackServer = null
    this.pendingCode = null
    this.memoryCodeVerifier = null
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return
    this.callbackServer = await startCallbackServer()
  }
}

/** 尽力而为的跨平台 `open <url>`。detached 使 CLI 不会阻塞在浏览器进程上；
 *  stdio 接到 /dev/null，使输出不会抹脏我们的终端 UI。失败会记录日志但
 *  绝不抛出——用户仍可手工复制/粘贴 URL。 */
async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // 这里刻意避开 `cmd /c start`。cmd.exe 把 `&` 当作命令分隔符，所以像
      //   https://x.com/auth?response_type=code&client_id=abc&code_challenge=...
      // 这样的 OAuth URL 会被悄悄截断成
      // `https://x.com/auth?response_type=code`——用户的浏览器落在一个没有
      // client_id / redirect_uri / PKCE challenge 的 URL 上，Sentry 回复
      // "Invalid redirect URI"。Node 的 argv 引号处理不会给 `&` 加引号
      // （它不是 Windows 原生特殊字符，只是 cmd 内置特殊字符），所以即使
      // 把 URL 作为单独参数传递也无济于事。
      //
      // `rundll32 url.dll,FileProtocolHandler <url>` 是调用默认浏览器协议
      // 处理器的文档化 Win32 方式。它完全绕过 cmd，因此 `&` 原样透传。
      spawnDetached('rundll32', ['url.dll,FileProtocolHandler', url])
      return
    }
    if (process.platform === 'darwin') {
      // macOS 的 `open` 处理 URL 非常可靠，没有怪癖。
      spawnDetached('open', [url])
      return
    }

    // Linux / *BSD：没有哪一条命令到处都管用。xdg-utils（`xdg-open`）
    // 是事实标准，但在最小容器和许多服务器发行版上缺失；`gio open` 覆盖
    // 较新的 GNOME 栈；`wslview` 覆盖 WSL → Windows 浏览器（当 WSL 内的
    // xdg-open 到不了宿主机时）；`kde-open` 和 `gnome-open` 覆盖各自遗留的
    // 桌面。
    //
    // 我们逐个尝试，遇到 ENOENT 或非零退出就落到下一个。找不到打开器时
    // 静默失败会让用户盯着 CLI 回滚区纳闷为何什么都没发生——我们输出一条
    // `mcp.browser-open-no-opener` 调试条目，使该情况至少可诊断，而 CLI 的
    // "Opened …" 一行已经给了他们可手工复制/粘贴的 URL。
    const candidates: Array<[string, string[]]> = [
      ['xdg-open', [url]],
      ['gio', ['open', url]],
      ['wslview', [url]],
      ['kde-open', [url]],
      ['gnome-open', [url]],
    ]
    for (const [cmd, args] of candidates) {
      if (await trySpawnOpener(cmd, args)) return
    }
    debugLog('mcp.browser-open-no-opener', `no working URL opener found; advised user to copy/paste manually`)
  } catch (err) {
    debugLog('mcp.browser-open-threw', String(err))
  }
}

/** 起一个子进程，detach，然后走人。用于 Windows/macOS 上命令已知可靠的情况
 *  ——失败检测只是一条调试日志。 */
function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.unref()
  child.on('error', (err) => debugLog('mcp.browser-open-failed', String(err)))
}

/** 尝试一个 Linux URL 打开器候选。若二进制存在，且要么干净退出、要么在短暂
 *  宽限窗口后仍存活，则 resolve true（多数打开器 exec 进浏览器并几乎立即
 *  退出，但少数——尤其是冷启动的 wslview——会 fork 并保持运行片刻）。
 *  遇到 ENOENT 或非零退出则 resolve false，示意调用方尝试下一个候选。 */
function trySpawnOpener(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch {
      settle(false)
      return
    }
    child.on('error', () => settle(false))
    child.on('exit', (code) => {
      if (code === 0) {
        child.unref()
        settle(true)
      } else {
        settle(false)
      }
    })
    // 为 fork 后仍存活的打开器设置的宽限窗口。500 ms 远低于用户可感知的
    // 延迟，却覆盖了最慢的合理启动路径；到此时仍存活的几乎肯定是真正启动
    // 浏览器的进程。
    setTimeout(() => {
      if (!settled) {
        child.unref()
        settle(true)
      }
    }, 500)
  })
}

/** loader.ts 使用的工厂。对 stdio 服务器返回 undefined——loader 会为它们
 *  跳过 OAuth 构造。 */
export function createOAuthProviderFactory(
  storage: McpTokenStorage,
  onOpenBrowser?: (serverName: string, url: string) => void,
) {
  return (serverName: string, serverUrl: string): McpOAuthProvider => {
    return new McpOAuthProvider({
      serverName,
      serverUrl,
      storage,
      onOpenBrowser: onOpenBrowser ? (url) => onOpenBrowser(serverName, url) : undefined,
    })
  }
}
