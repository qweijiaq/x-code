// @x-code-cli/core — 插件贡献接入既有 loader
//
// 把 [[loader]].loadAllPlugins 的输出转换成既有 skill / sub-agent / MCP
// loader 所消费的形状，因此 CLI 启动的调用序列大致如下：
//
//   const pluginLoad = await loadAllPlugins({ cwd })
//   const integration = await buildPluginIntegration(pluginLoad)
//   const skillRegistry  = await createSkillRegistry({  extraDirs: integration.skillsDirs })
//   const agentRegistry  = await createSubAgentRegistry({ extraDirs: integration.agentsDirs })
//   const mcpRegistry    = await loadMcpFromDisk({ ..., extraServers: integration.mcpServers })
//
// 本模块独有、其它模块不负责的三件事：
//
//   1. 把插件的 `mcpServers`（路径或内联对象）解析成带类型的
//      `Record<string, McpServerConfig>`。路径形式是一个形如
//      `{ mcpServers: {...} }` 的 JSON 文件（与 ~/.x-code/config.json 相同）。
//      内联形式就是原始记录本身。
//
//   2. 检测插件之间的名称冲突。我们按服务器名去重——迭代顺序中先出现的
//      插件胜出，后者的条目被丢弃并给出警告。未来改进：用插件 id 给
//      服务器名加命名空间。
//
//   3. 记录我们（目前）还不支持的插件贡献：`commands`（我们缺少基于文件
//      的 slash 命令 loader）和 `hooks`（Task 9 会加入 hook 子系统；在此
//      之前，声明的 hooks 只记录不执行）。
//
// 插件顺序是确定性的——由 `loadAllPlugins` 的 `contributions` Map 的迭代
// 顺序驱动，而它本身反映 installed_plugins.json + 项目本地发现的顺序。
// 安装相同插件时，跨启动保持稳定。
import fs from 'node:fs/promises'

import { HookBus } from '../hooks/bus.js'
import { HookConfigParseError, parseHookConfig } from '../hooks/config-schema.js'
import { HookRegistry, buildHookRegistry } from '../hooks/registry.js'
import type { HookConfig } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { isStdioConfig } from '../mcp/types.js'
import type { McpServerConfig } from '../mcp/types.js'
import { debugLog, errorMessage } from '../utils.js'
import { loadAllPlugins } from './loader.js'
import type { LoadResult, ResolvedContributions } from './loader.js'
import { extractMcpServersBlock } from './mcp-contributions.js'
import type { InlineMcpServers, LoadedPlugin } from './types.js'
import { getPluginUserConfigEnv } from './user-config.js'

export interface PluginIntegrationOutput {
  /** 供 skill loader 扫描的额外 skill 目录，每个都打上所属插件 id。仅包含
   *  已启用的插件。 */
  skillsDirs: Array<{ dir: string; pluginId: string }>
  /** 同上，用于 sub-agent 的 .md 文件。 */
  agentsDirs: Array<{ dir: string; pluginId: string }>
  /** 同上，用于 slash 命令的 `*.md` 文件。每个条目携带所属插件的 rootDir，
   *  以便命令体在激活时替换 `${CLAUDE_PLUGIN_ROOT}`。 */
  commandsDirs: Array<{ dir: string; pluginId: string; pluginRoot: string }>
  /** 每个启用插件合并后的 `mcpServers` 块。名称冲突按先到先得解决；败者
   *  记录在 `mcpCollisions`。 */
  mcpServers: Record<string, McpServerConfig>
  /** 从每个启用插件的 `hooks` 配置构建的 hook registry。无插件声明 hooks
   *  时为空。把它交给 `new HookBus(...)` 以接入 agent loop 的触发点。 */
  hookRegistry: HookRegistry
  /** 基于 `hookRegistry` 的现成 bus。方便 CLI 启动接线——
   *  `AgentOptions.hookBus = integration.hookBus`。 */
  hookBus: HookBus
  /** 每个插件的 hook 事件名汇总——供 `/plugin doctor` 和 `/plugin info` UI
   *  使用。 */
  pluginHooks: Array<{ pluginId: string; events: string[] }>
  /** 因与更早插件名称冲突而被丢弃的 mcpServers 条目。
   *  `{ name, droppedFrom, keptFrom }`。 */
  mcpCollisions: Array<{ name: string; droppedFrom: string; keptFrom: string }>
  /** 每个插件的 mcpServers 解析 / 读取错误——这些不会阻断启动，而是浮现
   *  在 `/plugin doctor`。 */
  mcpErrors: Array<{ pluginId: string; message: string }>
  /** 每个插件的 hooks 解析 / 读取错误。 */
  hookErrors: Array<{ pluginId: string; message: string }>
}

