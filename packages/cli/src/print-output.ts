// @x-code-cli/cli — `--print` 的结构化输出
//
// text 保持原来的流式纯文本；json 只在结束时输出一个结果对象；jsonl 逐事件
// 输出，方便 CI/脚本边读边处理。结构化模式绝不往 stdout 混入提示或进度，
// 那些继续走 stderr。
import { stripTerminalControls } from '@x-code-cli/core'
import type { TokenUsage } from '@x-code-cli/core'

export type PrintOutputFormat = 'text' | 'json' | 'jsonl'

export interface PrintToolRecord {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface PrintSummary {
  type: 'result'
  text: string
  modelId: string
  sessionId: string
  usage: TokenUsage
  costUsd: number
  unpricedModels: string[]
  toolCalls: PrintToolRecord[]
  error: string | null
}

export function parsePrintOutputFormat(value: unknown): PrintOutputFormat {
  return value === 'json' || value === 'jsonl' ? value : 'text'
}

/** 收集事件并写出与格式匹配的载荷。`write` 由调用方注入，便于测试。 */
export class PrintOutput {
  readonly format: PrintOutputFormat
  private readonly write: (chunk: string) => void
  private text = ''
  private readonly tools: PrintToolRecord[] = []
  private readonly toolsById = new Map<string, PrintToolRecord>()
  private usage: TokenUsage | null = null
  private error: string | null = null

  constructor(format: PrintOutputFormat, write: (chunk: string) => void) {
    this.format = format
    this.write = write
  }

  /** 供 text 模式判断是否需要补换行。 */
  get streamedText(): string {
    return this.text
  }

  textDelta(delta: string): void {
    if (!delta) return
    const clean = stripTerminalControls(delta)
    this.text += clean
    if (this.format === 'text') this.write(clean)
    else if (this.format === 'jsonl') this.write(`${JSON.stringify({ type: 'text-delta', text: clean })}\n`)
  }

  toolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
    // text 模式不需要结构化记录，避免长会话里把工具输出一直攒在内存里。
    if (this.format === 'text') return
    const record: PrintToolRecord = { toolCallId, toolName, input }
    this.tools.push(record)
    this.toolsById.set(toolCallId, record)
    if (this.format === 'jsonl') {
      this.write(`${JSON.stringify({ type: 'tool-call', toolCallId, toolName, input })}\n`)
    }
  }

  toolResult(toolCallId: string, result: string, isError = false): void {
    if (this.format === 'text') return
    const record = this.toolsById.get(toolCallId)
    if (record) {
      record.result = result
      record.isError = isError
    }
    if (this.format === 'jsonl') {
      this.write(`${JSON.stringify({ type: 'tool-result', toolCallId, result, isError })}\n`)
    }
  }

  setUsage(usage: TokenUsage): void {
    this.usage = usage
    if (this.format === 'jsonl') {
      this.write(`${JSON.stringify({ type: 'usage', usage })}\n`)
    }
  }

  setError(message: string): void {
    this.error = message
  }

  /** json 输出单个 result；jsonl 输出 done；text 不输出。 */
  finish(input: { modelId: string; sessionId: string; costUsd: number; unpricedModels: string[] }): void {
    if (this.format === 'text') return
    const usage = this.usage ?? emptyUsage()
    if (this.format === 'json') {
      const summary: PrintSummary = {
        type: 'result',
        text: this.text,
        modelId: input.modelId,
        sessionId: input.sessionId,
        usage,
        costUsd: input.costUsd,
        unpricedModels: input.unpricedModels,
        toolCalls: this.tools,
        error: this.error,
      }
      this.write(`${JSON.stringify(summary)}\n`)
      return
    }
    this.write(
      `${JSON.stringify({
        type: 'done',
        modelId: input.modelId,
        sessionId: input.sessionId,
        usage,
        costUsd: input.costUsd,
        unpricedModels: input.unpricedModels,
        toolCallCount: this.tools.length,
        error: this.error,
      })}\n`,
    )
  }
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  }
}
