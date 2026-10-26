// Harness：以 print 模式启动 `xc -p`，并解析生成的会话 jsonl。
//
// 为什么解析 jsonl 而非 stdout：print 模式的 stdout 只是模型的最终
// assistant 文本（没有结构化的 tool-call 标记）。会话 jsonl 以易于解析的
// 格式包含每一次 assistant tool-call + tool-result 事件，且在 UI 变化时保持
// 稳定。参见 packages/core/src/agent/session-store.ts。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { RunCliOptions, RunResult, ToolCall } from './types.js'

export interface HarnessConfig {
  cliBin: string
  modelId: string
  defaultTimeoutMs: number
}

export async function runCliInDir(
  cwd: string,
  prompt: string,
  cfg: HarnessConfig,
  options?: RunCliOptions,
): Promise<RunResult> {
  const args = ['-p', prompt, ...(options?.args ?? [])]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // `pnpm test:e2e` 会把 INIT_CWD 设为仓库根。CLI 启动时会还原该值，
    // 原样透传会悄悄把每个场景移出隔离的 cwd，把会话/产物写进真实仓库。
    // 所以要把包管理器的 cwd 还原限定在场景目录内。
    INIT_CWD: cwd,
    X_CODE_HOME: path.join(cwd, '.x-code-home'), // 每个场景隔离 user 级 ~/.x-code
    X_CODE_MODEL: cfg.modelId,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    ...(options?.env ?? {}),
  }
  const startedAt = Date.now()

  const child = spawn(process.execPath, [cfg.cliBin, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString('utf-8')
  })
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString('utf-8')
  })

  const timeoutMs = options?.timeoutMs ?? cfg.defaultTimeoutMs
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, timeoutMs)

  const exitCode: number = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1))
  })
  clearTimeout(timer)

  if (timedOut) {
    stderr += `\n[harness] timeout after ${timeoutMs}ms — killed`
  }

  // 为那些在 print 模式执行 await 的会话保存之前就完成最终流回调的
  // 提供方保留一个短暂的稳定性守护。
  await waitForJsonlStable(path.join(cwd, '.x-code', 'sessions'))

  // 在 cwd/.x-code/sessions/ 中定位最新的会话 jsonl
  const sessionJsonlPath = await pickLatestSessionJsonl(path.join(cwd, '.x-code', 'sessions'))
  const parsed: ParsedSession = sessionJsonlPath
    ? await parseSessionJsonl(sessionJsonlPath)
    : { assistantText: '', toolCalls: [] }

  return {
    assistantText: parsed.assistantText || stdout, // 回退：print 模式下 stdout 本身就是 assistant 文本
    toolCalls: parsed.toolCalls,
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    sessionJsonlPath: sessionJsonlPath ?? '',
    ...(parsed.tokenUsage ? { tokenUsage: parsed.tokenUsage } : {}),
  }
}

async function waitForJsonlStable(dir: string, maxWaitMs = 2000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  let lastSize = -1
  let stableTicks = 0
  while (Date.now() < deadline) {
    let size = 0
    try {
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const s = await fs.stat(path.join(dir, name))
        size += s.size
      }
    } catch {
      // 目录尚不存在 — 继续轮询
    }
    if (size > 0 && size === lastSize) {
      stableTicks++
      if (stableTicks >= 2) return // 连续两次大小相等 ≈ 约 200ms 空闲
    } else {
      stableTicks = 0
      lastSize = size
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function pickLatestSessionJsonl(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir)
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'))
    if (jsonls.length === 0) return null
    const stats = await Promise.all(
      jsonls.map(async (name) => {
        const full = path.join(dir, name)
        const s = await fs.stat(full)
        return { full, mtime: s.mtimeMs }
      }),
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    return stats[0]!.full
  } catch {
    return null
  }
}

interface ParsedSession {
  assistantText: string
  toolCalls: ToolCall[]
  tokenUsage?: NonNullable<RunResult['tokenUsage']>
}

async function parseSessionJsonl(filePath: string): Promise<ParsedSession> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const assistantPieces: string[] = []
  const toolCalls: ToolCall[] = []
  const resultByCallId = new Map<string, { text: string; isError: boolean }>()
  let tokenUsage: NonNullable<RunResult['tokenUsage']> | undefined

  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    if (e.t === 'meta' && e.kind === 'usage') {
      const usage = e.usage as Record<string, number> | undefined
      if (usage) {
        tokenUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheCreationTokens ?? 0,
        }
      }
      continue
    }

    if (e.t !== 'msg') continue
    const message = e.message as { role?: string; content?: unknown } | undefined
    if (!message) continue

    if (message.role === 'assistant') {
      // content 可以是字符串或 parts 数组
      if (typeof message.content === 'string') {
        assistantPieces.push(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          if (part.type === 'text' && typeof part.text === 'string') {
            assistantPieces.push(part.text)
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              toolCallId: String(part.toolCallId ?? ''),
              toolName: String(part.toolName ?? ''),
              input: (part.input ?? {}) as Record<string, unknown>,
            })
          }
        }
      }
    } else if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content as Record<string, unknown>[]) {
        if (part.type !== 'tool-result') continue
        const callId = String(part.toolCallId ?? '')
        const output = part.output as Record<string, unknown> | undefined
        const text = extractToolResultText(output)
        const isError = (part as { isError?: boolean }).isError === true
        resultByCallId.set(callId, { text, isError })
      }
    }
  }

  // 把结果合并进匹配的工具调用。
  for (const tc of toolCalls) {
    const r = resultByCallId.get(tc.toolCallId)
    if (r) {
      tc.resultText = r.text
      tc.isError = r.isError
    }
  }

  return {
    assistantText: assistantPieces.join('').trim(),
    toolCalls,
    ...(tokenUsage ? { tokenUsage } : {}),
  }
}

function extractToolResultText(output: Record<string, unknown> | undefined): string {
  if (!output) return ''
  // AI SDK v6 的 tool-result 输出形状：{ type: 'content', value: [{ type: 'text', text }, ...] }
  if (output.type === 'content' && Array.isArray(output.value)) {
    const pieces: string[] = []
    for (const part of output.value as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text)
    }
    return pieces.join('')
  }
  // 有些工具直接输出 { type: 'text', value: '...' }。
  if (output.type === 'text' && typeof output.value === 'string') return output.value
  // 回退：序列化整个对象 — 至少给测试留点可匹配的内容。
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}
