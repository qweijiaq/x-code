// @x-code-cli/core — 上下文窗口查询与估算
import type { ModelMessage } from 'ai'

import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
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

/** 模型级和提供商级查找都未命中时的默认上下文窗口。 */
const DEFAULT_CONTEXT_WINDOW = 128000

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

/** 每个模型的上下文窗口大小（token）。 */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Anthropic
  ['anthropic:claude-fable-5-1', 1000000],
  ['anthropic:claude-opus-5', 1000000],
  ['anthropic:claude-fable-5', 1000000],
  ['anthropic:claude-opus-4-8', 1000000],
  ['anthropic:claude-sonnet-5', 1000000],
  ['anthropic:claude-haiku-4-5', 200000],
  // OpenAI
  ['openai:gpt-6-astra', 1050000],
  ['openai:gpt-5.6-sol', 1047576],
  ['openai:gpt-5.6-terra', 1047576],
  ['openai:gpt-5.6-luna', 1047576],
  ['openai:gpt-5.4-mini', 1047576],
  ['openai:gpt-5.4-nano', 1047576],
  // Google
  ['google:gemini-3.8-flash', 1048576],
  ['google:gemini-3.7-flash', 1048576],
  ['google:gemini-3.6-flash', 1048576],
  ['google:gemini-3.5-flash', 1000000],
  ['google:gemini-2.5-pro', 1000000],
  ['google:gemini-2.5-flash', 1000000],
  // DeepSeek
  ['deepseek:deepseek-flash', 1000000],
  ['deepseek:deepseek-v4-flash', 1000000],
  ['deepseek:deepseek-v4-pro', 1000000],
  // Alibaba —— 当前的 Qwen3.8 系列、qwen3.7-max/plus 以及 qwen3-coder-plus 可扩展到 1M；
  // qwen-max 仍封顶在 32k。数值经
  // https://help.aliyun.com/zh/model-studio/models 核实。
  ['alibaba:qwen3.8-max', 1000000],
  ['alibaba:qwen3.8-flash', 1000000],
  ['alibaba:qwen3.7-max', 1000000],
  ['alibaba:qwen3.7-plus', 1000000],
  ['alibaba:qwen3.7-flash', 1000000],
  ['alibaba:qwen3-coder-plus', 1000000],
  ['alibaba:qwq-plus', 131072],
  ['alibaba:qwen-max', 32768],
  // xAI —— Grok 4.6/4.5 有 500k 窗口；Grok 4.20/4.3 有 1M。
  ['xai:grok-4.6', 500000],
  ['xai:grok-4.20', 1000000],
  ['xai:grok-4.20-non-reasoning', 1000000],
  ['xai:grok-4.5', 500000],
  ['xai:grok-4.3', 1000000],
  // Zhipu
  ['zhipu:glm-5.3', 1000000],
  ['zhipu:glm-5.3-flash', 1000000],
  ['zhipu:glm-5.2', 1000000],
  ['zhipu:glm-5', 200000],
  ['zhipu:glm-4.7', 128000],
  // Moonshot
  ['moonshotai:kimi-k3', 1000000],
  ['moonshotai:kimi-k2.7-code', 262144],
  ['moonshotai:kimi-k2.7-code-highspeed', 262144],
  ['moonshotai:kimi-k2.6', 262144],
])

/** 提供商级回退上下文窗口。 */
const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 1000000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 1000000],
  ['alibaba', 128000],
  ['xai', 128000],
  ['zhipu', 128000],
  ['moonshotai', 128000],
])

/** 解析 `provider:model` 这类模型 id 的原始/已配置上下文上限。
 *  安全余量由 getCompressionThreshold() 恰好应用一次。 */
export function getContextWindow(modelId: string): number {
  const perModel = modelContextWindowOverrides[modelId]
  if (perModel !== undefined) return perModel
  if (contextWindowOverride !== undefined) return contextWindowOverride
  const runtimeModel = getOpenAIChatGPTRuntimeModel(modelId)
  if (runtimeModel) return runtimeModel.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (getOpenAIAuthContext().mode === 'chatgpt' && modelId.startsWith('openai:')) return DEFAULT_CONTEXT_WINDOW
  const exact = MODEL_CONTEXT_WINDOWS.get(modelId)
  if (exact !== undefined) return exact
  const provider = modelId.split(':')[0]
  return PROVIDER_CONTEXT_WINDOWS.get(provider) ?? DEFAULT_CONTEXT_WINDOW
}

/** 触发给定模型压缩的 token 阈值。 */
export function getCompressionThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}

/**
 * 每个模型的 max_tokens（回复大小）上限。有些提供商拒绝超过其上限的
 * 请求，而不是静默裁剪。
 * 对没有显式条目的模型，回退到一个较高的默认值，
 * AI SDK 会对已知提供商做裁剪。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384
const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, number> = new Map([
  // 具有提供商文档记载的扩展输出上限的当前旗舰型号。
  ['anthropic:claude-fable-5-1', 128000],
  ['anthropic:claude-opus-5', 128000],
  ['anthropic:claude-fable-5', 128000],
  ['anthropic:claude-opus-4-8', 128000],
  ['anthropic:claude-sonnet-5', 128000],
  ['anthropic:claude-haiku-4-5', 64000],
  ['openai:gpt-6-astra', 128000],
  ['google:gemini-3.8-flash', 65536],
  ['google:gemini-3.7-flash', 65536],
  ['google:gemini-3.6-flash', 65536],
  // DeepSeek V4/V4.1：flash 和 pro 宣称最高 384K 输出 token。
  // 我们封顶在慷慨但保守的 131072，以避免边界情况的 400。
  ['deepseek:deepseek-flash', 131072],
  ['deepseek:deepseek-v4-flash', 131072],
  ['deepseek:deepseek-v4-pro', 131072],
  // Alibaba —— Qwen3.8 和多模态 Qwen3.7 Plus 支持 64k 输出。
  ['alibaba:qwen3.8-max', 65536],
  ['alibaba:qwen3.8-flash', 65536],
  ['alibaba:qwen3.7-plus', 65536],
  ['alibaba:qwen3.7-flash', 65536],
  // 较旧的 Qwen3.7 模型支持 32768（非思考）/ 81920（思考）。
  // 我们封顶在非思考上限，好让请求总能成功。
  ['alibaba:qwen-max', 8192],
  ['alibaba:qwen3.7-max', 32000],
  ['alibaba:qwen3-coder-plus', 32000],
  ['alibaba:qwq-plus', 32000],
])

/** 解析我们发给提供商的 max_tokens 上限。 */
export function getMaxOutputTokens(modelId: string): number {
  const runtimeModel = getOpenAIChatGPTRuntimeModel(modelId)
  if (runtimeModel) return runtimeModel.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (getOpenAIAuthContext().mode === 'chatgpt' && modelId.startsWith('openai:')) return DEFAULT_MAX_OUTPUT_TOKENS
  return MODEL_MAX_OUTPUT_TOKENS.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS
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
