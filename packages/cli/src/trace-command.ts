// @x-code-cli/cli — `xc trace`：读取本地 turn trace
//
// trace 由 core 写入 ~/.x-code/logs/turns.jsonl（5 MB 滚动到 .1）。这个命令只做
// 本地读取与格式化，不发网络请求，也不依赖 provider。
import path from 'node:path'

import { formatUsd, readTurnTraces, userXcodeDir } from '@x-code-cli/core'

interface LastArg {
  limit: number
  /** 提供了 --last 但值非法时的可读提示（此时仍回落到默认条数）。 */
  invalid?: string
}

function parseLast(args: string[]): LastArg {
  const index = args.indexOf('--last')
  if (index < 0) return { limit: 20 }
  const raw = args[index + 1]
  if (raw === undefined) return { limit: 20, invalid: '--last requires a value' }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { limit: 20, invalid: `--last expects a positive integer, got "${raw}"` }
  }
  return { limit: Math.min(1000, value) }
}

const USAGE = 'Usage: xc trace [--last N] [--json] [--help]'

export async function runTraceCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const last = parseLast(args)
  if (last.invalid) process.stderr.write(`${last.invalid}\n${USAGE}\n`)
  const json = args.includes('--json')
  const dir = path.join(userXcodeDir(), 'logs')
  let entries: Awaited<ReturnType<typeof readTurnTraces>>
  try {
    entries = await readTurnTraces(last.limit)
  } catch (error) {
    // 命令入口不把异常冒泡成 Node 堆栈：写 stderr 并给脚本一个非 0 退出码。
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to read turn traces in ${dir}: ${message}\n`)
    return 1
  }

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
    // ts 是 UTC ISO：显式标注时区，且没有小数秒的写法也一并归一化。
    (entry.ts ?? '').replace('T', ' ').replace(/\.\d+Z?$|Z$/, ' UTC'),
    entry.modelId ?? '?',
    String(entry.turn ?? '?'),
    entry.durationMs !== undefined ? `${(entry.durationMs / 1000).toFixed(1)}s` : '?',
    String(entry.inputTokens ?? 0),
    String(entry.outputTokens ?? 0),
    String(entry.cacheReadTokens ?? 0),
    String(entry.toolCalls ?? 0),
    typeof entry.costUsd === 'number' ? formatUsd(entry.costUsd) : '-',
    // 与 ts/modelId 不同，finishReason 没有在 core 侧做类型校验，非字符串会让 padEnd 抛错。
    typeof entry.finishReason === 'string' ? entry.finishReason : '?',
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
