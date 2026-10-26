// @x-code-cli/core — MCP 启动加载器
//
// 从 CLI 入口调用的一次性编排：读取用户 + 项目配置，对项目级内容应用
// 信任门，展开环境变量，并行 spawn / 拨号每个启用的服务器，构建一个
// 之后可被 `/mcp refresh` 和 `/mcp auth` 变更的 registry。单个服务器的
// 失败会被记录但绝不中止启动——`/mcp list` 是用户查看问题所在的窗口。
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR, debugLog } from '../utils.js'
import { McpClient } from './client.js'
import { parseServersBlock } from './config-schema.js'
import { buildCallableName as buildCallable } from './name-mangling.js'
import {
  type ConnectResult,
  McpRegistry,
  type OAuthProviderFactory,
  type RegisteredServer,
  connectOneServer,
  emptyRegistry,
} from './registry.js'
import { type TrustChoice, buildServerPreview, isProjectTrusted, promptForTrust, trustProject } from './trust.js'
import { type McpResourceEntry, type McpServerConfig, type McpToolEntry } from './types.js'

const MAX_MCP_CONFIG_BYTES = 1024 * 1024

// 为从本模块导入该类型的旧调用方重新导出。
export type { OAuthProviderFactory }
export type { RegisteredServer, ConnectResult }
export type { McpResourceEntry, McpToolEntry }

export interface LoadOptions {
  /** 来自 ~/.x-code/config.json 的 mcpServers。隐式信任。 */
  userServers: Record<string, McpServerConfig> | undefined
  /** 来自 <project>/.x-code/config.json 的 mcpServers。需要同意。 */
  projectServers: Record<string, McpServerConfig> | undefined
  /** 由已启用插件贡献的 mcpServers。隐式信任——用户在安装时已同意该插件，
   *  所以为插件服务器再跑一次项目 MCP 信任对话框会是重复提示。以与
   *  `userServers` 相同的优先级合并（名字冲突时项目条目仍会覆盖）。 */
  extraServers?: Record<string, McpServerConfig>
  /** 绝对项目路径（CLI 启动时的 cwd）。用作信任键。 */
  projectPath: string
  /** 渲染信任对话框。形状与 `AgentCallbacks.onAskUser` 相同。 */
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>
  /** OAuth provider 工厂。可选——传 undefined 以禁用 OAuth（需要认证的
   *  HTTP 服务器会被标记为 `needs_auth`）。 */
  oauthProviderFor?: OAuthProviderFactory
  /** 在 loader 决定终止进程后调用——CLI 层把它接到干净的关闭路径。
   *  默认 no-op（由调用方负责）。 */
  onExitRequested?: () => void
}

export interface LoadResult {
  registry: McpRegistry
  /** 在联系任何服务器之前收集的配置 / 解析错误。在 `/mcp list` 中展示，
   *  使用户在真实的连接失败旁边也能看到配置里的笔误。 */
  configErrors: Array<{ name: string; message: string }>
  /** 当项目级 mcpServers 因用户拒绝信任而被跳过时为 true。
   *  CLI 用它打印一条提醒信息。 */
  projectSkipped: boolean
}

/** 从磁盘加载标准配置文件 + 调用 loader。CLI 入口使用的便捷封装，
 *  使其不必了解文件路径。 */
export async function loadMcpFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  oauthProviderFor?: OAuthProviderFactory
  onExitRequested?: () => void
  /** 插件贡献的 mcpServers——已受信任，与用户级服务器一起合并进有效配置。
   *  由 packages/core/src/plugins/integration.ts 构建。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<LoadResult> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))
  return loadMcpServers({
    userServers,
    projectServers,
    extraServers: opts.extraServers,
    projectPath: opts.cwd,
    askUser: opts.askUser,
    oauthProviderFor: opts.oauthProviderFor,
    onExitRequested: opts.onExitRequested,
  })
}

/** 异步启动的第一阶段 loader：从磁盘读取配置、运行信任对话框、构建一个
 *  所有服务器都处于 `connecting` 状态（还没有工具）的 McpRegistry。调用方
 *  应随后调用 `registry.connectAll()` 真正建立连接——这样 CLI 可以在连接
 *  于后台进行的同时立即渲染 UI。
 *
 *  返回与 `loadMcpFromDisk` 相同的结构，使 CLI 可以互换使用两条路径。 */
