// @x-code-cli/core — 从上下文中丢弃过期、被完全取代的工具结果
//
// 有些工具返回的大负载会被下一次调用完全取代：浏览器可访问性快照是整棵页面树，
// 截图是整张图片。只有最新一份有用——旧的只是躺在会话里、每轮都被重复计费。
// 对跨多轮反复快照与截图的浏览器子 agent 来说，这种累积主导了 token 账单
// （仅树型任务，光累积快照就可能烧掉数万 token）。
//
// 本模块在构建请求之前，把被取代或已被消费的结果就地坍缩为短文本占位符。
// 借鉴 gemini-cli 的 `supersedeSnapshots`（onBeforeTurn）思路。浏览器子 agent
// 保留最新的整页状态；根级的一次性检查，一旦后续 assistant 消息证明图片已被查看，
// 就立即丢弃。
import type { ModelMessage } from 'ai'

type ToolResultPartLike = {
  type?: string
  toolName?: string
  output?: { type?: string; value?: unknown }
}

function collapsePart(part: ToolResultPartLike, suffix: string, reason: string): boolean {
  const placeholder = `[${reason} ${suffix} result dropped to save context.]`
  const out = part.output
  if (out?.type === 'text' && out.value === placeholder) return false
  part.output = { type: 'text', value: placeholder }
  return true
}

/** 对每个名称以 `toolSuffixes` 之一结尾的工具，替换除最新一条之外所有工具结果的输出。
 *  用后缀匹配（而非相等），这样诸如 'browser_snapshot' 的原始 MCP 名称仍能命中
 *  被服务器改写的可调用名 'browser__browser_snapshot'。幂等：已坍缩的结果保持不变，
 *  使缓存前缀跨轮次稳定。就地修改。 */
export function collapseStaleToolResults(messages: ModelMessage[], toolSuffixes: readonly string[]): boolean {
  if (toolSuffixes.length === 0) return false
  let changed = false

  // 每个后缀承载结果的那条消息索引——那一条得以保留。
  const lastIdx = new Map<string, number>()
  messages.forEach((msg, i) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return
    for (const part of msg.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      for (const suf of toolSuffixes) if (name.endsWith(suf)) lastIdx.set(suf, i)
    }
  })

  messages.forEach((msg, i) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return
    for (const part of msg.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      const suf = toolSuffixes.find((s) => name.endsWith(s))
      if (!suf) continue
      if (lastIdx.get(suf) === i) continue // 保留最新一条结果不动

      changed = collapsePart(part, suf, 'Older') || changed
    }
  })
  return changed
}

/** 坍缩那些已被后续 assistant 消息消费掉的匹配工具结果。一条正等待模型处理的结果，
 *  后面没有更晚的 assistant 消息，会为恰好需要看到它的那次请求保持完整。 */
export function collapseConsumedToolResults(messages: ModelMessage[], toolSuffixes: readonly string[]): boolean {
  if (toolSuffixes.length === 0) return false

  let latestAssistantIndex = -1
  messages.forEach((message, index) => {
    if (message.role === 'assistant') latestAssistantIndex = index
  })
  if (latestAssistantIndex < 0) return false
  let changed = false

  messages.forEach((message, index) => {
    if (index >= latestAssistantIndex || message.role !== 'tool' || !Array.isArray(message.content)) return
    for (const part of message.content as ToolResultPartLike[]) {
      if (part.type !== 'tool-result') continue
      const name = part.toolName ?? ''
      const suffix = toolSuffixes.find((candidate) => name.endsWith(candidate))
      if (suffix) changed = collapsePart(part, suffix, 'Consumed') || changed
    }
  })
  return changed
}
