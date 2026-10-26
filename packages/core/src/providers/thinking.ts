// @x-code-cli/core — 各 provider 的扩展思考 / 推理开关
//
// AI SDK v7 提供顶层的 `reasoning` 参数，可在大多数 provider 上可移植地工作
// （OpenAI、Anthropic、Google、xAI、DeepSeek、Moonshot）。我们把它作为推理
// 控制的主要机制。
//
// 仍需 providerOptions / fetch 垫片注入的例外：
//   - deepseek：显式层级使用原生 reasoningEffort，这样 `max` 不会绕经可移植的
//     `xhigh` 并产生兼容性警告。
//   - zhipu：走 @ai-sdk/openai-compatible，SDK 不会为它自动翻译 `reasoning`。
//     我们通过 fetch 垫片注入 `reasoning_effort`。
//   - alibaba：在 providerOptions 中使用 `enableThinking`（无顶层支持）。
//   - 较新 Anthropic/OpenAI 模型的原生 `max` 控件也通过 providerOptions 传递，
//     因为可移植的 reasoning 枚举最高只到 xhigh。
//
// 面向用户的控件：
//   /thinking on|off — 二元开关（映射为 'high' / 'none'）
//   /model 层级选择器 — 显式 effort 等级（low/high/max 等）
//
// 当 `effort` 被设置（用户通过 /model 选择了层级）时，它优先于 `enabled`
// 标志。/thinking 开关只作为没有显式层级模型的回退。
import { providerOf } from './capabilities.js'
import { PROVIDER_REASONING_PROFILES } from './catalog.js'
import type { ReasoningTierOption, ReasoningTierProfile } from './catalog.js'
import { getOpenAIChatGPTReasoningTiers, getOpenAIChatGPTRuntimeModel } from './openai-chatgpt-models.js'

/** 模型是否暴露细粒度的推理 effort 层级（相对于二元的 /thinking 开关）。
 *  provider 有层级，但只有部分模型家族遵循它们——PROVIDER_REASONING_TIERS
 *  中的 modelPattern 负责把关。它同时驱动 /model 层级选择器和
 *  getReasoningLevel 中的 effort 分支。 */
function getReasoningTierProfile(modelId: string): ReasoningTierProfile | undefined {
  return PROVIDER_REASONING_PROFILES[providerOf(modelId)]?.find(
    (profile) => !profile.modelPattern || profile.modelPattern.test(modelId),
  )
}

/** 某些固定推理的 xAI 模型会完全拒绝 effort 字段。公开的 grok-4.20 别名
 *  不被 SDK 的等价守卫识别。 */
export function acceptsReasoningControl(modelId: string): boolean {
  if (providerOf(modelId) !== 'xai') return true
  const providerModelId = modelId.slice(modelId.indexOf(':') + 1)
  return !/^grok-4\.20(?!-multi-agent(?:$|-))/.test(providerModelId)
}

export function supportsReasoningTier(modelId: string): boolean {
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)
  if (chatGPTTiers !== undefined) return chatGPTTiers.length > 0
  return getReasoningTierProfile(modelId) !== undefined
}

export function getReasoningTierOptions(modelId: string): readonly ReasoningTierOption[] | undefined {
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)
  if (chatGPTTiers !== undefined) return chatGPTTiers
  return getReasoningTierProfile(modelId)?.options
}

export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** 把内部层级值（来自 PROVIDER_REASONING_TIERS）映射到 SDK 的规范推理等级。
 *  大多数是 1:1，但 'max' 映射为 'xhigh'。 */
const TIER_TO_REASONING: Record<string, ReasoningLevel> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

/** 在应用模型支持和无法关闭推理的模型的最低有效 effort 之后，解析出
 *  provider 原生的 effort。 */
export function getReasoningEffort(modelId: string, enabled: boolean, effort?: string): string | undefined {
  const profile = getReasoningTierProfile(modelId)
  if (!profile) return undefined
  if (effort && profile.options.some((option) => option.value === effort)) return effort
  return !enabled ? profile.offValue : undefined
}

