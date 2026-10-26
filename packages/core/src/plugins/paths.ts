// @x-code-cli/core — 插件文件系统布局
//
// 插件子系统集中化的路径辅助函数。其它每个插件模块都来问这里，而不是自己
// 重推路径，这样 `XC_PLUGINS_DIR` 测试覆盖只有一个咽喉点。
//
// 布局（默认在 ~/.x-code/plugins/ 下）：
//
//   known_marketplaces.json          —— 已订阅市场注册表
//   marketplaces/<name>/marketplace.json
//                                    —— 缓存的市场索引
//   cache/<marketplace>/<plugin>/<version>/
//                                    —— 实际安装的插件内容
//   data/<plugin-id>/                —— 插件的持久数据目录
//                                      （跨升级保留；plugin-id 是
//                                      "name@marketplace"，路径分隔符已净化）
//   installed_plugins.json           —— 已安装插件的记账
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'

const PLUGINS_DIR_NAME = 'plugins'
const WINDOWS_RESERVED_COMPONENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** 插件元数据可能在一个操作系统持久化、在另一个上消费，所以路径组件采用
 *  各支持文件系统最严格的公共子集。 */
export function isSafePluginPathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !path.isAbsolute(value) &&
    !/[\\/:\0-\x1f]/.test(value) &&
    !/[. ]$/.test(value) &&
    !WINDOWS_RESERVED_COMPONENT_RE.test(value)
  )
}

function requireSafePluginPathComponent(value: string, label: string): string {
  if (!isSafePluginPathComponent(value)) {
    throw new Error(`${label} must be a safe filesystem path component`)
  }
  return value
}

/** 插件子系统的根。两个覆盖旋钮，按顺序检查：
 *  - `XC_PLUGINS_DIR` —— 插件专属覆盖（对应 `XC_AGENTS_DIR` /
 *    `XC_SKILLS_DIR`；当测试只想隔离插件、而不重定向 MCP / config / OAuth
 *    时优先使用）。
 *  - `X_CODE_HOME` —— 对整个 `~/.x-code/` 根的宽覆盖（经
 *    {@link userXcodeDir} 解析）。连同 config、MCP 状态等一起重路由插件。 */
export function pluginsRoot(): string {
  const override = process.env.XC_PLUGINS_DIR
  if (override) return override
  return path.join(userXcodeDir(), PLUGINS_DIR_NAME)
}

/** ~/.x-code/plugins/known_marketplaces.json */
export function knownMarketplacesPath(): string {
  return path.join(pluginsRoot(), 'known_marketplaces.json')
}

/** ~/.x-code/plugins/marketplaces/<name>/ */
export function marketplaceDir(name: string): string {
  return path.join(pluginsRoot(), 'marketplaces', requireSafePluginPathComponent(name, 'marketplace name'))
}

/** ~/.x-code/plugins/marketplaces/<name>/marketplace.json */
export function marketplaceIndexPath(name: string): string {
  return path.join(marketplaceDir(name), 'marketplace.json')
}

/** ~/.x-code/plugins/cache/<marketplace>/<plugin>/ —— 所有版本都位于该目录
 *  下；活动版本是安装器最近一次记录在 installed_plugins.json 里的那个。 */
export function pluginCacheParent(marketplace: string, plugin: string): string {
  return path.join(
    pluginsRoot(),
    'cache',
    requireSafePluginPathComponent(marketplace, 'marketplace name'),
    requireSafePluginPathComponent(plugin, 'plugin name'),
  )
}

/** ~/.x-code/plugins/cache/<marketplace>/<plugin>/<version>/ */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return path.join(pluginCacheParent(marketplace, plugin), requireSafePluginPathComponent(version, 'plugin version'))
}

/** ~/.x-code/plugins/data/<净化后的-plugin-id>/ —— 跨升级保留的每插件持久
 *  数据目录。插件 ID（"name@marketplace"）被净化，好让 `@` 和任何意外路径
 *  分隔符不会在 Windows 上出问题。 */
export function pluginDataDir(pluginId: string): string {
  const safe = pluginId.replace(/[/\\:]/g, '_')
  return path.join(pluginsRoot(), 'data', safe)
}

/** ~/.x-code/plugins/installed_plugins.json */
export function installedPluginsPath(): string {
  return path.join(pluginsRoot(), 'installed_plugins.json')
}

/** <cwd>/.x-code/plugins/ —— 少见；用于项目把自研插件提交进仓库的情况
 *  （相对于从市场安装）。loader 除 user 作用域缓存外还会扫描这里。 */
export function projectPluginsDir(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'plugins')
}

// ── 插件根内的 manifest 发现 ─────────────────────────────

/** loader 按优先级探测的 manifest 相对路径。先找到者胜出。我们有意接受
 *  Claude Code 的路径，让为 Claude Code 编写的插件无需修改就能装进
 *  x-code-cli——见 [[plugin-marketplace-design]] §3（跨产品兼容）。 */
export const MANIFEST_CANDIDATES: ReadonlyArray<{ format: 'native' | 'claude' | 'bare'; rel: string }> = [
  { format: 'native', rel: '.x-code-plugin/plugin.json' },
  { format: 'claude', rel: '.claude-plugin/plugin.json' },
  { format: 'bare', rel: 'plugin.json' },
]

/** Gemini 的 manifest 文件名。仅用于在用户尝试安装仅 Gemini 扩展时给出
 *  有帮助的错误消息——安装器会拒绝并指向设计文档。 */
export const GEMINI_MANIFEST_REL = 'gemini-extension.json'
