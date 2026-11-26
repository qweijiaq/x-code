// @x-code-cli/cli — 插件更新的共享操作
//
// `xc plugin update` 与 `/plugin update` 曾各自实现一遍“从记录源重装并比较版本”。
// 这里只保留一份：UI 层负责确认提示与输出格式，行为保持一致。
import { debugLog, installPlugin } from '@x-code-cli/core'
import type {
  ConsentPreview,
  InstalledPluginRecord,
  PluginManifest,
  PluginScope,
  UserConfigValue,
} from '@x-code-cli/core'

export interface PluginUpdateOptions {
  /** 省略表示跳过 consent（`--yes` 路径）。 */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
  /** 与安装路径一致地处理 manifest 新增的 `userConfig` 字段。省略表示跳过提示。 */
  userConfigPrompt?: (fields: PluginManifest['userConfig']) => Promise<Record<string, UserConfigValue> | null>
  /** 传给 git clone / 下载，让 TUI 里的更新可以被取消。 */
  signal?: AbortSignal
}

export type PluginUpdateResult =
  | { status: 'updated'; record: InstalledPluginRecord; version: string }
  | { status: 'unchanged'; record: InstalledPluginRecord; version: string }
  /** 用户主动取消（Esc / 拒绝 consent）：不是失败，UI 层可以区别渲染。 */
  | { status: 'cancelled'; record: InstalledPluginRecord }
  | { status: 'failed'; record: InstalledPluginRecord; error: string }

/** 注册表只校验 `plugins` 是数组，旧记录可能缺少 `installScope`。缺省时必须显式
 *  回落，否则 `installPlugin` 会静默把它改写成 user 作用域（“更新后插件失效”）。 */
function normalizeInstallScope(value: unknown, pluginId: string): PluginScope {
  if (value === 'user' || value === 'project') return value
  debugLog('plugin.update.scope-missing', `${pluginId}: falling back to 'user' scope`)
  return 'user'
}

/** 用户主动取消的两种形态：Esc 取消的 AbortError，以及 consent 被拒的 InstallError。 */
function isUserCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return error.name === 'InstallError' && /cancelled by user/i.test(error.message)
}

export async function updateInstalledPlugin(
  record: InstalledPluginRecord,
  options: PluginUpdateOptions = {},
): Promise<PluginUpdateResult> {
  try {
    const result = await installPlugin({
      source: record.source,
      marketplace: record.marketplace,
      expectedName: record.name,
      // 沿用原记录的作用域：`installPlugin` 缺省为 `'user'` 并会覆盖注册表条目，
      // 不传的话从一个 project 作用域安装的插件只要更新一次就会被静默改写成
      // user 作用域，启用它的 settings.json 也随之错位（“更新后插件失效”）。
      scope: normalizeInstallScope(record.installScope, record.id),
      ...(options.consent ? { consent: options.consent } : {}),
      ...(options.userConfigPrompt ? { userConfigPrompt: options.userConfigPrompt } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return result.manifest.version === record.version
      ? { status: 'unchanged', record, version: record.version }
      : { status: 'updated', record, version: result.manifest.version }
  } catch (error) {
    if (isUserCancellation(error, options.signal)) return { status: 'cancelled', record }
    return {
      status: 'failed',
      record,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