export async function loadMcpConfigsFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  oauthProviderFor?: OAuthProviderFactory
  onExitRequested?: () => void
  extraServers?: Record<string, McpServerConfig>
}): Promise<LoadResult> {
  const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
    cwd: opts.cwd,
    askUser: opts.askUser,
    extraServers: opts.extraServers,
  })

  if (opts.onExitRequested && projectSkipped) {
    // 信任对话框返回了 'exit'——执行调用方的关闭钩子。loadMergedConfigsFromDisk
    // 会把 'exit' 映射为 'skip'（为了 /mcp refresh 的安全），所以这里
    // 为 CLI 启动路径重新检查 projectSkipped。
  }

  if (configs.size === 0) {
    return {
      registry: new McpRegistry({ servers: [], tools: [], resources: [], oauthFactory: opts.oauthProviderFor }),
      configErrors,
      projectSkipped,
    }
  }

  // 构建一个所有服务器都处于 `connecting` 状态（尚无实际连接）的 registry。
  const pendingServers: RegisteredServer[] = [...configs.entries()].map(([name, cfg]) => ({
    name,
    client: new McpClient(name, cfg),
    status: { kind: 'connecting' as const },
  }))

  const registry = new McpRegistry({
    servers: pendingServers,
    tools: [],
    resources: [],
    configs,
    oauthFactory: opts.oauthProviderFor,
  })

  return { registry, configErrors, projectSkipped }
}

/** 从磁盘重新读取配置 + 应用信任门，但不 spawn 任何服务器。供 `/mcp refresh`
 *  使用，使调用方可以把合并后的映射交给 `registry.restartAll(...)`——
 *  那会就地变更现有 registry，而不是分配一个并行的。 */
