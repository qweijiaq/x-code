import {
  McpPermissionStore,
  createOAuthProviderFactory,
  detectScope,
  emptyRegistry,
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

function chooseSafeOption(options: Array<{ label: string; description: string }>): string {
  const safe = options.find((option) => /skip|no|not now|不|稍后|忽略/i.test(option.label))
  return safe?.label ?? options[1]?.label ?? options[0]?.label ?? ''
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
    } catch {
      oauthProviderFor = undefined
    }

    const result = await loadMcpConfigsFromDisk({
      cwd: this.workspace,
      extraServers: this.extraServers,
      askUser: async (_question, options) => chooseSafeOption(options),
      oauthProviderFor,
    })
    this.registry = result.registry
    this.projectSkipped = result.projectSkipped
    await this.permissionStore.preload()

    if (this.registry.serverStatus().length > 0) {
      this.connecting = this.registry.connectAll(() => this.onChange())
    }
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
        config: config ? ({ ...config } as Record<string, unknown>) : {},
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
    if (await serverExists(trimmed, 'user', this.workspace)) {
      await removeServerFromConfig(trimmed, 'user', this.workspace)
    }
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

  async reload(): Promise<void> {
    await this.connecting?.catch(() => undefined)
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
    const bounded = (task: Promise<unknown> | null | undefined): Promise<void> =>
      new Promise((resolve) => {
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
    // 连接中的 MCP server 可能永远不返回；切工作区不能被它拖住。
    await bounded(this.connecting)
    await bounded(this.registry.shutdown())
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