export async function buildPluginIntegration(load: LoadResult): Promise<PluginIntegrationOutput> {
  // hook registry 最后构建，这样可以在遍历过程中收集各插件配置（我们无法
  // 提前知道所有插件的 rootDirs——它们来自 LoadedPlugin）。
  const hookInputs: Array<{ pluginId: string; pluginDir: string; config: HookConfig }> = []

  const out: PluginIntegrationOutput = {
    skillsDirs: [],
    agentsDirs: [],
    commandsDirs: [],
    mcpServers: {},
    hookRegistry: new HookRegistry(),
    hookBus: new HookBus(new HookRegistry()),
    pluginHooks: [],
    mcpCollisions: [],
    mcpErrors: [],
    hookErrors: [],
  }
  const mcpOwners = new Map<string, string>()

  for (const plugin of load.registry.list()) {
    const contrib = load.contributions.get(plugin.id)
    if (!contrib) continue

    if (contrib.skillsDir) out.skillsDirs.push({ dir: contrib.skillsDir, pluginId: plugin.id })
    if (contrib.agentsDir) out.agentsDirs.push({ dir: contrib.agentsDir, pluginId: plugin.id })
    if (contrib.commandsDir) {
      out.commandsDirs.push({ dir: contrib.commandsDir, pluginId: plugin.id, pluginRoot: plugin.rootDir })
    }

    if (contrib.hooks) {
      const config = await resolvePluginHooks(plugin, contrib.hooks, out)
      if (config) {
        hookInputs.push({ pluginId: plugin.id, pluginDir: plugin.rootDir, config })
        out.pluginHooks.push({ pluginId: plugin.id, events: Object.keys(config) })
      }
    }

    if (contrib.mcpServers) {
      const servers = await resolvePluginMcpServers(plugin, contrib.mcpServers, out)
      for (const [name, cfg] of Object.entries(servers)) {
        const prevOwner = mcpOwners.get(name)
        if (prevOwner !== undefined) {
          out.mcpCollisions.push({ name, droppedFrom: plugin.id, keptFrom: prevOwner })
          continue
        }
        out.mcpServers[name] = cfg
        mcpOwners.set(name, plugin.id)
      }
    }
  }

  out.hookRegistry = buildHookRegistry(hookInputs)
  out.hookBus = new HookBus(out.hookRegistry)
  return out
}

async function resolvePluginHooks(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['hooks']>,
  out: PluginIntegrationOutput,
): Promise<HookConfig | null> {
  let raw: unknown
  if (contrib.kind === 'inline') {
    raw = contrib.data
  } else {
    try {
      const text = await fs.readFile(contrib.path, 'utf-8')
      raw = JSON.parse(text)
    } catch (err) {
      out.hookErrors.push({
        pluginId: plugin.id,
        message: `failed to read hooks file ${contrib.path}: ${errorMessage(err)}`,
      })
      return null
    }
  }
  try {
    return parseHookConfig(raw, plugin.id)
  } catch (err) {
    out.hookErrors.push({
      pluginId: plugin.id,
      message: err instanceof HookConfigParseError ? err.message : String(err),
    })
    return null
  }
}

