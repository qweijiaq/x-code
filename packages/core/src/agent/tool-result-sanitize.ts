// @x-code-cli/core — 截断 ModelMessage 数组内的工具结果片段
//
// AI SDK 自动执行的工具（readFile / grep / glob / listDir / webFetch /
// webSearch）在 `response.messages` 中以 tool-result 片段返回其结果。手动工具
// 路径（`tool-execution.ts`）会让每个输出经过 `truncateToolResult`，但自动执行的
// 结果绕过该路径，以完整大小落入 `state.messages`。本模块遍历一条已完成流产生的
// 消息，在它们持久化进会话状态之前就地应用相同的逐工具截断策略。
//
// 策略按工具区分：
//   - shell / edit / writeFile：手动路径已经截断
//   - readFile：头尾截断（保留文件开头 + 文件结尾）
//   - grep / glob / listDir：仅头部（字典序有意义；一旦头部具有代表性，尾部不再
//     携带额外信号）
//   - webFetch：头尾截断（页面顶部和底部常有导航冗余，而有意义的内容通常在中部。
//     头尾仍优于仅头部，因为它保留了末尾的锚点）
//   - default：头尾截断
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'
import type { TrackedModelMessage } from '../types/index.js'
import { createTrackedMessage, mergeProvenance } from './provenance.js'

const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },
}

function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

/** 收窄类型——AI SDK 的 tool-result 片段在线上大致长这样。我们只修改已知的子集，
 *  其余一概不动。 */
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

/**
 * 遍历 `messages`，双向调和 tool_call ↔ tool_result 配对。提供方严格要求：
 *   - 每条 assistant tool_call 都要有一条配对的 tool_result
 *   - 每条 tool_result 前面都要有一条 toolCallId 匹配的 assistant tool_call
 * 任何一种孤儿都会以 "tool must be a response to a preceding message with
 * tool_calls"（或相反的）错误毒化下一次 API 请求。
 *
 * 孤儿是怎么产生的：
 *   - 正向（有 tool_call 无结果）：模型偶尔会发出格式错误的工具输入（例如
 *     todoWrite 缺少必需字段）。SDK 校验、失败、发出 tool-error 事件，某些情况下
 *     不会往 response.messages 推入配对的 tool-result。我们合成一条错误结果。
 *   - 反向（有 tool_result 无前置 tool_call）：当 SDK 因模型工具输入校验失败而在
 *     流中途发出 `tool-error` 时，SDK 可能把该 tool_call 从 response.messages
 *     排除——但我们的 `processToolCalls` 仍会耗尽 `result.toolCalls` promise 并
 *     运行工具，往 state.messages 推入一条 tool_result。我们丢弃那条孤儿。
 *
 * 就地修改 `messages`。幂等（运行两次是 no-op）。
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // ── 预过滤：修复被夹在中间的用户消息 ──
  // 一条夹在 assistant 的 tool_calls 与对应 tool_results 之间的用户消息，会导致
  // AI_MissingToolResultsError（SDK 校验严格的 assistant→tool 顺序）。当 abort()
  // 在 processToolCalls 仍在追加结果时把一条提示推进 state.messages，就会出现
  // 这种情况。把这类用户消息移到工具结果块之后，恢复合法顺序。
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const hasToolCall = (msg.content as Array<{ type?: string }>).some((p) => p?.type === 'tool-call')
    if (!hasToolCall) continue
    // 向前扫描：预期是 tool 消息，但容忍夹在中间的用户消息（abort 竞态的产物）。
    // 收集属于这条 assistant 的 tool-call 批次的 tool + user 消息范围。
    let j = i + 1
    const displaced: number[] = [] // 需要搬迁的用户消息索引
    while (j < messages.length) {
      const r = messages[j]?.role
      if (r === 'tool') {
        j++
        continue
      }
      if (r === 'user') {
        displaced.push(j)
        j++
        continue
      }
      break // 下一条是 assistant 或未知角色——停止扫描
    }
    if (displaced.length === 0) continue
    // 搬迁：把被挤出去的用户消息 splice 出来，再在工具结果块之后重新插入
    //（移除之后，索引 `j` 发生了偏移）。
    const extracted = displaced.map((idx) => messages[idx]!)
    // 按逆序移除，这样靠前的索引始终有效。
    for (let k = displaced.length - 1; k >= 0; k--) {
      messages.splice(displaced[k]!, 1)
    }
    // 在最后一条 tool 消息之后插入（它因为前面的移除而左移了相应数量）。
    const insertAt = j - displaced.length
    messages.splice(insertAt, 0, ...extracted)
    // 让外层循环越过已修复的块。
    i = insertAt + extracted.length - 1
  }

  // 收集出现在 assistant 消息里的每个 tool_call_id。
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // 丢弃 toolCallId 从未出现在 assistant tool_call 里的 tool-result 片段
  //（反向孤儿）。当某条 tool 消息的所有片段都是孤儿时，丢弃整条消息；只有部分
  // 是孤儿时，就地在片段上过滤。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // 把整条 tool 消息 splice 掉，可能留下 assistant→assistant 相邻
      //（常见形状是 assistant tool_calls → tool results → assistant 续写）。
      // Anthropic 严格要求 user/assistant 交替，虽然 @ai-sdk/anthropic 转换器
      // 目前会为我们合并连续的同角色消息，但我们不想让 sanitizer 的正确性依赖
      // 下游 SDK 的行为。当两侧邻居都是 assistant 时，改用一条 user 文本占位符
      // 替换，让边界得以保留。否则（一侧或两侧邻居是 user/tool/不存在），直接
      // 丢弃是安全的。
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // AI SDK 的窄并集类型在类型层面禁止我们操作的部分片段形状——我们在上方
      // 已做运行时收窄，所以这里做结构化断言是安全的。
      ;(msg as { content: unknown }).content = kept
    }
  }

  // 收集每个已被 tool-result 覆盖的 tool_call_id（在上方的反向孤儿过滤之后）。
  const fulfilled = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // 为正向孤儿追加合成结果，保持整体顺序（正向孤儿总是放在末尾——它们从未有过
  // 真实结果，所以其位置纯粹是给下一次 API 请求的占位）。把所有孤儿片段收集进
  // 一条 tool 消息，而不是每个 id 推一条：AI SDK 的 Anthropic 转换器今天恰好会
  // 合并连续的同角色消息，但 Google 转换器不会，而 OpenAI 兼容层本来就按
  // tool_call_id 拆分——发单条 tool ModelMessage 对拆分方是线上等价的，对不合并
  // 的提供方则严格更安全。
  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // 纵深防御：如果其他代码路径已经留下一条拖尾的 tool 消息（例如
    // processToolCalls 推入了我们在上方没有触碰的真实结果），把孤儿片段并入它，
    // 而不是再发一条相邻的 tool ModelMessage。
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

/** 保留来源（provenance）的孤儿修复。结构性移动与移除作用于整条带追踪的条目；
 *  被重写的内容保留原始 entryId 与来源，合成结果继承匹配的 assistant 调用。 */
