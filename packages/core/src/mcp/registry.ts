// @x-code-cli/core — MCP registry
//
// 由 `loadMcpServers` 在 CLI 启动时构建一次，之后整个会话基本稳定——但不再
// 完全冻结。存在两个变更入口：
//
//   - `restartAll(newConfigs?)`（由 /mcp refresh 使用）——断开并重连每个
//     服务器，可选地换成从磁盘新读的配置，使新添加的条目无需重启 CLI 即可
//     出现。
//   - `authenticateServer(name, hooks)`（由 /mcp auth <name> 使用）——为一个
//     HTTP 服务器驱动一次新的 OAuth 往返，然后重连它。
//
// 两个方法都就地变更 registry 的内部映射，使 `AgentOptions` 持有的
// `options.mcpRegistry` 引用始终指向一个有效的 registry——agent loop 和
// 工具执行无需重接任何东西。调用方负责事后把 `state.systemPromptCache`
// 置空：工具面已经变了，OpenAI 兼容 provider 的前缀缓存（见 CLAUDE.md 里
// 关于字节稳定性约束的说明）必须失效。App.tsx 中的 `/mcp` 斜杠命令处理器
// 通过 useAgent 上的 `invalidateSystemPromptCache()` 来做这件事。
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import { debugLog, errorMessage } from '../utils.js'
import { McpClient } from './client.js'
import { UnsafeEnvError, assertSafeEnv } from './env-safety.js'
import { EnvExpansionError, expandEnvDeep } from './expand-env.js'
import { buildCallableName } from './name-mangling.js'
import {
  type McpCallResult,
  type McpResourceEntry,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolEntry,
  isHttpConfig,
  isStdioConfig,
} from './types.js'

/** 为一个 HTTP 服务器构建 OAuth provider。Stdio 服务器得到 `undefined`。
 *  当 OAuth 未在 CLI 层接线（没配置 token storage）时，HTTP 服务器也返回
 *  `undefined`。 */
export type OAuthProviderFactory = (serverName: string, serverUrl: string) => OAuthClientProvider | undefined

export interface RegisteredServer {
  name: string
  client: McpClient
  status: McpServerStatus
  /** 当状态为 `failed` 时，最近的 stderr 尾部（仅 stdio）。
   *  由 /mcp list 用来展示服务器为何失败。 */
  stderrTail?: string
}

/** /mcp auth 处理器传入的钩子，使 registry 能在不依赖 CLI 层的情况下
 *  呈现人类可见的进度。 */
export interface AuthHooks {
  /** 恰好在浏览器打开前调用一次。收到 SDK 即将重定向到的授权 URL。 */
  onBrowserOpen?: (url: string) => void
}

/** `restartAll` 实际改了什么摘要，用于 /mcp refresh 的输出行。 */
export interface RestartSummary {
  /** 重启后出现、之前没有的服务器名。 */
  added: string[]
  /** 被移除的服务器名（之前有，新配置里没有）。 */
  removed: string[]
  /** 两边都有但配置不同的服务器名。 */
  changed: string[]
  /** 重启后未变的服务器名。 */
  unchanged: string[]
}

export class McpRegistry {
  /** callableName → 条目。callableName 是面向模型的
   *  `<server>__<tool>` 形式；冲突在插入时解决。 */
  private readonly entries = new Map<string, McpToolEntry>()
  /** uri → 条目。URI 按规范唯一；若两个服务器真的暴露同一 URI，
   *  我们保留第一个并告警（由 loader 处理）。 */
  private readonly resources = new Map<string, McpResourceEntry>()
  private readonly servers = new Map<string, RegisteredServer>()
  /** 每个服务器最近一次加载的配置。是 `restartServer`（用同一配置重连）和
   *  `restartAll`（拿到新配置时）diff 的事实来源。 */
  private readonly configs = new Map<string, McpServerConfig>()
  /** 每个服务器 OAuth provider 的工厂。可选——undefined 意味着需要认证的
   *  HTTP 服务器会呈现为 `needs_auth`，/mcp auth 处理器无法驱动它们。 */
  private oauthFactory: OAuthProviderFactory | undefined

  constructor(input: {
    servers: RegisteredServer[]
    tools: McpToolEntry[]
    resources: McpResourceEntry[]
    /** 启动时使用的每服务器配置。`restartServer` / `authenticateServer`
     *  需要它来知道要重建什么。 */
    configs?: Map<string, McpServerConfig>
    /** 从 CLI 穿下来的 OAuth provider 工厂。 */
    oauthFactory?: OAuthProviderFactory
  }) {
    for (const s of input.servers) this.servers.set(s.name, s)
    for (const t of input.tools) this.entries.set(t.callableName, t)
    for (const r of input.resources) {
      if (!this.resources.has(r.uri)) this.resources.set(r.uri, r)
    }
    if (input.configs) for (const [k, v] of input.configs) this.configs.set(k, v)
    this.oauthFactory = input.oauthFactory
  }

