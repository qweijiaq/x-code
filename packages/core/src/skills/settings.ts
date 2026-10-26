// Skill settings — 各作用域的 disabledSkills 列表。
//
// 用户域：     ~/.x-code/settings.json
// 项目域：  <repo-root>/.x-code/settings.local.json（gitignored）
//
// 两个文件共享 `{ disabledSkills?: string[] }` 结构。当技能名出现在任一作用域
// 的列表中时即视为禁用——我们取并集，而非覆盖。要在别处保持禁用的同时从
// 用户域禁用中重新启用，就把该名称从用户域列表中移除。设置文件在会话内
// 不可变：SkillRegistry 在启动时按此列表过滤，因此 toggle/remove 在下次
// 启动时生效。
import path from 'node:path'

import { mutateSettingsFile, readSettingsFile } from '../settings-io.js'
import { XCODE_DIR, userXcodeDir } from '../utils.js'

export type SkillSettingsScope = 'user' | 'project'

interface SkillSettings {
  disabledSkills?: string[]
}

export function skillSettingsPath(scope: SkillSettingsScope): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(process.cwd(), XCODE_DIR, 'settings.local.json')
}

function disabledSkillsFrom(obj: Record<string, unknown>): string[] {
  const list = Array.isArray(obj.disabledSkills)
    ? (obj.disabledSkills as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  return list
}

async function readSettings(scope: SkillSettingsScope): Promise<SkillSettings> {
  const obj = await readSettingsFile(skillSettingsPath(scope))
  return { disabledSkills: disabledSkillsFrom(obj) }
}

export async function loadDisabledSkillsSet(): Promise<Set<string>> {
  const [u, p] = await Promise.all([readSettings('user'), readSettings('project')])
  const merged = new Set<string>()
  for (const name of u.disabledSkills ?? []) merged.add(name)
  for (const name of p.disabledSkills ?? []) merged.add(name)
  return merged
}

/** 在给定作用域切换技能的禁用状态。`disable=true` 添加名称；`disable=false`
 *  移除它。返回实际发生的动作，让调用方能渲染准确的消息（"already disabled"
 *  与 "disabled"）。 */
export async function setSkillDisabled(
  name: string,
  scope: SkillSettingsScope,
  disable: boolean,
): Promise<'changed' | 'noop'> {
  const changed = await mutateSettingsFile(skillSettingsPath(scope), (existing) => {
    const list = new Set(disabledSkillsFrom(existing))
    const had = list.has(name)
    if (disable === had) return false

    if (disable) list.add(name)
    else list.delete(name)

    if (list.size === 0) delete existing.disabledSkills
    else existing.disabledSkills = [...list].sort()
    return true
  })
  return changed ? 'changed' : 'noop'
}

export async function getScopedDisabledSkills(scope: SkillSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledSkills ?? []
}