export function repairOrphanTrackedToolCalls(entries: TrackedModelMessage[]): boolean {
  let changed = false
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i]?.message
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const hasToolCall = (message.content as Array<{ type?: string }>).some((part) => part?.type === 'tool-call')
    if (!hasToolCall) continue
    let cursor = i + 1
    const displaced: number[] = []
    while (cursor < entries.length) {
      const role = entries[cursor]?.message.role
      if (role === 'tool') {
        cursor++
        continue
      }
      if (role === 'user') {
        displaced.push(cursor)
        cursor++
        continue
      }
      break
    }
    if (displaced.length === 0) continue
    const extracted = displaced.map((index) => entries[index]!)
    for (let index = displaced.length - 1; index >= 0; index--) entries.splice(displaced[index]!, 1)
    const insertAt = cursor - displaced.length
    entries.splice(insertAt, 0, ...extracted)
    changed = true
    i = insertAt + extracted.length - 1
  }

  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  const sourceById = new Map<string, TrackedModelMessage>()
  for (const entry of entries) {
    const message = entry.message
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
      expected.add(part.toolCallId)
      sourceById.set(part.toolCallId, entry)
      if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const message = entry.message
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    const parts = message.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter(
      (part) => part?.type !== 'tool-result' || typeof part.toolCallId !== 'string' || expected.has(part.toolCallId),
    )
    if (kept.length === 0) {
      const previous = entries[i - 1]?.message
      const next = entries[i + 1]?.message
      if (entry.provenance.derivedFromPeer || (previous?.role === 'assistant' && next?.role === 'assistant')) {
        entries[i] = {
          ...entry,
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Stale tool result discarded — no matching tool_call in history.]' }],
          } as ModelMessage,
        }
      } else {
        entries.splice(i, 1)
      }
      changed = true
    } else if (kept.length !== parts.length) {
      entries[i] = { ...entry, message: { ...message, content: kept } as ModelMessage }
      changed = true
    }
  }

  const fulfilled = new Set<string>()
  for (const entry of entries) {
    const message = entry.message
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') fulfilled.add(part.toolCallId)
    }
  }

  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  const provenanceSources: TrackedModelMessage[] = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const source = sourceById.get(id)
    if (source) provenanceSources.push(source)
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: toolNameById.get(id) ?? 'unknown',
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length === 0) return changed
  const tail = entries[entries.length - 1]
  if (tail?.message.role === 'tool' && Array.isArray(tail.message.content)) {
    entries[entries.length - 1] = {
      ...tail,
      message: {
        ...tail.message,
        content: [...(tail.message.content as unknown[]), ...(orphanParts as unknown[])],
      } as ModelMessage,
    }
  } else {
    entries.push(
      createTrackedMessage(
        { role: 'tool', content: orphanParts as never } as ModelMessage,
        mergeProvenance(provenanceSources),
      ),
    )
  }
  return true
}

/**
 * 就地遍历 `messages` 并截断任何过大的 tool-result 片段。只修改 `output.value`
 * 字段；消息结构的其余部分严格保持提供方返回的原样。
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // 文本输出：`{ type: 'text', value: string }`
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // 内容输出：`{ type: 'content', value: Array<{ type: string, text?: string, ... }> }`
      // 只有 text 条目可修改——image-data / file-data / file-url 是二进制负载，
      // 由 provider-compat 层在别处处理。
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}
