// @x-code-cli/core — 轻量消息压缩（不调用 LLM）
//
// 主压缩路径（compression.ts 里的 `compressMessages`）通过发起一次单独的
// `generateText` 调用来摘要旧轮次——那是一次网络往返加一次对消息的完整遍历。
// 当上下文的大头来自一个狭窄、明显的来源时（loop guard 已经标记出来的反复
// 工具调用失败），这样做就很浪费。
//
// 本模块跑一遍 O(n) 的廉价扫描，丢弃那些丢掉也不损失信号的消息：
//   - 结果为 `[loop-guard]` 提示的 tool-call + tool-result 配对
//     （模型已经被叫停了；这些被拦下的调用重放时教不会它任何新东西）
//   - 比最新一条更旧的 PowerShell 噪声堆栈 tool-result 负载
//     （最多保留最新一条，让模型仍能看到当前的错误形态，丢弃更旧的重复项）
//
// 调用方应在调用 LLM 摘要器【之前】运行它，好让摘要器在信号丰富的
// 剩余部分上工作。
import type { ModelMessage } from 'ai'

import type { TrackedModelMessage } from '../types/index.js'

/** 一见到就该丢弃的 tool-result part 的内容。 */
const LOOP_GUARD_SENTINEL = '[loop-guard]'

type ToolResultPartLike = {
  type?: string
  toolCallId?: string
  output?: { type?: string; value?: unknown }
}

/** 多模态 tool-result 的 `content` 形态：`value` 是 part 数组，文本藏在
 *  `{ type: 'text', text }` 里。 */
function contentPartsStartWithSentinel(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some(
    (part) =>
      part != null &&
      typeof part === 'object' &&
      (part as { type?: string }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string' &&
      (part as { text: string }).text.startsWith(LOOP_GUARD_SENTINEL),
  )
}

function isToolResultDropTarget(part: ToolResultPartLike): boolean {
  if (part?.type !== 'tool-result') return false
  const output = part.output
  if (!output) return false
  // loop-guard 的结果由 `pushToolResult(..., isError = true)` 产生，
  // `toolResultMessage()` 会把 isError 的文本包成 `{ type: 'error-text' }`。
  // 只认 `text` 会让收集端永远收集不到 id，整个丢弃器形同虚设。
  if (output.type === 'text' || output.type === 'error-text') {
    return typeof output.value === 'string' && output.value.startsWith(LOOP_GUARD_SENTINEL)
  }
  if (output.type === 'content') {
    return contentPartsStartWithSentinel(output.value)
  }
  return false
}

/** 一条消息里命中丢弃目标的 toolCallId 列表（`collectLoopGuardedIds` 与
 *  按 part 裁剪共用同一判定，避免两份定义漂移）。 */
function dropTargetIdsOfMessage(msg: ModelMessage): string[] {
  if (msg.role !== 'tool') return []
  const parts = msg.content as unknown as ToolResultPartLike[]
  if (!Array.isArray(parts)) return []
  const ids: string[] = []
  for (const part of parts) {
    if (isToolResultDropTarget(part) && typeof part.toolCallId === 'string') ids.push(part.toolCallId)
  }
  return ids
}

/** 只移除命中 `idsToRemove` 的 tool-result part。
 *  一轮并行工具调用会产生「一条 tool 消息含多个 tool-result part」的结构，
 *  整条丢弃会连带干掉未被 guard 的兄弟结果，留下孤儿 `tool_use`（provider 直接 400）。
 *  无需改动时原样返回，全部 part 都被移除时返回 null。 */
function pruneDropTargetParts(msg: ModelMessage, idsToRemove: Set<string>): ModelMessage | null {
  if (msg.role !== 'tool') return msg
  const parts = msg.content as unknown as ToolResultPartLike[]
  if (!Array.isArray(parts)) return msg

  let changed = false
  const kept = parts.filter((part) => {
    if (!isToolResultDropTarget(part)) return true
    // 没有 toolCallId 的 guard part 不会留下孤儿 `tool_use`，直接一并移除。
    if (typeof part.toolCallId !== 'string' || idsToRemove.has(part.toolCallId)) {
      changed = true
      return false
    }
    return true
  })

  if (!changed) return msg
  if (kept.length === 0) return null
  return { ...msg, content: kept } as ModelMessage
}

/** 从一条 assistant 消息里移除给定 id 集合的 tool-call part。
 *  无需改动时原样返回消息，否则返回过滤后内容的浅拷贝。
 *  若每个 part 都被移除，则返回 null，好让调用方丢弃整条消息。 */
function stripToolCallParts(msg: ModelMessage, idsToRemove: Set<string>): ModelMessage | null {
  if (msg.role !== 'assistant') return msg
  const content = msg.content as unknown as Array<{ type?: string; toolCallId?: string }>
  if (!Array.isArray(content)) return msg

  let changed = false
  const filtered = content.filter((part) => {
    if (part?.type === 'tool-call' && typeof part.toolCallId === 'string' && idsToRemove.has(part.toolCallId)) {
      changed = true
      return false
    }
    return true
  })

  if (!changed) return msg
  if (filtered.length === 0) return null
  return { ...msg, content: filtered } as ModelMessage
}

/** 收集 tool-result 为 loop-guard 提示的 toolCallId。 */
function collectLoopGuardedIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    for (const id of dropTargetIdsOfMessage(msg)) ids.add(id)
  }
  return ids
}

