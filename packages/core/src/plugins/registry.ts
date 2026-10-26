// @x-code-cli/core — 插件 registry
//
// 在 CLI 启动时由 [[loader]].loadAllPlugins() 构建一次，然后在本会话内冻结。
// registry 持有每个成功加载的插件——启用与禁用都含——让 `/plugin list` 能
// 同时展示两者，还持有每条加载错误，让 `/plugin doctor` 能呈现它们。
//
// 热重载模型与 SkillRegistry 一致：`/plugin refresh` 原地重建内部状态（保留
// registry 对象身份，让每个被捕获的 `options.pluginRegistry` 引用保持有效），
// CLI 随后使 `systemPromptCache` 失效——CLAUDE.md 描述的字节稳定约束仍然
// 适用，因为插件会把 skills / agents / commands 贡献进系统提示词。
import { type ReloadSummary, diffNamedEntries } from '../registry-diff.js'
import type { LoadedPlugin, PluginLoadError } from './types.js'

/** 两个 registry 快照之间变化摘要——供 `/plugin refresh` 渲染
 *  “added / removed / changed”消息，与 `/mcp refresh` 和 `/skill refresh`
 *  的做法一致。 */
export type PluginReloadSummary = ReloadSummary

export class PluginRegistry {
  private byId: Map<string, LoadedPlugin>
  private errors: PluginLoadError[]

  constructor(plugins: LoadedPlugin[], errors: PluginLoadError[] = []) {
    this.byId = new Map()
    for (const p of plugins) this.byId.set(p.id, p)
    this.errors = [...errors]
  }

  /** 按 id 取已启用插件。禁用的插件在该查找中隐藏——需要检查禁用标志时
   *  （如 `/plugin list`）请用 [[getEntry]]。 */
  get(id: string): LoadedPlugin | undefined {
    const p = this.byId.get(id)
    if (!p || !p.enabled) return undefined
    return p
  }

  /** 按 id 取插件，含禁用的。 */
  getEntry(id: string): LoadedPlugin | undefined {
    return this.byId.get(id)
  }

  /** 仅已启用插件——agent loop 所见的。 */
  list(): LoadedPlugin[] {
    return [...this.byId.values()].filter((p) => p.enabled)
  }

  /** 每个已加载插件，含禁用的。 */
  listAll(): LoadedPlugin[] {
    return [...this.byId.values()]
  }

  /** 仅插件 id（已启用）。 */
  ids(): string[] {
    return this.list().map((p) => p.id)
  }

  /** 加载期间收集的非致命错误。由 `/plugin doctor` 呈现。 */
  loadErrors(): readonly PluginLoadError[] {
    return this.errors
  }

  /** 用全新加载替换内存中的插件列表。供 `/plugin refresh` 使用——保持同一
   *  PluginRegistry 对象身份，让每个缓存引用保持有效。返回差异摘要，调用方
   *  据此渲染 “added / removed / changed / unchanged” 消息。 */
  reload(plugins: LoadedPlugin[], errors: PluginLoadError[] = []): PluginReloadSummary {
    const previous = this.byId
    const next = new Map<string, LoadedPlugin>()
    for (const p of plugins) next.set(p.id, p)

    const summary = diffNamedEntries(
      previous,
      next,
      (prev, plugin) =>
        prev.manifest.version !== plugin.manifest.version ||
        prev.rootDir !== plugin.rootDir ||
        prev.enabled !== plugin.enabled ||
        prev.scope !== plugin.scope,
    )

    this.byId = next
    this.errors = [...errors]
    return summary
  }
}

/** 空 registry——用于插件加载被禁用（如 `--no-plugins` 启动标志）或未安装
 *  插件时。比在下游到处判空更省事。 */
export function emptyPluginRegistry(): PluginRegistry {
  return new PluginRegistry([], [])
}
