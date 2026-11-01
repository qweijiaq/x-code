// @x-code-cli/core — 上下文窗口查询与估算
import type { ModelMessage } from 'ai'

import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MODEL_LIMITS,
  PROVIDER_CONTEXT_WINDOWS,
} from '../providers/model-limits.js'
import { getOpenAIChatGPTRuntimeModel } from '../providers/openai-chatgpt-models.js'

/**
 * 当用量超过模型上下文窗口的这一比例时压缩上下文。两处检查用到它：
 *   1. 每轮之后——基于 API 报告的「真实」输入 token 数，
 *      这是最可靠的信号。
 *   2. 每次 API 调用之前——基于「字符估算」作为安全网。估算会漂移
 *      （工具输出、非 ASCII），所以我们使用保守的乘数。估算能兜住
 *      单轮（例如读取超大文件）在真实计数可用之前就把上下文推过上限
 *      的情形。
 */
export const COMPRESSION_TRIGGER_RATIO = 0.8

/**
 * 调用前估算所用的粗略「UTF-8 字节/token」比例。大多数英文文本约
 * 4 字节/token，而 CJK 字符占三个 UTF-8 字节、且通常接近一个 token
 * 一个字符。用字节而非 JavaScript 字符串长度，能让估算在英文和
 * CJK 下都保持保守。
 */
const BYTES_PER_TOKEN_ESTIMATE = 3.0

/** 仍与压缩器 20k recent-message 预算兼容的最小覆盖值。 */
export const MIN_CONTEXT_WINDOW_OVERRIDE = 32768

let contextWindowOverride: number | undefined
let modelContextWindowOverrides: Record<string, number> = {}

/** 返回统一应用于所有模型的用户自定义上下文窗口。 */
export function getContextWindowOverride(): number | undefined {
  return contextWindowOverride
}

/** 替换或清除进程级用户上下文窗口覆盖。无效的手工编辑配置值
 *  会被视为未设置。 */
export function setContextWindowOverride(value: unknown): number | undefined {
  contextWindowOverride =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW_OVERRIDE ? value : undefined
  return contextWindowOverride
}

/** 来自桌面设置的单模型覆盖。键为完整模型 id。 */
export function setModelContextWindowOverrides(value: unknown): void {
  const next: Record<string, number> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [modelId, tokens] of Object.entries(value as Record<string, unknown>)) {
      if (!modelId.trim()) continue
      if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= MIN_CONTEXT_WINDOW_OVERRIDE) {
        next[modelId] = tokens
      }
    }
  }
  modelContextWindowOverrides = next
}

export function getModelContextWindowOverride(modelId: string): number | undefined {
  return modelContextWindowOverrides[modelId]
}

// 模型级窗口与输出上限集中在 `providers/model-limits.ts`：新增模型只改一处，
// 这里保留解析顺序（用户覆盖 → ChatGPT 运行时模型 → 模型表 → provider 回退）。

/** 解析 `provider:model` 这类模型 id 的原始/已配置上下文上限。
 *  安全余量由 getCompressionThreshold() 恰好应用一次。 */
export function getContextWindow(modelId: string): number {
  const perModel = modelContextWindowOverrides[modelId]
  if (perModel !== undefined) return perModel
  if (contextWindowOverride !== undefined) return contextWindowOverride
  const runtimeModel = getOpenAIChatGPTRuntimeModel(modelId)
  if (runtimeModel) return runtimeModel.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (getOpenAIAuthContext().mode === 'chatgpt' && modelId.startsWith('openai:')) return DEFAULT_CONTEXT_WINDOW
  const exact = MODEL_LIMITS.get(modelId)?.contextWindow
  if (exact !== undefined) return exact
  const provider = modelId.split(':')[0]
  return PROVIDER_CONTEXT_WINDOWS.get(provider) ?? DEFAULT_CONTEXT_WINDOW
}

/** 触发给定模型压缩的 token 阈值。 */
export function getCompressionThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}

/** 解析我们发给提供商的 max_tokens 上限。
 *  模型专属上限同样来自 `providers/model-limits.ts`；没有条目时使用默认值，
 *  AI SDK 会再按已知 provider 裁剪。 */
export function getMaxOutputTokens(modelId: string): number {
  const runtimeModel = getOpenAIChatGPTRuntimeModel(modelId)
  if (runtimeModel) return runtimeModel.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (getOpenAIAuthContext().mode === 'chatgpt' && modelId.startsWith('openai:')) return DEFAULT_MAX_OUTPUT_TOKENS
  return MODEL_LIMITS.get(modelId)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
}

type ContentPartLike = {
  type?: string
  text?: string
  input?: unknown
  output?: unknown
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** 估算单个文本块的 token 贡献（UTF-8 字节 / 每 token 比例）。
 *  由消息估算、调用前压缩检查以及上下文构成拆解共同使用。 */
export function estimateTextTokenCount(text: string): number {
  return Math.ceil(textBytes(text) / BYTES_PER_TOKEN_ESTIMATE)
}

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : textBytes(serialized)
  } catch {
    return textBytes(String(value))
  }
}

/** 估算 AI SDK 工具结果输出携带的文本字节。故意跳过二进制媒体负载：
 *  它们提供商侧的 token 成本与 base64 长度不成正比，而任何相邻的
 *  文本仍然可计数。 */
function toolOutputBytes(output: unknown): number {
  if (typeof output === 'string') return textBytes(output)
  if (!output || typeof output !== 'object') return 0

  const typed = output as { type?: string; value?: unknown }
  if (typed.type === 'content' && Array.isArray(typed.value)) {
    let bytes = 0
    for (const entry of typed.value as Array<{ type?: string; text?: string }>) {
      if (typeof entry?.text === 'string') {
        bytes += textBytes(entry.text)
      } else if (
        entry?.type !== 'media' &&
        entry?.type !== 'image' &&
        entry?.type !== 'image-data' &&
        entry?.type !== 'file'
      ) {
        bytes += jsonBytes(entry)
      }
    }
    return bytes
  }

  if (typeof typed.value === 'string') return textBytes(typed.value)
  if (typed.value !== undefined) return jsonBytes(typed.value)
  return jsonBytes(output)
}

function messageTextBytes(message: ModelMessage): number {
  if (typeof message.content === 'string') return textBytes(message.content)
  if (!Array.isArray(message.content)) return 0

  let bytes = 0
  for (const part of message.content as ContentPartLike[]) {
    if (typeof part?.text === 'string') bytes += textBytes(part.text)
    if (part?.type === 'tool-call' && part.input !== undefined) bytes += jsonBytes(part.input)
    if (part?.type === 'tool-result') bytes += toolOutputBytes(part.output)
  }
  return bytes
}

/** 估算单条消息的 token 贡献。由总量上下文估算器和 recent-tail 选择器
 *  共用，这样工具调用/结果和 CJK 文本就不能让两个压缩决策相矛盾。 */
export function estimateMessageTokenCount(message: ModelMessage): number {
  return Math.ceil(messageTextBytes(message) / BYTES_PER_TOKEN_ESTIMATE)
}

/** 从消息文本和结构化工具负载估算总 token 数。 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  let bytes = 0
  for (const message of messages) bytes += messageTextBytes(message)
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE)
}
