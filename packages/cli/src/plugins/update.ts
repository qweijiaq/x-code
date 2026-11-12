// @x-code-cli/cli — 插件更新的共享操作
//
// `xc plugin update` 与 `/plugin update` 曾各自实现一遍“从记录源重装并比较版本”。
// 这里只保留一份：UI 层负责确认提示与输出格式，行为保持一致。
import { installPlugin } from '@x-code-cli/core'
import type { ConsentPreview, InstalledPluginRecord } from '@x-code-cli/core'

export interface PluginUpdateOptions {
  /** 省略表示跳过 consent（`--yes` 路径）。 */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
}

export type PluginUpdateResult =
  | { status: 'updated'; record: InstalledPluginRecord; version: string }
  | { status: 'unchanged'; record: InstalledPluginRecord; version: string }
  | { status: 'failed'; record: InstalledPluginRecord; error: string }

export async function updateInstalledPlugin(
  record: InstalledPluginRecord,
  options: PluginUpdateOptions = {},
): Promise<PluginUpdateResult> {
  try {
    const result = await installPlugin({
      source: record.source,
      marketplace: record.marketplace,
      expectedName: record.name,
      ...(options.consent ? { consent: options.consent } : {}),
    })
    return result.manifest.version === record.version
      ? { status: 'unchanged', record, version: record.version }
      : { status: 'updated', record, version: result.manifest.version }
  } catch (error) {
    return {
      status: 'failed',
      record,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
