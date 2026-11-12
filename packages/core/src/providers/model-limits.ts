// @x-code-cli/core — 模型级静态上限
//
// 上下文窗口和最大输出 token 的唯一事实来源。`agent/context-window.ts`
// 保留解析顺序（用户覆盖 → ChatGPT 运行时模型 → 本表 → provider 回退），
// 这里只放静态数字，避免同一个值同时出现在多张表里、新增模型时漏改。
//
// 新增模型时必须在本表登记 `contextWindow`。`model-limits.test.ts` 会检查
// catalog 里每个可选模型都有条目 —— 静默回退到 128k 会让 1M 窗口的模型被
// 过早压缩，也会让 32k 窗口的模型直接 overflow。
export interface ModelLimits {
  /** 模型原始上下文窗口（token）。压缩阈值由调用方按比例应用一次。 */
  contextWindow: number
  /** 请求可声明的最大输出 token；省略时使用 DEFAULT_MAX_OUTPUT_TOKENS。 */
  maxOutputTokens?: number
}

/** 提供商级和模型级查找都未命中时的默认上下文窗口。 */
export const DEFAULT_CONTEXT_WINDOW = 128000

/** 没有显式输出上限时的默认值；AI SDK 会按已知 provider 再做裁剪。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384

/** 提供商级回退上下文窗口。 */
export const PROVIDER_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['anthropic', 1000000],
  ['openai', 128000],
  ['google', 1000000],
  ['deepseek', 1000000],
  ['alibaba', 128000],
  ['xai', 128000],
  ['zhipu', 128000],
  ['moonshotai', 128000],
])

export const MODEL_LIMITS: ReadonlyMap<string, ModelLimits> = new Map<string, ModelLimits>([
  // Anthropic
  ['anthropic:claude-fable-5-1', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-mythos-5-1', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-mythos-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-opus-5-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-opus-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-fable-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-opus-4-8', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-sonnet-5-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-sonnet-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-haiku-5-5', { contextWindow: 1000000, maxOutputTokens: 128000 }],
  ['anthropic:claude-haiku-4-5', { contextWindow: 200000, maxOutputTokens: 64000 }],
  // OpenAI
  ['openai:gpt-6-astra', { contextWindow: 1050000, maxOutputTokens: 128000 }],
  ['openai:gpt-6.1-sol', { contextWindow: 1050000, maxOutputTokens: 128000 }],
  ['openai:gpt-6.1-terra', { contextWindow: 1050000, maxOutputTokens: 128000 }],
  ['openai:gpt-6-sol', { contextWindow: 1050000, maxOutputTokens: 128000 }],
  ['openai:gpt-6-luna', { contextWindow: 1050000, maxOutputTokens: 128000 }],
  ['openai:gpt-5.6-sol', { contextWindow: 1047576 }],
  ['openai:gpt-5.6-terra', { contextWindow: 1047576 }],
  ['openai:gpt-5.6-luna', { contextWindow: 1047576 }],
  ['openai:gpt-5.4-mini', { contextWindow: 1047576 }],
  ['openai:gpt-5.4-nano', { contextWindow: 1047576 }],
  // Google
  ['google:gemini-4-argon', { contextWindow: 1048576, maxOutputTokens: 1048576 }],
  ['google:gemini-3.8-flash', { contextWindow: 1048576, maxOutputTokens: 65536 }],
  ['google:gemini-3.7-flash', { contextWindow: 1048576, maxOutputTokens: 65536 }],
  ['google:gemini-3.6-flash', { contextWindow: 1048576, maxOutputTokens: 65536 }],
  ['google:gemini-3.5-flash', { contextWindow: 1000000 }],
  ['google:gemini-3.5-flash-lite', { contextWindow: 1000000 }],
  ['google:gemini-2.5-pro', { contextWindow: 1000000 }],
  ['google:gemini-2.5-flash', { contextWindow: 1000000 }],
  // DeepSeek
  ['deepseek:deepseek-flash', { contextWindow: 1000000, maxOutputTokens: 393216 }],
  ['deepseek:deepseek-v4-flash', { contextWindow: 1000000, maxOutputTokens: 393216 }],
  ['deepseek:deepseek-v4-pro', { contextWindow: 1000000, maxOutputTokens: 393216 }],
  // Alibaba —— 当前的 Qwen3.8 系列、qwen3.7-max/plus 以及 qwen3-coder-plus 可扩展到 1M；
  // qwen-max 仍封顶在 32k。数值经
  // https://help.aliyun.com/zh/model-studio/models 核实。
  ['alibaba:qwen3.8-max', { contextWindow: 1000000, maxOutputTokens: 65536 }],
  ['alibaba:qwen3.8-flash', { contextWindow: 1000000, maxOutputTokens: 65536 }],
  ['alibaba:qwen3.7-max', { contextWindow: 1000000, maxOutputTokens: 32000 }],
  ['alibaba:qwen3.7-plus', { contextWindow: 1000000, maxOutputTokens: 65536 }],
  ['alibaba:qwen3.7-flash', { contextWindow: 1000000, maxOutputTokens: 65536 }],
  ['alibaba:qwen3-coder-plus', { contextWindow: 1000000, maxOutputTokens: 32000 }],
  ['alibaba:qwq-plus', { contextWindow: 131072, maxOutputTokens: 32000 }],
  ['alibaba:qwen-max', { contextWindow: 32768, maxOutputTokens: 8192 }],
  // 视觉变体没有单独的官方窗口数据，沿用 provider 回退值（与改动前一致）。
  ['alibaba:qwen3-vl-flash', { contextWindow: 128000 }],
  ['alibaba:qwen3-vl-plus', { contextWindow: 128000 }],
  // xAI —— Grok 4.7/4.6/4.5 有 500k 窗口；Grok 4.20/4.3 有 2M/1M。
  ['xai:grok-4.7', { contextWindow: 500000 }],
  ['xai:grok-4.6', { contextWindow: 500000 }],
  ['xai:grok-4.20-0309-reasoning', { contextWindow: 2000000 }],
  ['xai:grok-4.20-0309-non-reasoning', { contextWindow: 2000000 }],
  ['xai:grok-4.20', { contextWindow: 2000000 }],
  ['xai:grok-4.20-non-reasoning', { contextWindow: 2000000 }],
  ['xai:grok-4.5', { contextWindow: 500000 }],
  ['xai:grok-4.3', { contextWindow: 1000000 }],
  // Zhipu
  ['zhipu:glm-5.3', { contextWindow: 1000000 }],
  ['zhipu:glm-5.3-flash', { contextWindow: 1000000 }],
  ['zhipu:glm-5.2', { contextWindow: 1000000 }],
  ['zhipu:glm-5', { contextWindow: 200000 }],
  ['zhipu:glm-4.7', { contextWindow: 128000 }],
  // 视觉变体没有单独的官方窗口数据，沿用 provider 回退值（与改动前一致）。
  ['zhipu:glm-4.6v', { contextWindow: 128000 }],
  ['zhipu:glm-5v-turbo', { contextWindow: 128000 }],
  // Moonshot
  ['moonshotai:kimi-k3.1-pro', { contextWindow: 1000000 }],
  ['moonshotai:kimi-k3.1-pro-highspeed', { contextWindow: 1000000 }],
  ['moonshotai:kimi-k3', { contextWindow: 1000000 }],
  ['moonshotai:kimi-k2.7-code', { contextWindow: 262144 }],
  ['moonshotai:kimi-k2.7-code-highspeed', { contextWindow: 262144 }],
  ['moonshotai:kimi-k2.6', { contextWindow: 262144 }],
])
