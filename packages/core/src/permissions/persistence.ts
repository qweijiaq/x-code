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

/** 单条授权记录的版本兼容解析。比当前版本更新的文件仍按 v2 的结构化形状
 *  解析（新增版本只会添加字段），只有旧版本文件才可能是遗留字符串形式。 */
function parseAllowedEntry(value: unknown, version: unknown, projectCwd: string): AllowRule | null {
  if (typeof version === 'number' && version >= PERMISSIONS_VERSION) return parseVersionTwoRule(value)
  return typeof value === 'string' ? parseLegacyRuleString(value, projectCwd) : null
}

function getPermissionsPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'local', 'permissions.json')
}

/** 读取并解析授权文件。返回 `null` 表示「内容未知」（IO 错误或 JSON 损坏）——
 *  与「文件不存在」（空列表）必须区分：写入方拿到 `null` 时不能把空列表写
 *  回去，否则一次脏读就会静默清空用户所有「不再询问」授权。 */
function readRulesOrNull(cwd: string): AllowRule[] | null {
  const filePath = getPermissionsPath(cwd)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    debugLog('permissions.read-failed', `${filePath}: ${String(err)}`)
    return null
  }

  let parsedFile: unknown
  try {
    parsedFile = JSON.parse(raw)
  } catch (err) {
    debugLog('permissions.parse-failed', `${filePath}: ${String(err)}`)
    return null
  }
  // `null` / 数组 / 标量都是合法 JSON：`JSON.parse('null')` 会返回 null，
  // 直接读 `data.allow` 会抛未捕获的 TypeError 并把整条加载链路打挂。
  if (!parsedFile || typeof parsedFile !== 'object' || Array.isArray(parsedFile)) {
    debugLog('permissions.parse-failed', `${filePath}: root is not an object`)
    return null
  }
  const data = parsedFile as { version?: unknown; allow?: unknown }
  if (!Array.isArray(data.allow)) {
    debugLog('permissions.parse-failed', `${filePath}: "allow" is not an array`)
    return null
  }

  const projectCwd = path.resolve(cwd)
  const parsed = data.allow.map((value) => parseAllowedEntry(value, data.version, projectCwd))
  if (parsed.some((rule) => rule === null)) {
    debugLog('permissions.rule-skipped', `Skipped malformed permission rules in ${filePath}`)
  }
  return parsed.filter((rule): rule is AllowRule => rule !== null)
}

export function readPersistedRules(cwd: string): AllowRule[] {
  return readRulesOrNull(cwd) ?? []
}

/** 读取失败时把原文件留一份备份，让用户还能手工恢复此前所有授权。 */
function backupUnreadableRules(cwd: string): void {
  const filePath = getPermissionsPath(cwd)
  if (!fs.existsSync(filePath)) return
  const backupPath = `${filePath}.bak`
  try {
    fs.copyFileSync(filePath, backupPath)
    debugLog('permissions.unreadable-backup', `Copied unreadable ${filePath} to ${backupPath}`)
  } catch (err) {
    debugLog('permissions.unreadable-backup-failed', `${backupPath}: ${String(err)}`)
  }
}

/**
 * 将新规则持久化到 `.x-code/local/permissions.json`。
 * 文件不存在时创建，并将旧版字符串规则迁移到 v2。
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const existing = readRulesOrNull(cwd)
  // 读不出来（JSON 损坏 / IO 错误）时先备份原文件再写入：既不丢用户此前的
  // 授权，也不因为一次脏读把它们清空。
  if (existing === null) backupUnreadableRules(cwd)
  const rules = existing ?? []
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
  const rules = readRulesOrNull(cwd)
  // 内容未知时无法安全地做「删除一条」：写回就等于清空其余授权。
  if (rules === null) return false
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
  // 先写临时文件再 rename：直接覆盖原文件时若进程中途崩溃（或被信号杀掉），
  // 磁盘上会留下截断的 JSON，而读取端会把它当成「损坏」——等于清空全部授权。
  // rename 在同一文件系统内是原子的，读者只会看到旧内容或新内容。
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ version: PERMISSIONS_VERSION, allow: rules }, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // 清理尽力而为，不要掩盖原始错误。
    }
    throw err
  }
}
