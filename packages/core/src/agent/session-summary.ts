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

/** 使用模型从消息生成会话摘要。返回完整结构化的 `SessionSummary`
 *  （title + status + key results + pendingWork + decisions）——调用方通常用
 *  `summary` 字段做上下文替换，其余用于选择器 / 展示。 */
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
      ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),
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
