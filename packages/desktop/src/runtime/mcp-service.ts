import {
  McpPermissionStore,
  createOAuthProviderFactory,
  debugLog,
  detectScope,
  emptyRegistry,
  errorMessage,
  getTokenStorage,
  isHttpConfig,
  loadMcpConfigsFromDisk,
  removeServerFromConfig,
  serverExists,
  trustProject,
  writeServerToConfig,
} from '@x-code-cli/core'
import type { McpRegistry, McpServerConfig, McpServerStatus } from '@x-code-cli/core'

import type { McpServerStatusView, McpServerView } from '../shared/protocol.js'
import { SKILLSMP_MCP_URL } from './skill-market.js'

/** 桌面端没有人能回答项目的 MCP 信任对话框，所以必须落到「跳过」语义。
 *
 *  `promptForTrust` 的契约是：只有与 `Trust this project` / `Exit X-Code`
 *  完全相等才分别返回 'trust' / 'exit'，其他任何答案（含空串）都按
 *  'skip' 处理。因此兜底值取 'skip' 语义的显式 sentinel，绝不能回退到
 *  `options[0]`/`options[1]`——选项顺序一变就会静默选中 "Trust this
 *  project"，在无人确认的情况下写入项目信任记录（权限边界问题，不只是 UX）。 */
const SKIP_ANSWER = 'Skip project MCP'

function chooseSafeOption(options: Array<{ label: string; description: string }>): string {
  // 词边界：`/no/` 会误命中 "node"/"notice" 之类的标签；描述文本里也写明
  // 了「不写盘」，一并作为跳过语义的依据。
  const safe = options.find(
    (option) =>
      /\b(skip|no|not now)\b|不加载|稍后|忽略/i.test(option.label) ||
      /\b(skip|no write|not load)\b|不写盘/i.test(option.description),
  )
  return safe?.label ?? SKIP_ANSWER
}

const REDACTED = '••••'
/** 键名命中即整值脱敏（`apiKey`/`accessToken`/`clientSecret`/…）。 */
const SENSITIVE_KEY = /(key|token|secret|password|authorization|credential)/i
/** `?key=…&token=…` 这类 query 参数。 */
const SENSITIVE_QUERY_KEY = /(key|token|secret|password|authorization|credential|sig|signature)/i

/** `scheme://user:pass@host` 里的 userinfo。 */
const URL_USERINFO = /([a-z][\w+.-]*:\/\/)[^/\s@]*@/gi
/** `Authorization: Bearer xxx` / `--token yyy` / `api_key=zzz` 这类内联凭据。 */
const INLINE_SECRET =
  /((?:^|[\s=&?])(?:--)?(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential)(?:[:\s]?[=:]\s*|\s+))(?:(?:bearer|basic|token)\s+)?\S+/gi

/** stdio 的 `args` 常把凭据直接写在参数里
 *  （`["--header", "Authorization: Bearer sk-…"]`、`["--token", "…"]`），
 *  这些值既不叫 env 也不叫 headers，旧的脱敏只处理顶层字段，会原样漏给
 *  renderer。 */
function redactString(value: string): string {
  return (
    value
      .replace(URL_USERINFO, '$1')
      // query 值用 ASCII 占位符：`?key=••••` 会被 URL 编码成 `%E2%80%A2…`，
      // 反而看不出这里被脱敏了。
      .replace(/([?&])([^=&\s#]+)=([^&\s#]*)/g, (match, sep: string, name: string) =>
        SENSITIVE_QUERY_KEY.test(name) ? `${sep}${name}=REDACTED` : match,
      )
      .replace(INLINE_SECRET, (_match, prefix: string) => `${prefix}${REDACTED}`)
  )
}

/** `--token` / `--api-key` / `--client-secret` / `--auth_token` / `--clientSecret`
 *  这类型 flag 的值整体脱敏。中间的 `-`/`_`/数字必须允许，否则
 *  `["--api-key", "sk-…"]` 这种相邻取值会被原样送给 renderer。 */
const SECRET_FLAG = /^--?[a-z0-9_-]*(?:key|token|secret|password|authorization|credential)s?$/i
/** `--header "Authorization: Bearer …"`：保留头名，值脱敏。 */
const HEADER_FLAG = /^--?(?:h|header|headers)$/i
const HEADER_VALUE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+:\s*)([\s\S]*)$/

/** stdio 的 `args` 惯用写法把 flag 与值拆成相邻元素
 *  （`["--token", "yyy"]`），只做字符串内匹配会漏掉。 */
function redactStringArray(values: unknown[], depth: number): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]
    const next = values[index + 1]
    if (typeof item === 'string' && typeof next === 'string') {
      if (HEADER_FLAG.test(item)) {
        const header = HEADER_VALUE.exec(next)
        out.push(item, header ? `${header[1]}${REDACTED}` : REDACTED)
        index += 1
        continue
      }
      if (SECRET_FLAG.test(item)) {
        out.push(item, REDACTED)
        index += 1
        continue
      }
    }
    out.push(redactValue(item, depth + 1))
  }
  return out
}