  // ── 工具面 ───────────────────────────────────────────────────────

  /** 每个面向模型的工具名快照；稳定的迭代顺序。
   *  由 `buildTools`（agent loop）和 `buildSystemPrompt` 消费。 */
  list(): McpToolEntry[] {
    return [...this.entries.values()]
  }

  /** 这个 registry 是否暴露任何模型能用的东西。零配置场景也存在一个
   *  registry 对象，所以仅凭对象存在不能宣告 MCP 工具或资源辅助器。 */
  hasModelCapabilities(): boolean {
    return this.entries.size > 0 || this.resources.size > 0
  }

  get(callableName: string): McpToolEntry | undefined {
    return this.entries.get(callableName)
  }

  // ── 资源面 ───────────────────────────────────────────────────

  listResources(): McpResourceEntry[] {
    return [...this.resources.values()]
  }

  /** 找到拥有某 URI 的服务器，使 resource 工具能分派读取。未知 URI 返回
   *  undefined。 */
  resourceServer(uri: string): McpClient | undefined {
    const r = this.resources.get(uri)
    if (!r) return undefined
    return this.servers.get(r.serverName)?.client
  }

  // ── 服务器面（供 /mcp list / status）───────────────────────────

  serverStatus(): Array<{ name: string; status: McpServerStatus; stderrTail?: string }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      stderrTail: s.stderrTail,
    }))
  }

  getServer(serverName: string): RegisteredServer | undefined {
    return this.servers.get(serverName)
  }

  getConfig(serverName: string): McpServerConfig | undefined {
    return this.configs.get(serverName)
  }

  // ── 分派 ───────────────────────────────────────────────────────────

  /** 通过面向模型的可调用名调用一个 MCP 工具。查找条目，找到其所属服务器，
   *  转发给 SDK 客户端。 */
  async callTool(callableName: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const entry = this.entries.get(callableName)
    if (!entry) throw new Error(`MCP tool not found: ${callableName}`)
    const server = this.servers.get(entry.serverName)
    if (!server) throw new Error(`MCP server gone: ${entry.serverName}`)
    return server.client.callTool(entry.rawName, args, signal)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /** 干净地断开每个服务器。尽力而为：一次糟糕的关停不会阻止其他服务器运行。
   *  由 CLI 退出钩子调用，以及（内部）由 `restartAll` 在重建前调用。 */
  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const s of this.servers.values()) {
      tasks.push(
        s.client.close().catch(() => {
          // 已在 client.safeClose 里记录日志；这里没什么有用的可做
        }),
      )
    }
    await Promise.allSettled(tasks)
  }

  // ── 异步启动 ───────────────────────────────────────────────────────

  /** 连接所有配置已注册的服务器。为异步启动路径设计：registry 创建时服务器
   *  处于 `connecting` 状态、没有工具；此方法真正（并行地）连接它们并装好
   *  得到的工具/资源。全部连接尘埃落定后触发 `onReady`，使调用方能失效缓存。
   *
   *  调用一次即安全；第二次调用是 no-op（立即返回）。 */
  async connectAll(onReady?: () => void): Promise<void> {
    if (this.connectAllRan) return
    this.connectAllRan = true

    const tasks = [...this.configs.entries()].map(async ([name, config]) => {
      try {
        const result = await connectOneServer(name, config, this.oauthFactory)
        this.removeServerEntries(name)
        this.installServer(result)
      } catch (err) {
        debugLog('mcp.connectAll-failed', `${name}: ${String(err)}`)
        const existing = this.servers.get(name)
        if (existing) {
          existing.status = { kind: 'failed', error: errorMessage(err) }
        }
      }
    })
    await Promise.allSettled(tasks)
    onReady?.()
  }

  private connectAllRan = false

  // ── 重启 / 刷新 ──────────────────────────────────────────────────

  /** 用其当前配置就地重连一个服务器。由 `authenticateServer`（新 token
   *  保存之后）使用，也暴露给想要不整刷就单服务器重载的调用方。
   *
   *  旧连接的工具 / 资源条目会被丢弃，换成新连接枚举到的任何东西——若
   *  服务器的 `tools/list` 输出在两次重连间变化，工具名可能改变。调用方
   *  必须在此返回后失效 agent 的 systemPromptCache。 */
  async restartServer(name: string, opts: { driveOAuth?: AuthHooks } = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`No MCP server registered as "${name}"`)
    }
    // 在 spawn 替换前关闭现有客户端（若有）——对 stdio 服务器来说这会杀掉
    // 之前的子进程，不留僵尸。错误不致命：一条无法干净关闭的断连仍应被替换。
    const existing = this.servers.get(name)
    if (existing) {
      try {
        await existing.client.close()
      } catch (err) {
        debugLog('mcp.restart-close-failed', `${name}: ${String(err)}`)
      }
    }

    // 剥离此服务器拥有的旧工具 / 资源。在*新连接之前*做，使重连中途的部分
    // 失败让我们处于一致的 "此服务器一无所有" 状态，而不是旧的 + 无的混合。
    this.removeServerEntries(name)

    const result = await connectOneServer(name, config, this.oauthFactory, opts.driveOAuth)
    this.installServer(result)
    return result.server
  }

  /** 断开一切并按 `newConfigs`（或省略时按现有配置）重建。返回 diff 摘要，
   *  使 UI 能告诉用户实际改了什么。
   *
   *  由 `/mcp refresh` 使用：重读用户 + 项目配置文件，把合并后的映射传进来，
   *  我们会添加 / 移除 / 重启相应集合。配置字节没变的服务器仍会重连——
   *  对用户更清爽，也比 diff 每个嵌套字段简单。 */
  async restartAll(newConfigs?: Map<string, McpServerConfig>): Promise<RestartSummary> {
    const oldNames = new Set(this.configs.keys())
    const newNames = new Set((newConfigs ?? this.configs).keys())

    const summary: RestartSummary = {
      added: [...newNames].filter((n) => !oldNames.has(n)),
      removed: [...oldNames].filter((n) => !newNames.has(n)),
      changed: [],
      unchanged: [],
    }

    if (newConfigs) {
      for (const name of newNames) {
        if (!oldNames.has(name)) continue
        const before = JSON.stringify(this.configs.get(name))
        const after = JSON.stringify(newConfigs.get(name))
        if (before !== after) summary.changed.push(name)
        else summary.unchanged.push(name)
      }
    } else {
      summary.unchanged = [...newNames]
    }

    // 先整体拆除。先 close-all 再 connect-all（而非逐个 close+connect）更可
    // 预测：我们绝不会同时有两个同一服务器的客户端存活，且 stdio 子进程
    // 一定在其替换者 spawn 之前退出。
    await this.shutdown()

    // 重置内部状态。保留 OAuth 工厂，因为它来自 CLI 进程、不绑定任何单个配置。
    this.servers.clear()
    this.entries.clear()
    this.resources.clear()
    this.configs.clear()
    const effective = newConfigs ?? new Map<string, McpServerConfig>()
    for (const [k, v] of effective) this.configs.set(k, v)

    // 并行重连——与初始启动相同的方式。每个失败都记为 `status: failed`，
    // 而不是中止重启。
    const tasks = [...effective.entries()].map(async ([name, config]) => {
      try {
        return await connectOneServer(name, config, this.oauthFactory)
      } catch (err) {
        debugLog('mcp.restartAll-connect-failed', `${name}: ${String(err)}`)
        return null
      }
    })
    const results = await Promise.all(tasks)

    // 按名字排序，使工具插入顺序稳定（与 loader.ts 中初始启动行为一致）。
    const installable = results
      .filter((r): r is ConnectResult => r !== null)
      .sort((a, b) => a.server.name.localeCompare(b.server.name))
    for (const r of installable) this.installServer(r)

    return summary
  }

  /** 为一个 HTTP 服务器驱动一次新的 OAuth 往返，然后重连它。
   *  由 `/mcp auth <name>` 使用。
   *
   *  前置条件：调用方应刚通过 token storage 的 `clear()` 清掉该服务器任何
   *  过期 token——否则一个已存在但过期的 token 可能短路重认证路径、复用
   *  坏状态。
   *
   *  返回认证后的服务器状态。若服务器是 stdio（无需 OAuth）、没接线 OAuth
   *  工厂、或用户关掉浏览器标签页 / 回调超时，则抛出。 */
  async authenticateServer(name: string, hooks: AuthHooks = {}): Promise<RegisteredServer> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`No MCP server registered as "${name}"`)
    if (!isHttpConfig(config)) {
      throw new Error(`MCP server "${name}" is stdio — OAuth applies to HTTP servers only`)
    }
    if (!this.oauthFactory) {
      throw new Error(`OAuth not configured — set a token storage in the loader to use /mcp auth`)
    }

    return this.restartServer(name, { driveOAuth: hooks })
  }

  /** 整体替换 OAuth 工厂。当 token storage / onBrowserOpen 接线在 registry
   *  构造后才惰性建立时由 CLI 使用（罕见，但测试 harness 需要换掉它）。 */
  setOAuthFactory(factory: OAuthProviderFactory | undefined): void {
    this.oauthFactory = factory
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  /** 丢弃该服务器拥有的每个工具 + 资源。幂等。 */
  private removeServerEntries(name: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverName === name) this.entries.delete(key)
    }
    for (const [key, res] of this.resources) {
      if (res.serverName === name) this.resources.delete(key)
    }
  }

  /** 把新的 ConnectResult 装进映射。调用方负责先移除同一服务器的任何
   *  之前条目。 */
  private installServer(r: ConnectResult): void {
    this.servers.set(r.server.name, r.server)
    const taken = new Set(this.entries.keys())
    for (const t of r.tools) {
      const callable = buildCallableName(r.server.name, t.name, taken)
      taken.add(callable)
      this.entries.set(callable, {
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })
    }
    for (const res of r.resources) {
      if (!this.resources.has(res.uri)) this.resources.set(res.uri, res)
    }
  }
}

