// @x-code-cli/core — 本地工具审批审计
//
// 与 turn trace 一样只写本地：`~/.x-code/logs/audit.jsonl`（5 MB 滚动）。
// 目的不是记录对话，而是回答“谁在什么权限模式下批准/拒绝了哪个写操作”。
// 参数里的密钥类字段会被脱敏，且每个值截断，避免把凭据或大段代码带进日志。
//
// 写入失败绝不影响工具执行：recordToolAudit 是即发即忘。
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage, userXcodeDir } from '../utils.js'

export type AuditPrincipal = 'user' | 'peer'
export type AuditDecision = 'allow' | 'deny' | 'allow-once'

export interface ToolAuditEntry {
  ts: string
  sessionId: string
  toolCallId: string
  tool: string
  principal: AuditPrincipal
  permissionMode: string
  trustMode: boolean
  tainted: boolean
  decision: AuditDecision
  reason?: string
  input: Record<string, unknown>
}

export const MAX_AUDIT_BYTES = 5 * 1024 * 1024
const MAX_VALUE_CHARS = 400
const MAX_INPUT_KEYS = 40
const SECRET_KEY_RE = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)/i

let writeChain: Promise<void> = Promise.resolve()

function auditDirectory(): string {
  return path.join(userXcodeDir(), 'logs')
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_INPUT_KEYS)) {
      out[key] = SECRET_KEY_RE.test(key) ? '••••' : redactValue(item, depth + 1)
    }
    return out
  }
  return String(value)
}

export function redactAuditInput(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(input) as Record<string, unknown>
}

export interface WriteAuditOptions {
  /** 测试用覆盖；默认 `~/.x-code/logs`。 */
  dir?: string
  maxBytes?: number
}

export function writeToolAudit(entry: ToolAuditEntry, options: WriteAuditOptions = {}): Promise<void> {
  const run = writeChain.then(() => appendToolAudit(entry, options))
  writeChain = run.catch(() => undefined)
  return run
}

async function appendToolAudit(entry: ToolAuditEntry, options: WriteAuditOptions = {}): Promise<void> {
  const dir = options.dir ?? auditDirectory()
  const maxBytes = options.maxBytes ?? MAX_AUDIT_BYTES
  const file = path.join(dir, 'audit.jsonl')
  await fs.mkdir(dir, { recursive: true })
  const stat = await fs.stat(file).catch(() => null)
  if (stat && stat.size >= maxBytes) await fs.rename(file, `${file}.1`).catch(() => {})
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** 即发即忘；永不向工具执行路径抛错。 */
export function recordToolAudit(
  entry: Omit<ToolAuditEntry, 'ts' | 'input'> & { input: Record<string, unknown> },
): void {
  const payload: ToolAuditEntry = {
    ...entry,
    ts: new Date().toISOString(),
    input: redactAuditInput(entry.input),
  }
  void writeToolAudit(payload).catch((error) => debugLog('audit.write-error', errorMessage(error)))
}

/** 等待已排队的审计写入落盘；进程退出前调用。 */
export async function flushToolAudit(): Promise<void> {
  await writeChain.catch(() => undefined)
}

async function readAuditFile(file: string): Promise<ToolAuditEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return []
  }
  const entries: ToolAuditEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ToolAuditEntry
      if (parsed && typeof parsed.ts === 'string' && typeof parsed.tool === 'string') entries.push(parsed)
    } catch {
      // 跳过损坏的行。
    }
  }
  return entries
}

/** 读取最近的审批审计（`.1` 在前、当前文件在后）。 */
export async function readToolAudit(limit = 50, dir?: string): Promise<ToolAuditEntry[]> {
  const base = dir ?? auditDirectory()
  const entries = [
    ...(await readAuditFile(path.join(base, 'audit.jsonl.1'))),
    ...(await readAuditFile(path.join(base, 'audit.jsonl'))),
  ]
  return entries.slice(-Math.max(1, Math.min(2000, Math.round(limit))))
}