/** 递归脱敏：`oauth.clientSecret` 这类嵌套明钥不会被顶层判断跳过。 */
function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return depth >= 6 ? value : redactStringArray(value, depth)
  if (value && typeof value === 'object') {
    // 深度上限只为防环：插件贡献的配置是进程内对象，理论上可能自引用，
    // 递归进来会栈溢出。
    if (depth >= 6) return REDACTED
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, depth + 1)
    }
    return out
  }
  return value
}

function toStatusView(status: McpServerStatus, authUrls: Map<string, string>, name: string): McpServerStatusView {
  if (status.kind === 'disabled') return { kind: 'disabled' }
  if (status.kind === 'connecting') return { kind: 'connecting' }
  if (status.kind === 'connected')
    return { kind: 'connected', toolCount: status.toolCount, resourceCount: status.resourceCount }
  if (status.kind === 'needs_auth') return { kind: 'needs_auth', authUrl: authUrls.get(name) ?? status.authUrl }
  return { kind: 'failed', error: status.error }
}

export class McpService {
  private registry: McpRegistry = emptyRegistry()
  private permissionStore = new McpPermissionStore()
  private projectSkipped = false
  private authUrls = new Map<string, string>()
  private connecting: Promise<void> | null = null
  /** reload / shutdown 的串行化链。 */
  private lifecycleChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly workspace: string,
    private readonly extraServers: Record<string, McpServerConfig>,
    private readonly onChange: () => void,
    private readonly onAuthUrl?: (server: string, url: string) => void,
  ) {}

  async load(): Promise<void> {
    let oauthProviderFor: ReturnType<typeof createOAuthProviderFactory> | undefined
    try {
      oauthProviderFor = createOAuthProviderFactory(getTokenStorage(), (server, url) => {
        this.authUrls.set(server, url)
        this.onAuthUrl?.(server, url)
      })
    } catch (error) {
      // 静默丢弃会让之后所有远程 MCP 都只显示 needs_auth 而没有任何线索。
      oauthProviderFor = undefined
      debugLog('desktop.mcp-oauth-provider-failed', errorMessage(error))
    }

    let result: Awaited<ReturnType<typeof loadMcpConfigsFromDisk>>
    try {
      result = await loadMcpConfigsFromDisk({
        cwd: this.workspace,
        extraServers: this.extraServers,
        askUser: async (_question, options) => chooseSafeOption(options),
        oauthProviderFor,
      })
    } catch (error) {
      // 磁盘配置损坏时不能让 registry 停在半初始化状态：IPC 调用方要拿到
      // 与本文件其他方法一致的中文错误，而不是原始异常。
      throw new Error(`加载 MCP 配置失败：${errorMessage(error)}`)
    }
    this.registry = result.registry
    this.projectSkipped = result.projectSkipped
    try {
      await this.permissionStore.preload()
    } catch (error) {
      debugLog('desktop.mcp-permission-preload-failed', errorMessage(error))
    }

    if (this.registry.serverStatus().length > 0) {
      // 创建时就挂上 rejection handler：`connectAll` 内部用 allSettled 吞掉
      // 单台连接错误，但结尾的 onReady 回调（= onChange）一旦抛出，这个
      // promise 会立刻 reject，而 handler 直到下次 reload()/shutdown() 才
      // 附加——Node 默认策略下直接的 unhandled rejection 会终止进程。
      this.connecting = this.registry.connectAll(() => this.onChange()).catch(() => undefined)
    }
  }

  /**
   * renderer 只需要知道"配置了哪些 env/header 键"，不需要值。此前 list()
   * 原样返回 config，MCP 的 API key / Authorization 会进入 renderer 内存，
   * 与"凭据不回传 renderer"的边界冲突。
   */
  private redactConfig(config: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...config }
    for (const field of ['env', 'headers'] as const) {
      const value = redacted[field]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      redacted[field] = Object.fromEntries(Object.keys(value as Record<string, unknown>).map((key) => [key, REDACTED]))
    }
    // 其余字段（url / args / command / 嵌套的 oauth 等）按内容与键名脱敏：
    // URL 的 userinfo 与敏感 query、`--token xxx`、`clientSecret` 都不该
    // 进入 renderer 内存。
    for (const [field, value] of Object.entries(redacted)) {
      if (field === 'env' || field === 'headers') continue
      redacted[field] = SENSITIVE_KEY.test(field) ? REDACTED : redactValue(value)
    }
    return redacted
  }

  async list(): Promise<McpServerView[]> {
    const items: McpServerView[] = []
    for (const server of this.registry.serverStatus()) {
      const config = this.registry.getConfig(server.name) ?? this.extraServers[server.name]
      let scope: McpServerView['scope'] = 'user'
      if (this.extraServers[server.name]) scope = 'plugin'
      else {
        try {
          const detected = await detectScope(server.name, this.workspace)
          if (detected.kind === 'project') scope = 'project'
        } catch {
          scope = 'user'
        }
      }
      items.push({
        name: server.name,
        scope,
        enabled: config?.enabled !== false,
        config: config ? this.redactConfig(config as unknown as Record<string, unknown>) : {},
        status: toStatusView(server.status, this.authUrls, server.name),
      })
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    return items
  }

  async saveServer(name: string, config: unknown): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('服务器名称不能为空')
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('服务器配置必须是 JSON 对象')
    // 不再“先删后写”：writeServerToConfig 本身会校验并覆盖同名条目，
    // 先删会让一次写盘/校验失败连带丢掉用户的旧配置。
    await writeServerToConfig(trimmed, config as McpServerConfig, 'user', this.workspace)
    await this.reload()
  }

  async removeServer(name: string): Promise<void> {
    if (this.extraServers[name]) throw new Error('插件提供的 MCP 服务器请通过插件管理')
    const result = await removeServerFromConfig(name, 'user', this.workspace)
    if (!result.removed) {
      throw new Error('只能删除用户级 MCP 配置；项目级配置请直接编辑项目 .x-code/config.json')
    }
    await this.reload()
  }

  /** 在用户作用域注册只读的 SkillsMP MCP 服务器。只有
   *  精确匹配远程 HTTP 形状时才接受已有条目；其他
   *  `skillsmp` 配置保持不变并上报为冲突。 */
  async registerSkillsMp(): Promise<void> {
    const existing = this.registry.getConfig('skillsmp')
    if (existing) {
      if (!isHttpConfig(existing) || existing.url !== SKILLSMP_MCP_URL || existing.enabled === false) {
        throw new Error(
          '已存在名为 skillsmp 的 MCP 配置，但与技能市场所需的远程 HTTP 配置不一致，请先在 MCP 设置中检查',
        )
      }
      return
    }
    if (await serverExists('skillsmp', 'user', this.workspace)) {
      throw new Error('已存在名为 skillsmp 的 MCP 配置，请先在 MCP 设置中检查')
    }
    await writeServerToConfig('skillsmp', { type: 'http', url: SKILLSMP_MCP_URL }, 'user', this.workspace)
    await this.reload()
  }

  /** `reload()` 由 renderer IPC 驱动（重复点击、切工作区与保存并发），
   *  `shutdown()` 也可能与它交错。两次 reload 交错时会：B 的
   *  `registry.shutdown()` 关掉 A 刚 `load()` 出的新 registry 连接、`this.registry`
   *  被旧的一次 `load()` 覆盖、`this.connecting` 指向已被丢弃的 registry；
   *  shutdown 与 reload 交错则会出现关掉之后又被拉起连接。串行化掉，
   *  并且两者共用同一条链。 */
  async reload(): Promise<void> {
    const run = this.lifecycleChain.then(
      () => this.doReload(),
      () => this.doReload(),
    )
    this.lifecycleChain = run.catch(() => undefined)
    return run
  }

  private async doReload(): Promise<void> {
    // 连接中的 server 可能永远不返回；重载不能被它无限期拖住，否则整条
    // 串行化链（含后续 shutdown）都会卡住。
    await this.bounded(this.connecting)
    await this.registry.shutdown()
    this.connecting = null
    await this.load()
  }

  async trustWorkspaceProject(): Promise<void> {
    await trustProject(this.workspace)
    await this.reload()
  }

  async authenticate(name: string): Promise<void> {
    await this.registry.authenticateServer(name, {
      onBrowserOpen: (url) => {
        this.authUrls.set(name, url)
        this.onAuthUrl?.(name, url)
      },
    })
    this.onChange()
  }

  async shutdown(timeoutMs = 1_500): Promise<void> {
    // 与 reload 排在同一条链上：排在 shutdown 之后的 reload 不能把连接
    // 又拉起来，排在它前面的 reload 也不能关掉 shutdown 之后的 registry。
    const run = this.lifecycleChain.then(
      () => this.doShutdown(timeoutMs),
      () => this.doShutdown(timeoutMs),
    )
    this.lifecycleChain = run.catch(() => undefined)
    return run
  }

  private async doShutdown(timeoutMs: number): Promise<void> {
    // 连接中的 MCP server 可能永远不返回；切工作区不能被它拖住。
    await this.bounded(this.connecting, timeoutMs)
    await this.bounded(this.registry.shutdown(), timeoutMs)
  }

  /** 给可能永不 settle 的 promise 加上界。 */
  private bounded(task: Promise<unknown> | null | undefined, timeoutMs = 1_500): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      void (task ?? Promise.resolve()).catch(() => undefined).then(finish)
    })
  }

  getRegistry(): McpRegistry {
    return this.registry
  }

  getPermissionStore(): McpPermissionStore {
    return this.permissionStore
  }

  getProjectSkipped(): boolean {
    return this.projectSkipped
  }
}
