import path from 'node:path'

import type { AllowRule } from '@x-code-cli/core'

import type { PermissionRuleType, PermissionRuleView } from '../shared/protocol.js'

const RULE_TYPES: PermissionRuleType[] = ['exact', 'prefix', 'tool']

export function permissionRuleLabel(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

export function toPermissionRuleView(rule: AllowRule): PermissionRuleView {
  return {
    tool: rule.tool,
    pattern: rule.pattern,
    type: rule.type,
    ...(rule.cwd ? { cwd: rule.cwd } : {}),
    label: permissionRuleLabel(rule),
  }
}

/** 某个项目 permissions.json 中存储的规则；shell 规则属于其
 *  获批的项目，因此只显示绑定到 `workspace` 的那些。 */
export function visiblePermissionRules(rules: AllowRule[], workspace: string): PermissionRuleView[] {
  const root = path.resolve(workspace)
  return rules
    .filter((rule) => rule.tool !== 'shell' || rule.cwd === root)
    .map(toPermissionRuleView)
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.type.localeCompare(b.type) || a.pattern.localeCompare(b.pattern))
}

/** 校验用户编写的规则并把 shell 规则绑定到项目。只有
 *  shell 支持精确/前缀匹配；其他工具是工具级。 */
export function normalizeNewPermissionRule(
  toolName: string,
  type: PermissionRuleType,
  pattern: string,
  workspace: string,
): AllowRule {
  const tool = toolName.trim()
  if (!tool) throw new Error('工具名不能为空')
  if (!RULE_TYPES.includes(type)) throw new Error('未知的规则类型')
  const trimmed = pattern.trim()
  if (type !== 'tool') {
    if (!trimmed || trimmed === '*') throw new Error('匹配模式不能为空')
    if (tool !== 'shell') throw new Error('只有 shell 工具支持前缀或精确匹配')
    return { tool, pattern: trimmed, type, cwd: path.resolve(workspace) }
  }
  return { tool, pattern: '*', type: 'tool', ...(tool === 'shell' ? { cwd: path.resolve(workspace) } : {}) }
}
