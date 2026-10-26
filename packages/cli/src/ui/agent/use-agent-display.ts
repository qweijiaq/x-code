// @x-code-cli/cli — ModelMessage → DisplayMessage 转换。
//
// 从 use-agent.ts 提取，让 hook 主体专注于状态管理。本模块仅用于 UI——它从不
// 触碰 core agent 循环。
import type { DisplayMessage, DisplayToolCall, ModelMessage } from '@x-code-cli/core'
import { TOOL_SEARCH_TOOL_NAME, extractText } from '@x-code-cli/core'

type ContentPartLike = {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

/** 从工具结果部件中取出字符串输出。AI SDK 把工具输出规范化成
 *  `{ type: 'text' | 'error-text' | ..., value: string }`，但更旧 / provider
 *  特定的形状也会透传，所以我们防御性地强制转换。 */
function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined
  if (typeof out === 'string') return { output: out, isError: false }
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json'
    const value = out.value
    if (typeof value === 'string') return { output: value, isError }
    if (value !== undefined) return { output: JSON.stringify(value), isError }
  }
  return { output: '', isError: false }
}

/** 把加载的 ModelMessage[] 转换回 ChatInput 渲染的 DisplayMessage[] 形状。
 *  把每个有 N 个工具调用的 assistant 消息拆成 N+1 条 DisplayMessage（有文本时
 *  一条纯文本，然后每个工具调用一条），这样实时 agent 流的渲染模式就被原样
 *  保留——单回合里多个并行的工具调用仍显示为分开的 `⎿` 行。
 *
 *  工具消息本身不变成 DisplayMessage；它们的输出通过 `toolCallId` 拼接到
 *  匹配的工具调用 DisplayMessage 上。 */
export function modelMessagesToDisplay(messages: ModelMessage[]): DisplayMessage[] {
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part))
      }
    }
  }
  const out: DisplayMessage[] = []
  let counter = 0
  const baseTs = Date.now() - messages.length
  for (const msg of messages) {
    counter++
    if (msg.role === 'system' || msg.role === 'tool') continue
    const id = `hydrated-${counter}`
    const ts = baseTs + counter
    if (msg.role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ id, role: 'user', content: text, timestamp: ts })
      continue
    }
    // assistant
    const text = extractText(msg.content)
    if (text) out.push({ id: `${id}-text`, role: 'assistant', content: text, timestamp: ts })
    if (Array.isArray(msg.content)) {
      let tcIdx = 0
      for (const part of msg.content as ContentPartLike[]) {
        if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
        // toolSearch 在实时流中从 scrollback 隐藏（见 use-agent.ts）——这里也
        // 跳过它，这样恢复的会话不会突然露出实时视图隐藏过的工具搜索调用。
        if (part.toolName === TOOL_SEARCH_TOOL_NAME) continue
        if (
          part.toolName === 'shellOutput' &&
          (!part.input ||
            typeof part.input !== 'object' ||
            !('chars' in (part.input as Record<string, unknown>)) ||
            (part.input as Record<string, unknown>).chars === '')
        ) {
          continue
        }
        tcIdx++
        const result = toolResults.get(part.toolCallId)
        const tc: DisplayToolCall = {
          id: `${id}-tc-${tcIdx}`,
          toolName: part.toolName ?? 'unknown',
          input: (part.input as Record<string, unknown>) ?? {},
          output: result?.output,
          status: result ? (result.isError ? 'error' : 'completed') : 'pending',
        }
        out.push({
          id: `${id}-tcm-${tcIdx}`,
          role: 'assistant',
          content: '',
          toolCalls: [tc],
          timestamp: ts,
        })
      }
    }
  }
  return out
}

export function previewSubInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    (input.path as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}
