// @x-code-cli/core — 插件启用 / 禁用状态
//
// 从 settings.json 文件读取各作用域的 `enabledPlugins` 映射，并为每个
// 插件 id 解析出有效的启用状态。
//
// 双作用域模型，与 mcp + skill 子系统保持一致：
//
//   user      ~/.x-code/settings.json
//   project   <cwd>/.x-code/settings.local.json   （已 gitignore）
//
// `'project'` 读取 `.local.json` 文件是从 skills 继承来的一个小命名
// 别扭——它是针对单个仓库的 per-user 覆盖，不是团队共享文件。日后可以
// 在不改动现有两个作用域的前提下，另加一个团队共享（需提交）的作用域。
//
// 映射形状：`{ "name@marketplace": true | false }` —— true = 启用，
// false = 显式禁用，缺失 = 使用项目级默认值（当前为 `true`，即默认启用）。
//
// 优先级：project > user。更高优先级作用域里的显式值胜出；缺失的条目
// 继续下探。
import path from 'node:path'

import { mutateSettingsFile, readSettingsFile } from '../settings-io.js'
import { XCODE_DIR, userXcodeDir } from '../utils.js'
import type { PluginScope } from './types.js'

/** 优先级从高到低。第一个带有显式条目的作用域胜出。 */
const SCOPE_PRECEDENCE: ReadonlyArray<PluginScope> = ['project', 'user']

/** 没有作用域提到该插件时的默认启用状态。我们默认 ENABLED，让新安装的
 *  插件开箱即用；想要 opt-in 行为的用户可以显式关掉单个插件。 */
const DEFAULT_ENABLED = true

interface PluginSettingsFile {
  enabledPlugins?: Record<string, boolean>
}

function enabledPluginsFrom(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const enabledPlugins: Record<string, boolean> = {}
  for (const [pluginId, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') enabledPlugins[pluginId] = enabled
  }
  return enabledPlugins
}

export function settingsPathForScope(scope: PluginScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(cwd, XCODE_DIR, 'settings.local.json')
}

async function readSettings(scope: PluginScope, cwd: string): Promise<PluginSettingsFile> {
  const obj = await readSettingsFile(settingsPathForScope(scope, cwd))
  return { enabledPlugins: enabledPluginsFrom(obj.enabledPlugins) }
}

/** 每个插件解析后的启用状态，外加由哪个作用域决定的（供 `/plugin doctor`
 *  使用）。当 `decidedBy` 为 `undefined` 时，说明没有作用域提到该插件，
 *  此时采用默认值。 */
export interface ResolvedEnableState {
  enabled: boolean
  decidedBy: PluginScope | undefined
}

export class EnableState {
  private constructor(private readonly perScope: Map<PluginScope, Record<string, boolean>>) {}

  /** 加载两个 settings 文件并构建快照。此快照此后有意保持不变——调用方
   *  在写入 settings.json 后通过 `EnableState.load()` 重新加载。`cwd`
   *  默认为 `process.cwd()`，控制 `'project'` 作用域文件从何处读取。 */
  static async load(cwd: string = process.cwd()): Promise<EnableState> {
    const map = new Map<PluginScope, Record<string, boolean>>()
    for (const scope of SCOPE_PRECEDENCE) {
      const s = await readSettings(scope, cwd)
      map.set(scope, s.enabledPlugins ?? {})
    }
    return new EnableState(map)
  }

  /** 单个插件 id 的有效启用状态。 */
  resolve(pluginId: string): ResolvedEnableState {
    for (const scope of SCOPE_PRECEDENCE) {
      const table = this.perScope.get(scope) ?? {}
      if (pluginId in table) {
        return { enabled: table[pluginId]!, decidedBy: scope }
      }
    }
    return { enabled: DEFAULT_ENABLED, decidedBy: undefined }
  }

  /** 某个作用域的原始映射——供 `/plugin list` 在有效状态旁展示各作用域
   *  的标志。 */
  scopeEntries(scope: PluginScope): Record<string, boolean> {
    return { ...(this.perScope.get(scope) ?? {}) }
  }
}

// ── 变更类写入（供 /plugin enable|disable|install 使用） ────────────

/** 在选定作用域写入单个插件的启用标志。采用读-改-写，以免覆盖 settings.json
 *  中无关的字段（例如 skill 子系统的 `disabledSkills`）。返回文件是否真的
 *  发生了变化（调用方可据此渲染出准确的“已启用”与“启用成功”两种消息）。 */
export async function setPluginEnabled(
  pluginId: string,
  scope: PluginScope,
  enabled: boolean,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  const changed = await mutateSettingsFile(file, (existing) => {
    const currentMap = enabledPluginsFrom(existing.enabledPlugins)
    if (currentMap[pluginId] === enabled) return false
    currentMap[pluginId] = enabled
    existing.enabledPlugins = currentMap
    return true
  })
  return changed ? 'changed' : 'noop'
}

/** 从某作用域的 enabledPlugins 里删除插件条目（供 `/plugin uninstall`
 *  使用，以保持 settings.json 整洁）。 */
export async function clearPluginEntry(
  pluginId: string,
  scope: PluginScope,
  cwd: string = process.cwd(),
): Promise<'changed' | 'noop'> {
  const file = settingsPathForScope(scope, cwd)
  const changed = await mutateSettingsFile(file, (existing) => {
    const currentMap = enabledPluginsFrom(existing.enabledPlugins)
    if (!(pluginId in currentMap)) return false
    delete currentMap[pluginId]

    if (Object.keys(currentMap).length === 0) delete existing.enabledPlugins
    else existing.enabledPlugins = currentMap
    return true
  })
  return changed ? 'changed' : 'noop'
}
