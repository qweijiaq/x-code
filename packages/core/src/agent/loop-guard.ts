// @x-code-cli/core — Doom-loop circuit breaker
//
// 死循环熔断器（doom-loop circuit breaker）。
//
// 它要解决的问题：模型反复用【完全相同的参数】调用同一个工具。常见成因是上一次
// 调用失败了，而模型下一轮最省事的做法就是把同一行原样再试一次。Windows 上最典型
// 的是因为引号转义失败而报错的 shell 命令 —— 模型不去改参数，而是把同一条命令重试
// 5 到 10 次，每次失败都往上下文里塞一段堆栈，白白撑大 token。
//
// 两个阶段：
//   阶段一（软拦截，默认阈值 3）：注入一条合成的 tool-result，告诉模型“这个调用
//     已经失败 3 次了，停下来换思路”。下一轮模型看到这条合成结果，通常就会转向。
//   阶段二（硬拦截，默认阈值 5）：中止本回合并提示用户 —— 软提示之后还出现 5 次
//     完全相同的调用，说明软提示没起作用，不应该再往上下文里堆内容了。
//
// 检测方式：对 `{toolName, stableInputJson}` 做 SHA256。稳定序列化会先排序对象键，
// 所以 `{a:1,b:2}` 和 `{b:2,a:1}` 会得到相同的哈希。
//
// 调参说明：这里没有采用 opencode 那种“恰好连续 3 次相同”的判定条件 —— 它漏掉了
// 这种情形：模型先试 `foo`，中间读了一个文件，然后又试 `foo`。我们的做法是：回看
// 同一个 toolName 最近 N 次工具调用，统计其中有 K 次共享同一个哈希。
import crypto from 'node:crypto'

import type { LoopState } from './loop-state.js'

/** 滚动窗口内达到或超过该次数的工具调用会触发软拦截（合成提示）。 */
export const SOFT_LOOP_THRESHOLD = 3

/** 达到或超过该次数会中止本回合并提示用户。 */
export const HARD_LOOP_THRESHOLD = 5

/** 用于查找重复调用的滚动窗口大小。 */
const LOOP_WINDOW_SIZE = 8

/** 稳定 JSON 序列化：确定性地排序对象键，让语义相同、但键顺序不同的输入
 *  得到同一个哈希值。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

/** 计算一次工具调用的哈希，用于重复检测。截断到 16 个十六进制字符 —— 在这个长度
 *  下、针对 8 条记录的窗口做比较，碰撞概率可以忽略不计。 */
export function hashToolCall(toolName: string, input: unknown): string {
  // 用 \x00 分隔工具名和参数，避免 `toolName` 与序列化结果拼接时产生歧义。
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** 共同的头部字段，携带预先算好的调用哈希。它会随结果透传，好让
 *  {@link recordToolCall} 直接复用，不必对同一份输入再算一次哈希。 */
interface LoopCheckBase {
  hash: string
}

export type LoopCheck =
  /** 未检测到循环 —— 正常派发这次工具调用。 */
  | (LoopCheckBase & { kind: 'ok' })
  /** 在软阈值处检测到循环 —— 注入一条合成的 tool-result 让模型停下，并且本轮
   *  【跳过】真正执行该工具。`toolCallId` 是当前这次调用的 id，这样合成结果读起来
   *  就是针对该调用的回复。 */
  | (LoopCheckBase & { kind: 'soft-block'; toolCallId: string; message: string })
  /** 在硬阈值处检测到循环 —— 中止本回合并提示用户。 */
  | (LoopCheckBase & { kind: 'hard-block'; toolName: string; message: string })

/**
 * 判断即将执行的这次工具调用是否与窗口内最近的调用重复，并告诉调用方该怎么做。
 * 本函数【不修改】状态 —— 只有在这次调用真正继续执行后，调用方才通过
 * {@link recordToolCall} 提交哈希。返回的 `hash` 应当传给 `recordToolCall`，
 * 以避免对同一份输入重复计算 SHA256。
 *
 * 只有哈希相同【且】toolName 相同的记录才算匹配；另一个工具下看起来参数一样的
 * 新命令，永远不会触发这个守卫。
 */
export function checkForLoop(state: LoopState, toolName: string, input: unknown, toolCallId: string): LoopCheck {
  const hash = hashToolCall(toolName, input)
  const window = state.recentToolCalls.slice(-LOOP_WINDOW_SIZE)

  let priorMatches = 0
  for (const entry of window) {
    if (entry.toolName === toolName && entry.hash === hash) priorMatches++
  }

  // 是当前这次（尚未记录进窗口的）调用让我们越过阈值，所以要拿“历史匹配数 + 1”
  // 去比较，而不是只比较历史匹配数。

  if (priorMatches + 1 >= HARD_LOOP_THRESHOLD) {
    return {
      kind: 'hard-block',
      hash,
      toolName,
      message: `Tool ${toolName} has been called with identical arguments ${priorMatches + 1} times in a row. The model is looping; aborting this turn.`,
    }
  }

  if (priorMatches + 1 >= SOFT_LOOP_THRESHOLD) {
    return {
      kind: 'soft-block',
      hash,
      toolCallId,
      message:
        `This exact ${toolName} call (same arguments) has already been attempted ${priorMatches + 1} times this session with the same result. ` +
        'DO NOT retry it. Change your approach — alter the arguments meaningfully, try a different tool, or ask the user what to do instead.',
    }
  }

  return { kind: 'ok', hash }
}

/** 把一次工具调用提交进滚动窗口。大小有上限，避免长会话里数组无限增长。
 *  传入 {@link checkForLoop} 返回的 `hash` 即可省掉一次重复计算；只有在检查路径
 *  之外调用时才省略它。 */
export function recordToolCall(state: LoopState, toolName: string, input: unknown, hash?: string): void {
  const h = hash ?? hashToolCall(toolName, input)
  state.recentToolCalls.push({ toolName, hash: h })
  // 保留 2 倍窗口大小，让 checkForLoop 拥有超出当前比较窗口的历史（这样在调整
  // LOOP_WINDOW_SIZE 时不需要改动持久化占用的结构）。
  const cap = LOOP_WINDOW_SIZE * 2
  if (state.recentToolCalls.length > cap) {
    state.recentToolCalls.splice(0, state.recentToolCalls.length - cap)
  }
}
