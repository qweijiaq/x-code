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

/** 键名启发式——尽力而为的第一层过滤，不是一份完整清单。`shell` 的 `command`、
 *  `writeFile` 的 `content` 这类非密钥名字段里同样可能藏着凭据，因此字符串值还要
 *  过一遍 maskSecretsInString 的值级扫描。 */
const SECRET_KEY_RE =
  /(api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key|secret|token|password|passwd|passphrase|authorization|auth|cookie|credential|certificate|(?:^|[^a-z])(?:key|pin|cert)(?:[^a-z]|$))/i

/** 值级扫描：同样只是启发式，宁可多掩码几个字符，也不要把原始凭据写进本地日志。 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `-----BEGIN RSA PRIVATE KEY-----` 之类的整段私钥。
  [/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g, '$1[redacted]$2'],
  // `Authorization: Bearer …` / `-H "Authorization: Basic …"`。
  [/\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]'],
  // `password=hunter2` / `"token": "…"` / `--api-key abc123`。
  [
    /((?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key)\s*[=:]\s*)["']?[^\s"',;]{3,}["']?/gi,
    '$1[redacted]',
  ],
  // 常见云厂商 / 平台的固定前缀。
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
]

function maskSecretsInString(value: string): string {
  let masked = value
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) masked = masked.replace(pattern, replacement)
  return masked
}

let writeChain: Promise<void> = Promise.resolve()

function auditDirectory(): string {
  return path.join(userXcodeDir(), 'logs')
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') {
    const masked = maskSecretsInString(value)
    return masked.length > MAX_VALUE_CHARS ? `${masked.slice(0, MAX_VALUE_CHARS)}…` : masked
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
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.stat(file).catch(() => null)
  if (stat && stat.size >= maxBytes) {
    await fs.rename(file, `${file}.1`).catch((error) => {
      // 滚动失败不能让审批记录消失：继续追加到同一个文件，但留下可诊断的痕迹
      // （否则文件无限增长且没有任何提示）。
      debugLog('audit.rotate-error', errorMessage(error))
    })
  }
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 })
  // `mode` 只在本次创建文件时生效，而且 rename 会保留原 inode 的权限，所以
  // 由旧版本/其他进程创建的 0o644 文件不会被自动收紧。每次写入后显式收紧一次；
  // 失败不影响写入主流程（某些文件系统不支持 chmod）。
  await fs.chmod(file, 0o600).catch(() => undefined)
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

/** 等待已排队的审计写入落盘；进程退出前调用。
 *
 *  收尾阶段仍可能有审批落盘（记录本条审计的那个调用正在排队），所以只等一次会
 *  提前返回、丢掉最后几条记录。循环到队列真正稳定为止。 */
export async function flushToolAudit(): Promise<void> {
  let chain: Promise<void>
  do {
    chain = writeChain
    await chain.catch(() => undefined)
  } while (chain !== writeChain)
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
