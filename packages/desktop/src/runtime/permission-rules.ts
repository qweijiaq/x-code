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

/** Rules stored in one project's permissions.json; shell rules belong to the
 *  project they were approved in, so only show the ones bound to `workspace`. */
export function visiblePermissionRules(rules: AllowRule[], workspace: string): PermissionRuleView[] {
  const root = path.resolve(workspace)
  return rules
    .filter((rule) => rule.tool !== 'shell' || rule.cwd === root)
    .map(toPermissionRuleView)
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.type.localeCompare(b.type) || a.pattern.localeCompare(b.pattern))
}

/** Validate a user-authored rule and bind shell rules to the project. Only
 *  shell understands exact/prefix matching; other tools are tool-wide. */
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
