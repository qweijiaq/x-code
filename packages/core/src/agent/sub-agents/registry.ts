// @x-code-cli/core — 子代理注册表
//
// 启动时构造一次；当 /plugin refresh 触发时，可通过 reloadSubAgentRegistry 热重载。
// 内置代理同步加载；磁盘上的自定义代理异步加载。同名自定义代理覆盖内置代理
// （project > user > built-in）。
import { loadUserConfig } from '../../config/index.js'
import { type ReloadSummary, diffNamedEntries } from '../../registry-diff.js'
import { browserAgent, builtInAgents } from './built-in.js'
import { type LoadCustomAgentsOptions, loadCustomAgents } from './loader.js'
import type { SubAgentDefinition } from './types.js'

/** reload 返回的 diff 摘要——驱动 /plugin refresh 的消息展示。 */
export type SubAgentReloadSummary = ReloadSummary

function acceptsAgentDefinition(agent: SubAgentDefinition): boolean {
  const allowsShell = agent.tools === undefined || agent.tools.some((tool) => tool === 'shell' || tool === '*')
  const denied = new Set(agent.disallowedTools ?? [])
  if (!allowsShell || denied.has('shell')) return true
  const conflict = ['shellOutput', 'killShell'].find((tool) => denied.has(tool))
  if (!conflict) return true
  console.error(
    `[sub-agents] Skipping ${agent.name}: allowing shell while denying ${conflict} would create an unmanageable shell capability`,
  )
  return false
}

export class SubAgentRegistry {
  private agents: Map<string, SubAgentDefinition>

  constructor(agents: SubAgentDefinition[]) {
    this.agents = new Map()
    for (const a of agents) {
      if (!acceptsAgentDefinition(a)) continue
      this.agents.set(a.name, a)
    }
  }

  get(name: string): SubAgentDefinition | undefined {
    return this.agents.get(name)
  }

  list(): SubAgentDefinition[] {
    return [...this.agents.values()]
  }

  names(): string[] {
    return [...this.agents.keys()]
  }

  /** 就地添加或移除浏览器代理——由 `/browser on|off` 驱动。
   *  外科手术式：保持 registry 的对象同一性（使每个被捕获的 options.subAgentRegistry
   *  引用依然有效），并跳过完整的 custom/plugin 重新扫描。一个真的叫 "browser" 的自定义
   *  代理会在开启期间被遮蔽——这是对“现实中没人会重用的名字”可以接受的边界情况。 */
  setBrowserEnabled(enabled: boolean): void {
    if (enabled) this.agents.set(browserAgent.name, browserAgent)
    else this.agents.delete(browserAgent.name)
  }

  /** 用一次全新的加载替换内存中的代理列表。供 /plugin refresh 使用——
   *  保持 SubAgentRegistry 对象同一性，使每个被捕获的 `options.subAgentRegistry`
   *  引用依然有效。 */
  reload(agents: SubAgentDefinition[]): SubAgentReloadSummary {
    const previous = this.agents
    const next = new Map<string, SubAgentDefinition>()
    for (const a of agents) {
      if (acceptsAgentDefinition(a)) next.set(a.name, a)
    }
    const summary = diffNamedEntries(
      previous,
      next,
      (prev, agent) => prev.prompt !== agent.prompt || prev.source !== agent.source || prev.pluginId !== agent.pluginId,
    )
    this.agents = next
    return summary
  }
}

/** 内置代理加上可选的浏览器代理，按 config 门控。浏览器代理是 opt-in 的
 *  （`config.browser.enabled`），因此默认代理列表——以及固化进字节稳定系统提示词的
 *  task 工具描述——对所有未启用者保持不变。显式的 `includeBrowser` 会覆盖 config 读取
 *  （供测试使用）。 */
function baseAgents(includeBrowser: boolean | undefined): SubAgentDefinition[] {
  const enabled = includeBrowser ?? loadUserConfig().browser?.enabled === true
  return enabled ? [...builtInAgents, browserAgent] : builtInAgents
}

/** 构建注册表：先内置，后自定义（靠后的条目覆盖前者）。 */
export async function createSubAgentRegistry(
  opts: LoadCustomAgentsOptions & { includeBrowser?: boolean } = {},
): Promise<SubAgentRegistry> {
  const { includeBrowser, ...loadOpts } = opts
  const custom = await loadCustomAgents(loadOpts)
  // 加载顺序：built-in → custom。Map 插入覆盖，所以 custom 胜出。
  return new SubAgentRegistry([...baseAgents(includeBrowser), ...custom])
}

/** 就地重新扫描 + 重建内存代理列表。磁盘扫描与启动时相同；opts（尤其是来自插件的
 *  extraDirs）由调用方带入。返回 diff 摘要，用于 /plugin refresh 消息。 */
export async function reloadSubAgentRegistry(
  registry: SubAgentRegistry,
  opts: LoadCustomAgentsOptions & { includeBrowser?: boolean } = {},
): Promise<SubAgentReloadSummary> {
  const { includeBrowser, ...loadOpts } = opts
  const custom = await loadCustomAgents(loadOpts)
  return registry.reload([...baseAgents(includeBrowser), ...custom])
}

/** 仅含内置代理的同步注册表（供测试或需要跳过磁盘扫描时使用）。 */
export function createBuiltInRegistry(): SubAgentRegistry {
  return new SubAgentRegistry(builtInAgents)
}
