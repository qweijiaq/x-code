// @x-code-cli/core — 上下文窗口压缩
//
// 两条路径共享同样的原语：
//   - 主动（`checkAndCompressContext`）：每轮开始前运行，一旦超过
//     每个模型的 token 阈值就裁掉旧消息。
//   - 响应式（`handleContextTooLong`）：当流因 "prompt too long" 分类
//     而报错时运行；压缩并发出重试信号。
//
// 两者都会先尝试廉价的进程内 light compaction（丢弃 loop-guard
// 配对——不调用 LLM）。只有这还不够时，才落到 `compressMessages`，
// 它会发起一次 generateText 往返，让 LLM 写摘要。
import { generateText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'

import type { HookBus } from '../hooks/bus.js'
import type { AgentCallbacks, ExecutionAuthority, TrackedModelMessage } from '../types/index.js'
import { debugLog } from '../utils.js'
import { isContextTooLongError } from './api-errors.js'
import { markExpectedCacheMiss } from './cache-stats.js'
import { estimateMessageTokenCount, estimateTokenCount } from './context-window.js'
import { lightCompactTrackedMessages, truncateOldTrackedToolResults } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { createTrackedMessage, mergeProvenance } from './provenance.js'
import { appendUsage, markBoundaryAndReflush } from './session-store.js'
import { setTrackedTranscript } from './tracked-messages.js'
import { accumulateUsage, attributedModelId, normalizeLanguageModelUsage } from './usage.js'

/** 贯穿两条压缩路径的可选 hook 表面。让插件可以观察（PreCompact）
 *  并对（PostCompact）裁剪上下文这一行为做出反应——对检查点持久化
 *  或审计很有用。 */
export interface CompactionHookContext {
  hookBus?: HookBus
  modelId: string
  cwd: string
  abortSignal?: AbortSignal
  authority?: ExecutionAuthority
}

/** 保留原样不动的 "recent" 切片的近似 token 预算。
 *  消息从新到旧遍历；一旦累计总量超过该预算就停止，
 *  更旧的内容都会被摘要化。防止单个巨大的工具结果吞掉
 *  整个保留窗口（旧的 KEEP_RECENT=6 条消息的做法）。 */
export const KEEP_RECENT_TOKENS = 20_000

/** 即使超过 KEEP_RECENT_TOKENS 也始终保留的最小消息数，
 *  这样我们绝不会产生一个空的 "recent" 切片。 */
export const MIN_KEEP_MESSAGES = 2

/** @deprecated 请使用 KEEP_RECENT_TOKENS。保留以向后兼容——
 *  现在返回 MIN_KEEP_MESSAGES（/compact 使用的守护值）。 */
export const KEEP_RECENT = MIN_KEEP_MESSAGES

// ── 摘要提示词 ──

const INITIAL_SUMMARY_SYSTEM = `You are a context-compression assistant. Summarize the conversation into a structured checkpoint another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARY_SYSTEM = `You are a context-compression assistant. The user will provide NEW conversation messages and a <previous-summary>. Update the existing summary with new information.

RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- If something is no longer relevant, you may remove it
- PRESERVE exact file paths, function names, and error messages

Use the SAME structured format as the previous summary (## Goal, ## Constraints & Preferences, ## Progress, ## Key Decisions, ## Next Steps, ## Critical Context).`

/** 把旧消息压缩成结构化摘要，基于 token 预算（而非固定消息数）
 *  保留最近尾部。
 *
 *  当存在 previousSummary（来自更早的压缩）时，让 LLM 用新消息
 *  增量地 UPDATE 它，而不是从头重新摘要——这能保住那些否则会
 *  在反复稀释中丢失的早期决策。
 *
 *  filesTracked 集合（若提供）会以 <files-modified> / <files-read> 标签
 *  追加到摘要里，这样即使原始消息已删除，模型也知道碰过哪些文件。 */
export interface CompressionResult {
  messages: ModelMessage[]
  summary: string
  usage?: LanguageModelUsage
  modelId?: string
}

/** 从新到旧遍历消息，累计估算 token 直到预算用尽。返回要保留的
 *  消息数（"recent" 尾部），并确保它不会以一个孤立的 tool result 开头。 */
function computeKeepCount(messages: ModelMessage[]): number {
  let keepCount = 0
  let tokenBudget = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokenCount(messages[i])
    if (tokenBudget + msgTokens > KEEP_RECENT_TOKENS && keepCount >= MIN_KEEP_MESSAGES) break
    tokenBudget += msgTokens
    keepCount++
  }
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }
  return keepCount
}

