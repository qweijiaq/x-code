// @x-code-cli/core — LLM 生成的会话摘要（用于 agent loop 的深度压缩路径）。
//
// 这里曾经的职责：`saveSessionSummary` + `loadLatestSession`，它们把
// `<sessionId>.json` 和 `latest.json` 写进 `.x-code/sessions/`。两者都已移除——
// 完整会话转录如今存放在每个会话一个的 `.jsonl` 里（见 `agent/session-store.ts`），
// 压缩摘要则作为 `compact-boundary` meta 行嵌入同一个 jsonl。
// 每会话一个文件，没有带外的伴生文件。
//
// 留下的部分：`generateSessionSummary`——一个小的、隔离的 `generateText` 调用，
// 当上下文溢出、需要压缩成一段话时由 loop 调用。结果交给 `markBoundaryAndReflush`
// （在 session-store 中），同时被包成一条 "[Previous conversation summary]" 用户消息，
// 替换 `state.messages` 中被丢弃的前缀。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { SessionSummary } from '../types/index.js'

/** 生成会话摘要时纳入的最近消息数量 */
const SESSION_SUMMARY_MESSAGE_COUNT = 20

/** 把一段 model message 内容渲染成纯文本片段。
 *  摘要只需要文本；保留结构化 `tool_use`/`tool_result` 配对反而危险。 */
function renderMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const typed = part as { type?: string; text?: unknown; toolName?: unknown; input?: unknown; output?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text)
      continue
    }
    if (typed.type === 'tool-call') {
      const input = typed.input === undefined ? '' : ` ${JSON.stringify(typed.input)}`
      parts.push(`[call ${typeof typed.toolName === 'string' ? typed.toolName : 'tool'}${input}]`)
      continue
    }
    if (typed.type === 'tool-result') {
      const output = typed.output as { type?: string; value?: unknown } | undefined
      const value = output?.value
      const text =
        typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? value
                .map((entry) =>
                  entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string'
                    ? (entry as { text: string }).text
                    : '[non-text output]',
                )
                .join('\n')
            : ''
      parts.push(`[result ${text}]`)
      continue
    }
    if (typed.type === 'reasoning' || typed.type === 'file' || typed.type === 'image') {
      // 推理与二进制片段对一段话摘要没有价值。
      continue
    }
  }
  return parts.join('\n')
}

/** 把尾部消息渲染成一份纯文本转录。
 *
 *  直接 `messages.slice(-N)` 交给 `generateText` 会把窗口起点落在
 *  「只有 tool_result、没有对应 tool_use」的位置上，Anthropic 等 provider
 *  会以 `tool_result ... no corresponding tool_use` 400 拒绝——让这条兜底路径
 *  本身成为失败点，也可能截断同一条 assistant 消息的中途。纯文本输入不携带
 *  结构化配对，因此没有这个问题。 */
function renderTranscriptTail(messages: ModelMessage[]): string {
  return messages
    .slice(-SESSION_SUMMARY_MESSAGE_COUNT)
    .map((message) => {
      const body = renderMessageContent(message.content).trim()
      return body ? `${message.role}: ${body}` : ''
    })
    .filter((line) => line.length > 0)
    .join('\n\n')
}

/** 使用模型从消息生成会话摘要。返回完整结构化的 `SessionSummary`
 *  （title + status + key results + pendingWork + decisions）——调用方通常用
 *  `summary` 字段做上下文替换，其余用于选择器 / 展示。
 *
 *  @deprecated 旧的会话摘要伴生文件已移除；当前压缩摘要直接写入会话 JSONL 的
 *  `compact-boundary` 行。此函数没有生产调用方，仅为兼容公开 API 保留，计划在
 *  下一个 major 版本移除。 */
export async function generateSessionSummary(
  messages: ModelMessage[],
  model: LanguageModel,
  sessionId: string,
  startedAt: string,
  filesModified: string[],
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const { text } = await generateText({
    model,
    abortSignal: signal,
    messages: [
      {
        role: 'system',
        content: `Summarize this conversation as a structured JSON object with these fields:
- title: short descriptive title (string)
- summary: 2-3 sentence overview (string)
- keyResults: what was accomplished (string[])
- pendingWork: what remains to be done (string[])
- decisions: important decisions made (string[])
- status: "completed" | "in_progress" | "abandoned"

Return ONLY valid JSON, no markdown fencing.`,
      },
      {
        role: 'user',
        content: `Conversation transcript (most recent messages):\n\n${renderTranscriptTail(messages)}`,
      },
    ],
  })

  try {
    const parsed = JSON.parse(text) as Partial<SessionSummary>
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      filesModified,
      title: parsed.title ?? 'Untitled session',
      summary: parsed.summary ?? '',
      keyResults: parsed.keyResults ?? [],
      pendingWork: parsed.pendingWork ?? [],
      decisions: parsed.decisions ?? [],
      status: parsed.status ?? 'completed',
    }
  } catch {
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      title: 'Session',
      summary: text.slice(0, 200),
      keyResults: [],
      pendingWork: [],
      filesModified,
      decisions: [],
      status: 'completed',
    }
  }
}
