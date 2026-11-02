// @x-code-cli/core — 每轮结构化 trace
//
// 只记录计数和时长，不记录提示词、回复或工具输出。写到
// `~/.x-code/logs/turns.jsonl`（单文件滚动到 5 MB），用于回答“这一轮为什么
// 慢 / 为什么没命中缓存 / 花了多少”，不需要任何远程遥测。
//
// 写入失败绝不影响对话：`recordTurnTrace` 是即发即忘，并只走 debugLog。
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage, userXcodeDir } from '../utils.js'

export interface TurnTraceEntry {
  ts: string
  sessionId: string
  /** 本次 submit 内的轮次，从 1 开始。 */
  turn: number
  modelId: string
  durationMs: number
  /** 本轮新增的 token（不是累计值）。 */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 本轮结束时最近一次请求的上下文占用。 */
  contextTokens: number
  toolCalls: number
  /** 提供商的 finishReason，或 `error` / `aborted`。 */
  finishReason: string
  /** 本轮新增的估算成本（USD，列表价）。 */
  costUsd: number
  unpricedModels: string[]
}

export const MAX_TURN_TRACE_BYTES = 5 * 1024 * 1024

// 所有 trace 写入串行化，退出前可以等待整条链排空；否则 --print 的
// process.exit 可能丢掉最后一轮。
let writeChain: Promise<void> = Promise.resolve()

function traceDirectory(): string {
  return path.join(userXcodeDir(), 'logs')
}

export interface WriteTurnTraceOptions {
  /** 测试用覆盖；默认 `~/.x-code/logs`。 */
  dir?: string
  maxBytes?: number
}

/** 追加一条 trace；超过上限时把当前文件滚动为 `.1`。 */
export function writeTurnTrace(entry: TurnTraceEntry, options: WriteTurnTraceOptions = {}): Promise<void> {
  const run = writeChain.then(() => appendTurnTrace(entry, options))
  writeChain = run.catch(() => undefined)
  return run
}

async function appendTurnTrace(entry: TurnTraceEntry, options: WriteTurnTraceOptions = {}): Promise<void> {
  const dir = options.dir ?? traceDirectory()
  const maxBytes = options.maxBytes ?? MAX_TURN_TRACE_BYTES
  const file = path.join(dir, 'turns.jsonl')
  await fs.mkdir(dir, { recursive: true })
  const stat = await fs.stat(file).catch(() => null)
  if (stat && stat.size >= maxBytes) {
    await fs.rename(file, `${file}.1`).catch(() => {})
  }
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** 等待所有已排队的 trace 写入落盘。进程退出前调用。 */
export async function flushTurnTrace(): Promise<void> {
  await writeChain.catch(() => undefined)
}

/** 即发即忘的 trace 写入；永远不向调用方抛错。 */
export function recordTurnTrace(entry: TurnTraceEntry): void {
  void writeTurnTrace(entry).catch((error) => debugLog('turn-trace.write-error', errorMessage(error)))
}

async function readTraceFile(file: string): Promise<TurnTraceEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return []
  }
  const entries: TurnTraceEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TurnTraceEntry
      if (parsed && typeof parsed.ts === 'string' && typeof parsed.modelId === 'string') entries.push(parsed)
    } catch {
      // 跳过损坏的行。
    }
  }
  return entries
}

/** 读取最近的 turn trace（`.1` 在前、当前文件在后），供 `xc trace` 和诊断包使用。 */
export async function readTurnTraces(limit = 20, dir?: string): Promise<TurnTraceEntry[]> {
  const base = dir ?? traceDirectory()
  const entries = [
    ...(await readTraceFile(path.join(base, 'turns.jsonl.1'))),
    ...(await readTraceFile(path.join(base, 'turns.jsonl'))),
  ]
  return entries.slice(-Math.max(1, Math.min(1000, Math.round(limit))))
}