export async function compressMessagesWithUsage(
  messages: ModelMessage[],
  model: LanguageModel,
  previousSummary?: string,
  filesTracked?: { modified: string[]; read: string[] },
  abortSignal?: AbortSignal,
): Promise<CompressionResult> {
  const keepCount = computeKeepCount(messages)

  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)

  if (old.length === 0) return { messages, summary: previousSummary ?? '' }

  const { text: summary, usage, modelId } = await summarizeWithOverflowSplit(old, model, previousSummary, abortSignal)

  // 追加文件跟踪元数据
  let enrichedSummary = summary
  if (filesTracked) {
    const { modified, read } = filesTracked
    if (modified.length > 0) {
      enrichedSummary += `\n\n<files-modified>\n${modified.join('\n')}\n</files-modified>`
    }
    if (read.length > 0) {
      enrichedSummary += `\n\n<files-read>\n${read.join('\n')}\n</files-read>`
    }
  }

  return {
    messages: [{ role: 'user', content: `[Previous conversation summary]\n${enrichedSummary}` }, ...recent],
    summary: enrichedSummary,
    usage,
    modelId,
  }
}

interface SummaryChunkResult {
  text: string
  usage?: LanguageModelUsage
  modelId?: string
}

/** 摘要旧历史，当摘要调用本身溢出时拆分请求。一个恢复的长会话——
 *  或小上下文的自定义模型——可能在保留 recent 尾部原样不动之后，
 *  仍有超过模型接受上限的旧消息；没有这段逻辑，响应式路径会恰好在
 *  最需要它的那些会话上失败。链式的 update 模式摘要让结果保持为
 *  单个连贯的检查点。 */
