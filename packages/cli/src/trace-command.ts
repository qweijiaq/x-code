// @x-code-cli/cli — `xc trace`：读取本地 turn trace
//
// trace 由 core 写入 ~/.x-code/logs/turns.jsonl（5 MB 滚动到 .1）。这个命令只做
// 本地读取与格式化，不发网络请求，也不依赖 provider。
import path from 'node:path'

import { formatUsd, readTurnTraces, userXcodeDir } from '@x-code-cli/core'

function parseLast(args: string[]): number {
  const index = args.indexOf('--last')
  if (index >= 0) {
    const value = Number(args[index + 1])
    if (Number.isSafeInteger(value) && value > 0) return Math.min(1000, value)
  }
  return 20
}

const USAGE = 'Usage: xc trace [--last N] [--json]'

export async function runTraceCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const last = parseLast(args)
  const json = args.includes('--json')
  const dir = path.join(userXcodeDir(), 'logs')
  const entries = await readTurnTraces(last)

  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  if (entries.length === 0) {
    process.stdout.write(`No turn traces yet. Expected at ${path.join(dir, 'turns.jsonl')}.\n`)
    return 0
  }

  const header = ['TIME', 'MODEL', 'TURN', 'DUR', 'IN', 'OUT', 'CACHE', 'TOOLS', 'COST', 'FINISH']
  const rows = entries.map((entry) => [
    (entry.ts ?? '').replace('T', ' ').replace(/\..*$/, ''),
    entry.modelId ?? '?',
    String(entry.turn ?? '?'),
    entry.durationMs !== undefined ? `${(entry.durationMs / 1000).toFixed(1)}s` : '?',
    String(entry.inputTokens ?? 0),
    String(entry.outputTokens ?? 0),
    String(entry.cacheReadTokens ?? 0),
    String(entry.toolCalls ?? 0),
    typeof entry.costUsd === 'number' ? formatUsd(entry.costUsd) : '-',
    entry.finishReason ?? '?',
  ])
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]!.length)))
  const line = (row: string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join('  ')
      .trimEnd()

  const totalTokens = entries.reduce((sum, entry) => sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0), 0)
  const totalCost = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
  process.stdout.write(`${line(header)}\n${line(widths.map((width) => '-'.repeat(width)))}\n`)
  for (const row of rows) process.stdout.write(`${line(row)}\n`)
  process.stdout.write(
    `\n${entries.length} turn(s) · ${totalTokens.toLocaleString('en-US')} tokens · ${formatUsd(totalCost)}\n`,
  )
  return 0
}