/** 空 registry——当 MCP 整体禁用（配置里没有 mcpServers，或信任对话框被
 *  拒绝）时使用。比在下游处处判空便宜。 */
export function emptyRegistry(): McpRegistry {
  return new McpRegistry({ servers: [], tools: [], resources: [] })
}

// ── 连接辅助器（与 loader.ts 在初始启动时共享）──────────────

/** 一个服务器的 "connect + enumerate" 输出。在初始启动（`loadMcpServers`）
 *  与 registry 的重启路径之间共享，使连接形状保持一致。 */
export interface ConnectResult {
  server: RegisteredServer
  tools: ReadonlyArray<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: Record<string, unknown>
  }>
  resources: ReadonlyArray<McpResourceEntry>
}

/** 为一个服务器构建客户端、跑连接握手、报告枚举到的能力。`driveOAuth`
 *  （设置时）在 UnauthorizedError 上切入完整的基于浏览器的 OAuth 流程；
 *  没有它，UnauthorizedError 呈现为 `status: needs_auth`，期望用户显式调用
 *  /mcp auth。可选的 abort signal 覆盖冷子进程启动以及 initialize 握手。 */
export async function connectOneServer(
  name: string,
  rawConfig: McpServerConfig,
  oauthFactory: OAuthProviderFactory | undefined,
  driveOAuth?: AuthHooks,
  abortSignal?: AbortSignal,
): Promise<ConnectResult> {
  // 尊重 `enabled: false`——注册但跳过连接。
  if (rawConfig.enabled === false) {
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'disabled' } },
      tools: [],
      resources: [],
    }
  }

  // 在构建客户端前展开 ${VAR} 引用。然后对 stdio 配置执行 env 安全检查——
  // 这是每个 env 来源（CLI 标志、mcp.json、插件清单）都要流经的唯一咽喉点，
  // 所以在这里拒绝一个坏 key 就能全部覆盖。威胁模型见 env-safety.ts。
  let expanded: McpServerConfig
  try {
    expanded = expandEnvDeep(rawConfig)
    if (isStdioConfig(expanded)) assertSafeEnv(expanded.env)
  } catch (err) {
    const msg =
      err instanceof EnvExpansionError || err instanceof UnsafeEnvError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    const client = new McpClient(name, rawConfig)
    return {
      server: { name, client, status: { kind: 'failed', error: msg } },
      tools: [],
      resources: [],
    }
  }

  const authProvider = oauthFactory && isHttpConfig(expanded) ? oauthFactory(name, expanded.url) : undefined
  const client = new McpClient(name, expanded, authProvider)

  try {
    const info = driveOAuth ? await client.connectWithOAuth(driveOAuth) : await client.connect(abortSignal)
    return {
      server: {
        name,
        client,
        status: { kind: 'connected', toolCount: info.toolCount, resourceCount: info.resourceCount },
      },
      tools: client.tools(),
      resources: client.resources(),
    }
  } catch (err) {
    const msg = errorMessage(err)
    const needsAuth = /unauth|401|UnauthorizedError/i.test(msg) && isHttpConfig(expanded)
    const status: RegisteredServer['status'] = needsAuth ? { kind: 'needs_auth' } : { kind: 'failed', error: msg }
    return {
      server: { name, client, status, stderrTail: client.stderr() || undefined },
      tools: [],
      resources: [],
    }
  }
}