export interface LightCompactResult {
  messages: ModelMessage[]
  /** 被丢弃的消息数。对 UI / 遥测有用 —— 若为零，
   *  调用方可能仍希望回退到 LLM 摘要器。 */
  dropped: number
}

/**
 * 从消息数组中丢弃 loop-guard 的 tool-call/result 配对。其余内容
 * 原样不动。不修改输入数组。
 */
export function lightCompactMessages(messages: ModelMessage[]): LightCompactResult {
  const idsToRemove = collectLoopGuardedIds(messages)
  if (idsToRemove.size === 0) return { messages, dropped: 0 }

  const out: ModelMessage[] = []
  let dropped = 0
  for (const msg of messages) {
    const pruned = pruneDropTargetParts(msg, idsToRemove)
    if (pruned == null) {
      dropped++
      continue
    }
    const stripped = stripToolCallParts(pruned, idsToRemove)
    if (stripped == null) {
      dropped++
      continue
    }
    out.push(stripped)
  }
  return { messages: out, dropped }
}

export interface TrackedLightCompactResult {
  trackedMessages: TrackedModelMessage[]
  dropped: number
}

/** agent 使用的带跟踪变体。被污染的 loop-guard 配对会被保留：
 * 普通压缩不是去污操作，绝不能把最后一条来自 peer 的证据从
 * 活跃转录中移除。 */
export function lightCompactTrackedMessages(entries: readonly TrackedModelMessage[]): TrackedLightCompactResult {
  const messages = entries.map((entry) => entry.message)
  const candidateIds = collectLoopGuardedIds(messages)
  if (candidateIds.size === 0) return { trackedMessages: entries.slice(), dropped: 0 }

  const taintedIds = new Set<string>()
  for (const entry of entries) {
    if (!entry.provenance.derivedFromPeer || !Array.isArray(entry.message.content)) continue
    for (const part of entry.message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (
        (part?.type === 'tool-call' || part?.type === 'tool-result') &&
        typeof part.toolCallId === 'string' &&
        candidateIds.has(part.toolCallId)
      ) {
        taintedIds.add(part.toolCallId)
      }
    }
  }
  const idsToRemove = new Set([...candidateIds].filter((id) => !taintedIds.has(id)))
  if (idsToRemove.size === 0) return { trackedMessages: entries.slice(), dropped: 0 }

  const out: TrackedModelMessage[] = []
  let dropped = 0
  for (const entry of entries) {
    // 按 part 裁剪：tainted（peer 引用）的 guard part 不在 idsToRemove 里，
    // 因此会被保留下来——绝不能把最后一条 peer 证据整条丢出活跃转录。
    const pruned = pruneDropTargetParts(entry.message, idsToRemove)
    if (pruned == null) {
      dropped++
      continue
    }
    const stripped = stripToolCallParts(pruned, idsToRemove)
    if (stripped == null) {
      dropped++
      continue
    }
    out.push(stripped === entry.message ? entry : { ...entry, message: stripped })
  }
  return { trackedMessages: out, dropped }
}