async function resolvePluginMcpServers(
  plugin: LoadedPlugin,
  contrib: NonNullable<ResolvedContributions['mcpServers']>,
  out: PluginIntegrationOutput,
): Promise<Record<string, McpServerConfig>> {
  let rawBlock: unknown
  if (contrib.kind === 'inline') {
    rawBlock = contrib.data as InlineMcpServers
  } else {
    try {
      const raw = await fs.readFile(contrib.path, 'utf-8')
      const parsed = JSON.parse(raw)
      rawBlock = extractMcpServersBlock(parsed)
    } catch (err) {
      out.mcpErrors.push({
        pluginId: plugin.id,
        message: `failed to read mcpServers file ${contrib.path}: ${errorMessage(err)}`,
      })
      return {}
    }
  }

  const { servers, errors } = parseServersBlock(rawBlock)
  for (const e of errors) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `mcpServers.${e.name}: ${e.message}` })
  }

  // 把所属插件的 userConfig 值合并进每个服务器的 env 映射。想要从 manifest
  // 声明的 userConfig 字段取得 API key 的作者，只需在 mcpServers 条目里
  // 把它当普通环境变量引用（或干脆不显式引用，依赖子进程继承的环境）。
  // 既有服务器的 env 条目优先，这样作者可以在需要时按服务器覆盖某个
  // userConfig 值。
  try {
    const pluginEnv = await getPluginUserConfigEnv(plugin.id)
    if (Object.keys(pluginEnv).length > 0) {
      for (const name of Object.keys(servers)) {
        const cfg = servers[name]!
        // 只有 stdio 服务器会拉起子进程并接受环境变量——HTTP 服务器是
        // 远程端点，合并环境变量没有意义。
        if (isStdioConfig(cfg)) {
          servers[name] = { ...cfg, env: { ...pluginEnv, ...(cfg.env ?? {}) } }
        }
      }
    }
  } catch (err) {
    out.mcpErrors.push({ pluginId: plugin.id, message: `userConfig env merge: ${String(err)}` })
  }

  return servers
}

/** 便利函数：把非致命集成诊断写入 debug.log，让 `/plugin doctor` 和临时
 *  排查能找到它们。CLI 启动在 `buildPluginIntegration` 返回后调用它。 */
export function debugLogIntegrationDiagnostics(integration: PluginIntegrationOutput): void {
  for (const c of integration.commandsDirs) {
    debugLog('plugins.commands-loaded', `${c.pluginId} commands dir: ${c.dir}`)
  }
  for (const h of integration.pluginHooks) {
    debugLog('plugins.hooks-registered', `${h.pluginId} hooks: [${h.events.join(', ')}]`)
  }
  for (const e of integration.hookErrors) {
    debugLog('plugins.hook-error', `${e.pluginId}: ${e.message}`)
  }
  for (const c of integration.mcpCollisions) {
    debugLog('plugins.mcp-collision', `mcpServer "${c.name}" from ${c.droppedFrom} dropped (kept ${c.keptFrom})`)
  }
  for (const e of integration.mcpErrors) {
    debugLog('plugins.mcp-error', `${e.pluginId}: ${e.message}`)
  }
}

/** 从磁盘重新扫描插件，只返回合并后的插件贡献 mcpServers 块。供
 *  `/mcp refresh` 把插件服务器并入合并映射（这样它们在独立 MCP 刷新时
 *  不会被静默丢弃），也经由 buildPluginIntegration 间接供 `/plugin refresh`
 *  使用。
 *
 *  返回 `{}`（而非 undefined），这样调用方可无条件展开。扫描失败降级为
 *  `{}` + debug 日志——调用方的 MCP 专属刷新不应因插件系统的小毛病而失败。 */
export async function getPluginMcpServersFromDisk(cwd: string): Promise<Record<string, McpServerConfig>> {
  try {
    const load = await loadAllPlugins({ cwd })
    const integration = await buildPluginIntegration(load)
    return integration.mcpServers
  } catch (err) {
    debugLog('plugins.mcp-scan-failed', `getPluginMcpServersFromDisk: ${String(err)}`)
    return {}
  }
}
