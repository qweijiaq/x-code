// @x-code-cli/cli — `xc audit`：读取本地工具审批审计
//
// 审计由 core 写入 ~/.x-code/logs/audit.jsonl（5 MB 滚动到 .1）。只记录
// 写/执行类工具的权限决策、主体与脱敏后的参数摘要，不记录模型回复。
import path from 'node:path'

import { readToolAudit, userXcodeDir } from '@x-code-cli/core'

function parseLast(args: string[]): number {
  const index = args.indexOf('--last')
  if (index >= 0) {
    const value = Number(args[index + 1])
    if (Number.isSafeInteger(value) && value > 0) return Math.min(2000, value)
  }
  return 50
}

const USAGE = 'Usage: xc audit [--last N] [--json]'

export async function runAuditCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const last = parseLast(args)
  const json = args.includes('--json')
  const dir = path.join(userXcodeDir(), 'logs')
  const entries = await readToolAudit(last)

  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  if (entries.length === 0) {
    process.stdout.write(`No tool audit entries yet. Expected at ${path.join(dir, 'audit.jsonl')}.\n`)
    return 0
  }

  const header = ['TIME', 'PRINCIPAL', 'TOOL', 'DECISION', 'MODE', 'TAINT', 'REASON']
  const rows = entries.map((entry) => [
    (entry.ts ?? '').replace('T', ' ').replace(/\..*$/, ''),
    entry.principal ?? '?',
    entry.tool ?? '?',
    entry.decision ?? '?',
    entry.permissionMode ?? '?',
    entry.tainted ? 'yes' : 'no',
    entry.reason ?? '',
  ])
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]!.length)))
  const line = (row: string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join('  ')
      .trimEnd()

  process.stdout.write(`${line(header)}\n${line(widths.map((width) => '-'.repeat(width)))}\n`)
  for (const row of rows) process.stdout.write(`${line(row)}\n`)

  const denied = entries.filter((entry) => entry.decision === 'deny').length
  process.stdout.write(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${denied} denied\n`)
  return 0
}