// ── 智能 tool-result 截断 ──
//
// 位于上面的 loop-guard 丢弃器和 compression.ts 里昂贵的 LLM 摘要器之间的
// 中间压缩层。把旧的、巨大的 tool_result 负载替换成保留「做了什么」元数据的
// 短占位 stub，从而回收大部分 token。stub 包含工具名、关键输入参数、
// 输出大小和一小段预览，好让模型决定是否要重新运行该工具。
//
// 设计目的是推迟完整压缩——它会失效整个提示词缓存——通过在不重写消息
// 结构的前提下释放上下文。

/** 结果代表决策、或本身已经紧凑的工具 —— 永不截断。 */
const NEVER_TRUNCATE_TOOLS = new Set([
  'edit',
  'writeFile',
  'task',
  'activateSkill',
  'todoWrite',
  'askUser',
  'enterPlanMode',
  'exitPlanMode',
])

/** 只有文本长度超过此值（字符）的结果才会被截断。 */
const MIN_TRUNCATABLE_CHARS = 500

/** 免于截断保护的最近消息条数。 */
const KEEP_RECENT_MESSAGES = 10

/** 从原始输出中保留作为 stub 预览的最大行数。 */
const PREVIEW_LINES = 3

const RECOVERABLE_SHELL_TOOLS = new Set(['shell', 'shellOutput', 'killShell'])

function buildStub(toolName: string | undefined, value: string): string {
  const lines = value.split('\n')
  const lineCount = lines.length
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const name = toolName ?? 'unknown'
  const fullOutputLine = RECOVERABLE_SHELL_TOOLS.has(name)
    ? lines.find((line) => line.startsWith('Full output: '))
    : undefined
  return (
    `[Truncated: ${name} output — ${lineCount} lines, ${value.length} chars. ` +
    `Content removed to save context. Re-run the tool if you need the full output.]\n` +
    preview +
    (fullOutputLine ? `\n${fullOutputLine}` : '')
  )
}

export interface TruncateOldToolResultsResult {
  messages: ModelMessage[]
  truncatedCount: number
  charsSaved: number
}

/**
 * 把旧的、巨大的 tool_result 文本替换成紧凑 stub。为了效率就地修改
 * messages（它运行在本来就可变的 `state.messages` 上）。返回统计信息，
 * 供调用方决定是否继续进入完整压缩。
 */
export function truncateOldToolResults(messages: ModelMessage[]): TruncateOldToolResultsResult {
  const protectedStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)
  let truncatedCount = 0
  let charsSaved = 0

  for (let i = 0; i < protectedStart; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultPartLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      const toolName = (part as { toolName?: string }).toolName
      if (toolName && NEVER_TRUNCATE_TOOLS.has(toolName)) continue

      if (output.type === 'text' && typeof output.value === 'string') {
        if (output.value.length < MIN_TRUNCATABLE_CHARS) continue
        if (output.value.startsWith('[Truncated:')) continue
        const original = output.value
        output.value = buildStub(toolName, original)
        charsSaved += original.length - (output.value as string).length
        truncatedCount++
      }
    }
  }

  return { messages, truncatedCount, charsSaved }
}

export function truncateOldTrackedToolResults(entries: readonly TrackedModelMessage[]): TruncateOldToolResultsResult {
  const messages = entries.map((entry) => entry.message)
  return truncateOldToolResults(messages)
}
