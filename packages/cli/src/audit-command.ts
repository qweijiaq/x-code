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
  let entries: Awaited<ReturnType<typeof readToolAudit>>
  try {
    entries = await readToolAudit(last)
  } catch (error) {
    // 命令入口不把异常冒泡成 Node 堆栈：写 stderr 并给脚本一个非 0 退出码。
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to read tool audit in ${dir}: ${message}\n`)
    return 1
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  if (entries.length === 0) {
    process.stdout.write(`No tool audit entries yet. Expected at ${path.join(dir, 'audit.jsonl')}.\n`)
    return 0
  }

  const header = ['TIME (UTC)', 'PRINCIPAL', 'TOOL', 'DECISION', 'MODE', 'TAINT', 'REASON']
  // JSONL 只对 ts/tool 做了类型校验，其余字段可能缺失或类型错误：统一归一化，
  // 否则 `row[index]!.length` 会得到 undefined（widths 变 NaN），padEnd 直接抛错。
  const cell = (value: unknown, fallback = '?'): string =>
    typeof value === 'string' ? value.trim() || fallback : value == null ? fallback : String(value)
  /** 压成单行并限长：reason 常含换行/命令片段，不处理会撑破列宽与对齐。 */
  const oneLine = (value: string, max: number): string => {
    const collapsed = value.replace(/\s+/g, ' ').trim()
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
  }
  const rows = entries.map((entry) => [
    // ts 是 UTC ISO：截到秒会同时丢掉 'Z'，所以显式标注时区。
    oneLine((entry.ts ?? '').replace('T', ' ').replace(/\.\d+Z?$/, ' UTC'), 32),
    oneLine(cell(entry.principal), 24),
    oneLine(cell(entry.tool), 32),
    oneLine(cell(entry.decision), 16),
    oneLine(cell(entry.permissionMode), 16),
    entry.tainted ? 'yes' : 'no',
    oneLine(cell(entry.reason, ''), 160),
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