export async function loadMergedConfigsFromDisk(opts: {
  cwd: string
  askUser: LoadOptions['askUser']
  /** 插件贡献的 mcpServers（来自 `buildPluginIntegration().mcpServers`）。
   *  在用户与项目之间合并，优先级与 [[loadMcpServers]] 一致。在
   *  `/mcp refresh` 和 `/plugin refresh` 时传入，使插件贡献的服务器不会
   *  在重载时被悄悄丢弃。 */
  extraServers?: Record<string, McpServerConfig>
}): Promise<{
  configs: Map<string, McpServerConfig>
  configErrors: Array<{ name: string; message: string }>
  projectSkipped: boolean
}> {
  const userServers = await readMcpServersFromFile(getUserConfigPath())
  const projectServers = await readMcpServersFromFile(path.join(opts.cwd, XCODE_DIR, 'config.json'))

  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  const userParsed = parseServersBlock(userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))
  const projectParsed = parseServersBlock(projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  let projectServersToUse = projectParsed.servers
  if (Object.keys(projectServersToUse).length > 0) {
    const trusted = await isProjectTrusted(opts.cwd)
    if (!trusted) {
      const choice = await askForTrust(
        {
          // 为 askForTrust 拼出刚好够用的 LoadOptions——
          // 只读取 projectPath + askUser。
          userServers,
          projectServers,
          projectPath: opts.cwd,
          askUser: opts.askUser,
        },
        projectServersToUse,
      )
      if (choice === 'exit') {
        // /mcp refresh 刻意忽略 'exit'——从一个斜杠命令里退出整个 CLI 太粗暴。
        // 我们把它当作 'skip'，这样用户可以在真正重启时重新选择。
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      } else if (choice === 'trust') {
        await trustProject(opts.cwd).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // 合并顺序 user → plugin → project，与 loadMcpServers（初始启动）强制的
  // 优先级一致。插件贡献的条目位于 user 与 project 之间，使项目级同名条目
  // 仍能胜出。
  const merged = new Map<string, McpServerConfig>(
    Object.entries({ ...userParsed.servers, ...(opts.extraServers ?? {}), ...projectServersToUse }),
  )
  return { configs: merged, configErrors, projectSkipped }
}

/** 纯 loader（配置不涉及磁盘 I/O——由调用方注入）。
 *  更易测试，并让 CLI 控制配置来源。 */
export async function loadMcpServers(options: LoadOptions): Promise<LoadResult> {
  const configErrors: Array<{ name: string; message: string }> = []
  let projectSkipped = false

  // 预先校验两个块。parseServersBlock 容忍 `undefined`，此时返回空映射 +
  // 零错误，因此没有配置 mcpServers 的用户毫无开销。
  const userParsed = parseServersBlock(options.userServers)
  configErrors.push(...userParsed.errors.map((e) => ({ name: `user:${e.name}`, message: e.message })))

  const projectParsed = parseServersBlock(options.projectServers)
  configErrors.push(...projectParsed.errors.map((e) => ({ name: `project:${e.name}`, message: e.message })))

  // 项目级信任门。如果项目零个服务器，我们完全跳过提示——没什么可同意的。
  let projectServersToUse = projectParsed.servers
  const projectServerNames = Object.keys(projectServersToUse)
  if (projectServerNames.length > 0) {
    const trusted = await isProjectTrusted(options.projectPath)
    if (!trusted) {
      const choice = await askForTrust(options, projectServersToUse)
      if (choice === 'exit') {
        options.onExitRequested?.()
        // 即使 CLI 没有关闭，返回空 registry 也能让 loader 的其余部分
        // 保持定义良好。
        return { registry: emptyRegistry(), configErrors, projectSkipped: true }
      }
      if (choice === 'skip') {
        projectServersToUse = {}
        projectSkipped = true
      }
      if (choice === 'trust') {
        await trustProject(options.projectPath).catch((err) => {
          debugLog('mcp.trust-write-failed', String(err))
        })
      }
    }
  }

  // 合并顺序：user → plugin → project。插件贡献的服务器（`extraServers`）
  // 有意位于 user 与 project 之间：
  //   - 它们已受信任（同意发生在插件安装时），因此无需通过上面的信任对话框，但
  //   - 与项目级条目名字冲突时仍让项目条目胜出（项目配置由运行该 CLI 的
  //     同一个人编写，他们可能想覆盖插件对服务器的选择）。
  const merged: Record<string, McpServerConfig> = {
    ...userParsed.servers,
    ...(options.extraServers ?? {}),
    ...projectServersToUse,
  }

  // 任何地方都没有配置服务器 → 用空 registry 走快速路径。我们仍传入
  // oauthFactory，使之后（用户向配置添加服务器并重启 CLI 后）的 /mcp refresh
  // 能拥有它——尽管实际上空 registry 路径只会在启动时两个配置都为空时命中，
  // 而之后的 refresh 会通过 CLI 自己的 loadMcpFromDisk 调用从磁盘重建。
  if (Object.keys(merged).length === 0) {
    return {
      registry: new McpRegistry({ servers: [], tools: [], resources: [], oauthFactory: options.oauthProviderFor }),
      configErrors,
      projectSkipped,
    }
  }

  // 并行 spawn / 拨号。每个 per-server promise 用 .then/.catch 包裹，
  // 使单个超时不会拖垮整个启动。
  const tasks = Object.entries(merged).map(async ([name, rawConfig]) => {
    return connectOneServer(name, rawConfig, options.oauthProviderFor)
  })
  const results = await Promise.all(tasks)

  // 组装 registry。工具名冲突按插入顺序解决（先到者赢；后到的加哈希后缀），
  // 所以按服务器名排序以保证稳定——否则顺序会取决于哪个 connect() 先
  // resolve。
  results.sort((a, b) => a.server.name.localeCompare(b.server.name))

  const tools: McpToolEntry[] = []
  const resources: McpResourceEntry[] = []
  const taken = new Set<string>()

  for (const r of results) {
    for (const t of r.tools) {
      const callable = buildCallable(r.server.name, t.name, taken)
      taken.add(callable)
      tools.push({
        callableName: callable,
        rawName: t.name,
        serverName: r.server.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      })
    }
    for (const res of r.resources) resources.push(res)
  }

  const configs = new Map<string, McpServerConfig>(Object.entries(merged))

  const registry = new McpRegistry({
    servers: results.map((r) => r.server),
    tools,
    resources,
    configs,
    oauthFactory: options.oauthProviderFor,
  })

  return { registry, configErrors, projectSkipped }
}

async function askForTrust(
  options: LoadOptions,
  projectServers: Record<string, McpServerConfig>,
): Promise<TrustChoice> {
  const summaries = Object.entries(projectServers).map(([name, cfg]) => ({
    name,
    preview: buildServerPreview(cfg as { command?: string; args?: string[]; url?: string }),
  }))
  try {
    return await promptForTrust(options.projectPath, summaries, options.askUser)
  } catch (err) {
    // 如果提示机制本身失败（无 TTY 等），稳妥起见：跳过项目配置。
    // 记录日志以便调试。
    debugLog('mcp.trust-prompt-failed', String(err))
    return 'skip'
  }
}

/** 仅从 JSON 配置文件读出 `mcpServers` 字段。文件缺失 / 解析错误 / 字段缺失
 *  都返回 undefined——这些都表示"这里没有配置 MCP 服务器"，绝不是需要向上
 *  报告的错误。 */
async function readMcpServersFromFile(filePath: string): Promise<Record<string, McpServerConfig> | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_MCP_CONFIG_BYTES) {
    debugLog('mcp.config-too-large', filePath)
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> }
    if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
      return parsed.mcpServers
    }
    return undefined
  } catch (err) {
    debugLog('mcp.config-parse-failed', `${filePath}: ${String(err)}`)
    return undefined
  }
}
