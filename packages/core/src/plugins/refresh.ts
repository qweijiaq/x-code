// @x-code-cli/core — 插件热重载编排器
//
// `/plugin refresh` 从这里进入。任务是重新扫描磁盘上已安装的插件，并把新
// 状态传播到每个下游 registry，而无需重启 xc。
//
// 为什么这是独立模块而不是 PluginRegistry 上的方法：重载插件 registry
// 本身只需一行——工作量在于把新贡献折叠进 agent loop 其余部分在启动时捕获
// 的五个子 registry（skill / sub-agent / command / hook / mcp）。每个被
// 捕获的引用都必须保持稳定，因此每个 registry 都暴露一个原地重载方法，
// 而不是返回新实例。
//
// 当调用方接入了 mcpRegistry + askUser 回调时，MCP 服务器会在这里重启
// （项目服务器信任闸门检查需要它）。插件贡献的 MCP 服务器与 user + project
// 服务器合并，整套走 `McpRegistry.restartAll(...)`——与 `/mcp refresh` 同
// 一条路径。未接入 mcpRegistry 的调用方则得到既有行为（只重载
// skill/agent/command/hook）。
import { reloadSubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentRegistry, SubAgentReloadSummary } from '../agent/sub-agents/registry.js'
import { reloadCommandRegistry } from '../commands/registry.js'
import type { CommandRegistry, CommandReloadSummary } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { HookRegistry } from '../hooks/registry.js'
import { type LoadOptions, loadMergedConfigsFromDisk } from '../mcp/loader.js'
import type { McpRegistry, RestartSummary } from '../mcp/registry.js'
import { reloadSkillRegistry } from '../skills/registry.js'
import type { SkillRegistry, SkillReloadSummary } from '../skills/registry.js'
import { buildPluginIntegration } from './integration.js'
import { loadAllPlugins } from './loader.js'
import type { PluginRegistry, PluginReloadSummary } from './registry.js'

export interface PluginRefreshSummary {
  /** 插件级差异——哪些插件出现 / 消失 / 变化。这是 /plugin refresh 消息
   *  渲染的标题内容。 */
  plugins: PluginReloadSummary
  /** 各子 registry 的差异——用于 /plugin doctor 风格的细节。每个都是可选的，
   *  因为调用方可能没有接入每个 registry（例如测试会跳过）。 */
  skills?: SkillReloadSummary
  subAgents?: SubAgentReloadSummary
  commands?: CommandReloadSummary
  /** 刷新后注册的 hook 条目数——用于给用户反馈。我们不计算每个事件的差异，
   *  因为 hooks 没有稳定身份（无 name 字段）；单个数就足以确认“hooks 已
   *  重载”。 */
  hookCount: number
  /** 接入 mcpRegistry 时的 MCP 重启摘要。当调用方未传时为 `undefined`
   *  （测试 / `--no-plugins` 重载路径）。 */
  mcp?: RestartSummary
  /** 合并配置加载期间若有项目 MCP 服务器被跳过，其信任闸门决策。呈现出来
   *  让 UI 能警告用户。 */
  mcpProjectSkipped?: boolean
  /** 合并配置加载期间每个服务器的 MCP 配置解析错误。这些不中止刷新；它们
   *  随摘要一起展示，让用户知道哪个服务器条目被忽略。 */
  mcpConfigErrors?: Array<{ name: string; message: string }>
}

export interface PluginRefreshTargets {
  pluginRegistry: PluginRegistry
  /** 应折叠进新插件贡献的子 registry。调用方接入了哪些就传哪些。 */
  skillRegistry?: SkillRegistry
  subAgentRegistry?: SubAgentRegistry
  commandRegistry?: CommandRegistry
  hookBus?: HookBus
  /** 用新合并配置（user + plugin + project）重启的 MCP registry。设置时，
   *  还必须提供 `askUser` 用于项目信任闸门；缺省时 MCP 保持不动（与既有
   *  行为一致）。 */
  mcpRegistry?: McpRegistry
  /** 设置 `mcpRegistry` 时必填——用于 loadMergedConfigsFromDisk 内部的信任
   *  对话框，针对新的项目级 MCP 服务器。 */
  askUser?: LoadOptions['askUser']
  /** cwd 默认为 process.cwd()；测试可覆盖。 */
  cwd?: string
}

/** 重新扫描已安装插件，并把新状态折叠进每个接入的 registry。调用方负责在
 *  之后使 systemPromptCache 失效（这里需要缓存引用，而它位于 agent options
 *  的上一层）。 */
export async function refreshPluginContributions(targets: PluginRefreshTargets): Promise<PluginRefreshSummary> {
  const cwd = targets.cwd ?? process.cwd()

  // 1. 从磁盘重新扫描插件。loadAllPlugins 会构建自己的内部 registry——
  //    我们从中取出插件列表 + 加载错误，经 reload() 喂给调用方长期存活的
  //    registry。
  const load = await loadAllPlugins({ cwd })

  // 2. 换入调用方的插件 registry，捕获标题差异。
  const pluginsSummary = targets.pluginRegistry.reload(load.registry.listAll(), [...load.registry.loadErrors()])

  // 3. 从新插件集重新计算下游集成（skills 目录、agents 目录、commands
  //    目录、mcp 服务器、hook registry）。
  const integration = await buildPluginIntegration(load)

  // 4. 折叠进调用方接入的每个子 registry。
  const out: PluginRefreshSummary = { plugins: pluginsSummary, hookCount: 0 }

  if (targets.skillRegistry) {
    out.skills = await reloadSkillRegistry(targets.skillRegistry, { extraDirs: integration.skillsDirs })
  }
  if (targets.subAgentRegistry) {
    out.subAgents = await reloadSubAgentRegistry(targets.subAgentRegistry, { extraDirs: integration.agentsDirs })
  }
  if (targets.commandRegistry) {
    out.commands = await reloadCommandRegistry(targets.commandRegistry, { extraDirs: integration.commandsDirs })
  }
  if (targets.hookBus) {
    targets.hookBus.replaceRegistry(integration.hookRegistry)
    // 通过对新 registry 各事件的条目数求和来计数。用于用户消息——精确差异
    // 不值得那份复杂度。
    out.hookCount = countHooks(integration.hookRegistry)
  }

  // 5. MCP 重启——仅当 mcpRegistry 与 askUser 都已接入时。从磁盘重新读取
  //    user + project 配置文件，并入新的插件贡献 extraServers，然后拆掉并
  //    重连整套 MCP。与 /mcp refresh 同一代码路径。放在 /plugin refresh
  //    里做，意味着安装带 MCP 服务器的插件一条命令即可生效，而非两条。
  if (targets.mcpRegistry && targets.askUser) {
    const merged = await loadMergedConfigsFromDisk({
      cwd,
      askUser: targets.askUser,
      extraServers: integration.mcpServers,
    })
    out.mcpProjectSkipped = merged.projectSkipped
    out.mcpConfigErrors = merged.configErrors
    out.mcp = await targets.mcpRegistry.restartAll(merged.configs)
  }

  return out
}

function countHooks(registry: HookRegistry): number {
  // HookRegistry 暴露 get(eventName) → 数组；遍历已知事件名。这些名字是从
  // types.ts 复制的，但在这里导入它们会造成循环依赖，所以我们硬编码这份
  // 小列表。
  const eventNames = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const
  let n = 0
  for (const e of eventNames) n += registry.get(e).length
  return n
}
