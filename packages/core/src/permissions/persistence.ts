import fs from 'node:fs'
import path from 'node:path'

import { XCODE_DIR, debugLog } from '../utils.js'
import type { AllowRule } from './session-store.js'

const PERMISSIONS_VERSION = 2

function parseLegacyRuleString(value: string, projectCwd: string): AllowRule | null {
  const toolWide = value.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }

  const prefix = value.match(/^([^:]+):(.+):\*$/)
  if (prefix) {
    return {
      tool: prefix[1]!,
      pattern: prefix[2]!,
      type: 'prefix',
      ...(prefix[1] === 'shell' ? { cwd: projectCwd } : {}),
    }
  }

  const exact = value.match(/^([^:]+):=(.+)$/)
  if (exact) {
    return {
      tool: exact[1]!,
      pattern: exact[2]!,
      type: 'exact',
      ...(exact[1] === 'shell' ? { cwd: projectCwd } : {}),
    }
  }

  return null
}

function parseVersionTwoRule(value: unknown): AllowRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rule = value as Record<string, unknown>
  if (
    typeof rule.tool !== 'string' ||
    typeof rule.pattern !== 'string' ||
    (rule.type !== 'exact' && rule.type !== 'prefix' && rule.type !== 'tool')
  ) {
    return null
  }
  if (rule.tool === 'shell' && typeof rule.cwd !== 'string') return null
  if (rule.cwd !== undefined && typeof rule.cwd !== 'string') return null
  return {
    tool: rule.tool,
    pattern: rule.pattern,
    type: rule.type,
    ...(typeof rule.cwd === 'string' ? { cwd: rule.cwd } : {}),
  }
}

function getPermissionsPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'local', 'permissions.json')
}

export function readPersistedRules(cwd: string): AllowRule[] {
  let raw: string
  try {
    raw = fs.readFileSync(getPermissionsPath(cwd), 'utf-8')
  } catch {
    return []
  }

  let data: { version?: unknown; allow?: unknown }
  try {
    data = JSON.parse(raw) as { version?: unknown; allow?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(data.allow)) return []

  const projectCwd = path.resolve(cwd)
  const parsed = data.allow.map((value) =>
    data.version === PERMISSIONS_VERSION
      ? parseVersionTwoRule(value)
      : typeof value === 'string'
        ? parseLegacyRuleString(value, projectCwd)
        : null,
  )
  if (parsed.some((rule) => rule === null)) {
    debugLog('permissions.rule-skipped', `Skipped malformed permission rules in ${getPermissionsPath(cwd)}`)
  }
  return parsed.filter((rule): rule is AllowRule => rule !== null)
}

/**
 * 将新规则持久化到 `.x-code/local/permissions.json`。
 * 文件不存在时创建，并将旧版字符串规则迁移到 v2。
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const rules = readPersistedRules(cwd)
  const normalizedRule = normalizeRule(cwd, rule)

  if (!rules.some((entry) => sameRule(entry, normalizedRule))) {
    rules.push(normalizedRule)
  }

  writeRules(filePath, rules)
}

/**
 * 从 `.x-code/local/permissions.json` 删除一条规则。
 * 文件发生变化时返回 true。没有 `cwd` 的 shell 规则会归一化为项目目录，
 * 与 `persistRule` 保持一致。
 */
export function removePersistedRule(cwd: string, rule: AllowRule): boolean {
  const rules = readPersistedRules(cwd)
  const normalizedRule = normalizeRule(cwd, rule)
  const remaining = rules.filter((entry) => !sameRule(entry, normalizedRule))
  if (remaining.length === rules.length) return false
  writeRules(getPermissionsPath(cwd), remaining)
  return true
}

function normalizeRule(cwd: string, rule: AllowRule): AllowRule {
  return rule.tool === 'shell' && !rule.cwd ? { ...rule, cwd: path.resolve(cwd) } : rule
}

function sameRule(left: AllowRule, right: AllowRule): boolean {
  return (
    left.tool === right.tool && left.pattern === right.pattern && left.type === right.type && left.cwd === right.cwd
  )
}

function writeRules(filePath: string, rules: AllowRule[]): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify({ version: PERMISSIONS_VERSION, allow: rules }, null, 2) + '\n', 'utf-8')
}