async function summarizeWithOverflowSplit(
  messages: ModelMessage[],
  model: LanguageModel,
  previousSummary: string | undefined,
  abortSignal?: AbortSignal,
): Promise<SummaryChunkResult> {
  const isUpdate = !!previousSummary
  const systemPrompt = isUpdate ? UPDATE_SUMMARY_SYSTEM : INITIAL_SUMMARY_SYSTEM
  // 对 update 模式，包装上一个摘要，并把新消息作为要并入的对话发送。
  const userContent = isUpdate
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\nNew messages to incorporate follow in the conversation.`
    : undefined
  const messagesToSummarize: ModelMessage[] = isUpdate
    ? [{ role: 'user' as const, content: userContent! }, ...messages]
    : messages

  try {
    const result = await generateText({
      model,
      abortSignal,
      instructions: systemPrompt,
      messages: messagesToSummarize,
    })
    return { text: result.text, usage: result.usage, modelId: result.response?.modelId }
  } catch (error) {
    if (!isContextTooLongError(error)) throw error
    const split = splitForSummary(messages)
    if (!split) throw error
    const [first, second] = split
    const firstResult = await summarizeWithOverflowSplit(first, model, previousSummary, abortSignal)
    const secondResult = await summarizeWithOverflowSplit(second, model, firstResult.text, abortSignal)
    return {
      text: secondResult.text,
      usage: mergeSummaryUsage(firstResult.usage, secondResult.usage),
      modelId: secondResult.modelId ?? firstResult.modelId,
    }
  }
}

/** 在保持 tool-call ↔ tool-result 配对完整的前提下，于消息边界处拆分：
 *  后半部分绝不能以一个 tool result 开头，而其 tool-call 留在前半部分
 *  （提供商会拒绝孤立的 tool result）。 */
export function splitForSummary(messages: ModelMessage[]): [ModelMessage[], ModelMessage[]] | null {
  if (messages.length < 4) return null
  const mid = Math.floor(messages.length / 2)
  for (let delta = 0; delta < messages.length; delta++) {
    const candidates = delta === 0 ? [mid] : [mid - delta, mid + delta]
    for (const index of candidates) {
      if (index <= 0 || index >= messages.length) continue
      if (messages[index]?.role === 'tool') continue
      return [messages.slice(0, index), messages.slice(index)]
    }
  }
  return null
}

function mergeSummaryUsage(
  first: LanguageModelUsage | undefined,
  second: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!first) return second
  if (!second) return first
  const a = normalizeLanguageModelUsage(first)
  const b = normalizeLanguageModelUsage(second)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.inputTokens + b.inputTokens + a.outputTokens + b.outputTokens,
    inputTokenDetails: {
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    },
  } as LanguageModelUsage
}

export interface TrackedCompressionResult {
  trackedMessages: TrackedModelMessage[]
  summary: string
  usage?: LanguageModelUsage
  modelId?: string
}

export async function compressTrackedMessagesWithUsage(
  entries: readonly TrackedModelMessage[],
  model: LanguageModel,
  previousSummary?: string,
  filesTracked?: { modified: string[]; read: string[] },
  abortSignal?: AbortSignal,
): Promise<TrackedCompressionResult> {
  const messages = entries.map((entry) => entry.message)
  const keepCount = computeKeepCount(messages)
  const recentEntries = entries.slice(-keepCount)
  const oldEntries = entries.slice(0, -keepCount)
  if (oldEntries.length === 0) {
    return { trackedMessages: entries.slice(), summary: previousSummary ?? '' }
  }
  const result = await compressMessagesWithUsage(messages, model, previousSummary, filesTracked, abortSignal)
  const summaryMessage = result.messages[0]!
  return {
    trackedMessages: [createTrackedMessage(summaryMessage, mergeProvenance(oldEntries)), ...recentEntries],
    summary: result.summary,
    usage: result.usage,
    modelId: result.modelId,
  }
}

/** 向后兼容的公共 API。 */
export async function compressMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  previousSummary?: string,
  filesTracked?: { modified: string[]; read: string[] },
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  return (await compressMessagesWithUsage(messages, model, previousSummary, filesTracked, abortSignal)).messages
}

/**
 * 主动压缩：当最后一次真实输入 token 计数或基于字符的估算
 * 越过阈值时触发压缩。
 *
 * 先做一次轻量的 O(n) compaction（丢弃 loop-guard 配对——不调用 LLM，
 * 不联网）。如果这就能回到阈值以下，就完全跳过昂贵的 LLM 摘要路径。
 * 这就是 0 美元 10ms 的通过和一次完整摘要往返之间的差别——对于
 * 由循环导致的膨胀（占绝大多数的情况），轻量路径已经足够。
 */
export async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<void> {
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= MIN_KEEP_MESSAGES) return

  // PreCompact——在任一压缩路径运行之前触发。我们不会等待 hook 的
  // 决策来影响行为（一旦越过阈值，压缩是强制的），所以这是即发即忘。
  const messageCountBefore = state.messages.length
  const tokenEstimateBefore = estimateTokenCount(state.messages)
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'proactive',
    messageCount: messageCountBefore,
    tokenEstimate: tokenEstimateBefore,
  })

  callbacks.onCompressionProgress?.('Removing duplicate tool calls...')
  let candidate = structuredClone(state.trackedMessages)
  const light = lightCompactTrackedMessages(candidate)
  if (light.dropped > 0) {
    candidate = light.trackedMessages
    const stillOver = estimateTokenCount(candidate.map((entry) => entry.message)) > threshold
    callbacks.onContextCompressed(
      `Dropped ${light.dropped} looped tool-call message(s) to reclaim context${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )
    if (!stillOver) {
      await finishLightweightCompression(state, candidate, hookCtx)
      return
    }
  }

  callbacks.onCompressionProgress?.('Truncating old tool results...')
  const trunc = truncateOldTrackedToolResults(candidate)
  if (trunc.truncatedCount > 0) {
    const stillOver = estimateTokenCount(candidate.map((entry) => entry.message)) > threshold
    callbacks.onContextCompressed(
      `Truncated ${trunc.truncatedCount} old tool result(s), saved ~${Math.round(trunc.charsSaved / 3)} tokens${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )
    if (!stillOver) {
      await finishLightweightCompression(state, candidate, hookCtx)
      return
    }
  }

  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const { compressed, tokensBefore, tokensAfter } = await summarizeLoopState(
    state,
    candidate,
    model,
    callbacks,
    hookCtx,
  )
  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`Context compressed: ~${beforeK}k → ~${afterK}k tokens.`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: compressed.summary,
  })
}

/**
 * 响应式 compact：当流因 prompt 过长而报错时，压缩并通知调用方重试。
 * 对应 Claude Code 的 reactiveCompact。若发生了压缩则返回 true
 * （调用方应重试本轮）。
 */
export async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<boolean> {
  if (state.messages.length <= MIN_KEEP_MESSAGES) return false
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })
  callbacks.onCompressionProgress?.('Summarizing conversation...')
  const { compressed, tokensBefore, tokensAfter } = await summarizeLoopState(
    state,
    structuredClone(state.trackedMessages),
    model,
    callbacks,
    hookCtx,
  )

  // 防自旋守护。如果摘要几乎没释放上下文，说明溢出存在于
  // 保留的 recent 消息中——退出，让用户可以 /clear。
  if (tokensAfter > tokensBefore * 0.9) {
    debugLog('compression.reactive-no-progress', `before=${tokensBefore} after=${tokensAfter} — not retrying`)
    return false
  }

  const beforeK = Math.round(tokensBefore / 1000)
  const afterK = Math.round(tokensAfter / 1000)
  callbacks.onContextCompressed(`Context too long — compressed (~${beforeK}k → ~${afterK}k tokens). Retrying...`)
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    summary: compressed.summary,
  })
  return true
}

// ── 辅助函数 ──

const SUMMARY_PREFIX = '[Previous conversation summary]\n'

async function finishLightweightCompression(
  state: LoopState,
  candidate: readonly TrackedModelMessage[],
  hookCtx?: CompactionHookContext,
): Promise<void> {
  await markBoundaryAndReflush(state, undefined, candidate)
  setTrackedTranscript(state, candidate)
  // 压缩后的转录可能不再包含让这些去重条目有效的文件主体。
  // 让 readFile 在需要时重新提供它们。
  state.readFileCache.clear()
  state.lastInputTokens = 0
  markExpectedCacheMiss(state, 'compaction')
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: '',
  })
}

async function summarizeLoopState(
  state: LoopState,
  candidate: readonly TrackedModelMessage[],
  model: LanguageModel,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<{ compressed: TrackedCompressionResult; tokensBefore: number; tokensAfter: number }> {
  const tokensBefore = estimateTokenCount(state.messages)
  const compressed = await compressTrackedMessagesWithUsage(
    candidate,
    model,
    extractPreviousSummary(state.messages),
    buildFilesTracked(state),
    hookCtx?.abortSignal,
  )
  await markBoundaryAndReflush(state, compressed.summary, compressed.trackedMessages)
  setTrackedTranscript(state, compressed.trackedMessages)
  state.readFileCache.clear()
  await recordCompressionUsage(state, compressed, callbacks, hookCtx)
  state.lastInputTokens = 0
  markExpectedCacheMiss(state, 'compaction')
  const tokensAfter = estimateTokenCount(state.messages)
  return { compressed, tokensBefore, tokensAfter }
}

async function recordCompressionUsage(
  state: LoopState,
  result: Pick<CompressionResult, 'usage' | 'modelId'>,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<void> {
  if (!result.usage) return
  const requestedModelId = hookCtx?.modelId ?? 'unknown'
  const modelId = attributedModelId(requestedModelId, result.modelId)
  accumulateUsage(state, {
    source: 'compaction',
    modelId,
    usage: normalizeLanguageModelUsage(result.usage),
  })
  callbacks.onUsageUpdate(state.tokenUsage)
  await appendUsage(state, modelId)
}

/** 若 messages[0] 由更早的 compressMessages 调用产生，则提取先前的
 *  压缩摘要。对尚未压缩过的会话返回 undefined。 */
function extractPreviousSummary(messages: ModelMessage[]): string | undefined {
  if (messages.length === 0) return undefined
  const first = messages[0]
  if (first.role !== 'user' || typeof first.content !== 'string') return undefined
  if (!first.content.startsWith(SUMMARY_PREFIX)) return undefined
  return first.content.slice(SUMMARY_PREFIX.length)
}

/** 从 LoopState 构建 files-modified / files-read 跟踪列表。
 *  代价：几十条短路径字符串——token 开销可忽略。 */
function buildFilesTracked(state: LoopState): { modified: string[]; read: string[] } {
  const modified = [...state.filesModified]
  const read = [...state.readFileCache.keys()].filter((p) => !state.filesModified.has(p))
  return { modified, read }
}

/** 携带会话上下文触发 PreCompact / PostCompact hook。尽力而为——
 *  压缩已经发生（或已确定要发生），所以 hook 失败和中止绝不能冒泡。 */
function emitCompactionHook(
  ctx: CompactionHookContext | undefined,
  partial:
    | { name: 'PreCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; tokenEstimate: number }
    | { name: 'PostCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; summary: string },
): void {
  if (ctx?.authority?.peerTainted || ctx?.authority?.source === 'peer') return
  if (!ctx?.hookBus?.has(partial.name)) return
  void ctx.hookBus
    .emit(
      {
        ...partial,
        session: { cwd: ctx.cwd, modelId: ctx.modelId },
      },
      { signal: ctx.abortSignal },
    )
    .catch((err) => debugLog(`agent.hook-${partial.name.toLowerCase()}-error`, String(err)))
}