/**
 * 计算 streamText/generateText 的顶层 `reasoning` 值。
 * 当模型不支持推理控制时返回 undefined（自定义 provider，或使用不同机制的
 * Alibaba/Zhipu）。
 *
 * 对于支持 SDK 顶层 `reasoning` 参数的 provider（OpenAI、Anthropic、Google、
 * xAI、DeepSeek、Moonshot），这就够了——SDK 会处理针对各 provider 的翻译。
 */
export function getReasoningLevel(modelId: string, enabled: boolean, effort?: string): ReasoningLevel | undefined {
  const provider = providerOf(modelId)
  const chatGPTTiers = getOpenAIChatGPTReasoningTiers(modelId)

  // 这些 provider 使用独立的机制（providerOptions / fetch 垫片）
  if (provider === 'alibaba' || provider === 'zhipu' || provider === 'custom' || !acceptsReasoningControl(modelId)) {
    return undefined
  }

  if (chatGPTTiers !== undefined) {
    if (chatGPTTiers.length === 0) return undefined
    const supported = chatGPTTiers.map((tier) => tier.value)
    if (effort && supported.includes(effort)) return effort as ReasoningLevel
    if (!effort && !enabled && supported.includes('none')) return 'none'
    const declaredDefault = getOpenAIChatGPTRuntimeModel(modelId)?.defaultReasoningLevel
    if (declaredDefault && supported.includes(declaredDefault)) return declaredDefault as ReasoningLevel
    return chatGPTTiers[Math.floor((chatGPTTiers.length - 1) / 2)]?.value as ReasoningLevel
  }

  const effectiveEffort = getReasoningEffort(modelId, enabled, effort)
  // DeepSeek 暴露 provider 原生的 low/high/max 值。发送可移植的 max 等价物
  // （`xhigh`）会让 SDK 把它映射回 `max` 并产生兼容性警告，因此显式层级只
  // 通过 providerOptions.deepseek.reasoningEffort 传递。
  if (provider === 'deepseek' && effectiveEffort) return undefined
  if (effectiveEffort) {
    return TIER_TO_REASONING[effectiveEffort] ?? (effectiveEffort as ReasoningLevel)
  }

  return enabled ? 'high' : 'none'
}

/**
 * 在可移植的顶层 `reasoning` 值无法表达精确的 provider 控件时，
 * 构建 provider 原生的推理选项。
 */
export function getThinkingProviderOptions(
  modelId: string,
  enabled: boolean,
  effort?: string,
): Record<string, Record<string, unknown>> {
  const provider = providerOf(modelId)

  switch (provider) {
    case 'deepseek':
      const deepseekEffort = getReasoningEffort(modelId, enabled, effort)
      return deepseekEffort ? { deepseek: { reasoningEffort: deepseekEffort } } : {}

    case 'alibaba':
      return { alibaba: { enableThinking: enabled } }

    case 'zhipu':
      // 对不使用层级的模型，通过 providerOptions 做二元开关。
      // 分层级的模型由 fetch 垫片注入 reasoning_effort。
      const zhipuEffort = getReasoningEffort(modelId, enabled, effort)
      if (zhipuEffort) {
        return { zhipu: { thinking: { type: 'enabled' }, reasoningEffort: zhipuEffort } }
      }
      return enabled ? { zhipu: { thinking: { type: 'enabled' } } } : { zhipu: { thinking: { type: 'disabled' } } }

    case 'anthropic':
      return effort === 'max' && getReasoningTierOptions(modelId)?.some((option) => option.value === 'max')
        ? { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } }
        : {}

    case 'openai':
      return effort === 'max' && getReasoningTierOptions(modelId)?.some((option) => option.value === 'max')
        ? { openai: { reasoningEffort: 'max' } }
        : {}

    default:
      return {}
  }
}

/** 把 thinking-mode 的 providerOptions 合并进已有的 providerOptions 袋，
 *  而不破坏无关的键（如 Anthropic cache-control）。各 provider 条目做一层
 *  深合并：x.thinking 和 x.cacheControl 可以共存于 `providerOptions.anthropic`。 */
export function mergeThinkingOptions(
  base: Record<string, unknown> | undefined,
  thinking: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  for (const [provider, entry] of Object.entries(thinking)) {
    const existing = (merged[provider] as Record<string, unknown> | undefined) ?? {}
    merged[provider] = { ...existing, ...entry }
  }
  return merged
}
