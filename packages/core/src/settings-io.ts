// @x-code-cli/core — 共享的 JSON 设置文件读/改/写
//
// 技能（disabledSkills）和插件（enabledPlugins）都使用同一批物理
// settings.json 文件（用户作用域和项目作用域）。本模块提供共享的读-改-写
// 管道，让每个子系统只需处理各自的字段逻辑。
import fs from 'node:fs/promises'

import { atomicWriteFile } from './utils/atomic-file.js'

/** 读取 settings.json 文件，容忍文件缺失和 JSON 格式错误。返回可变的浅拷贝——
 *  可以先修改再传给 writeSettingsFile。 */
export async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) }
    }
    return {}
  } catch {
    return {}
  }
}

/** 把设置对象写回磁盘，且不会暴露部分写入的 JSON 文件。 */
async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n')
}

/** 对 settings.json 文件执行读-改-写。mutator 仅在实际修改对象时返回 true，
 *  从而避免无操作更新触发不必要的写入。 */
export async function mutateSettingsFile(
  filePath: string,
  mutator: (data: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const data = await readSettingsFile(filePath)
  const changed = mutator(data)
  if (!changed) return false
  await writeSettingsFile(filePath, data)
  return true
}
