// @x-code-cli/core — 模型价格表
//
// 只收录仓库自身已经公开标价的模型（catalog 描述里的 `$in/$out`）。没有
// 可靠来源的模型保持“未定价”，由 `cost.ts` 明确报告，而不是猜一个数字。
//
// 用户可以在 `~/.x-code/config.json` 的 `pricing` 字段里覆盖或补充价格：
//   { "pricing": { "deepseek:deepseek-flash": { "inputPerMTok": 0.28, "outputPerMTok": 0.42 } } }
// 启动时由 `setPricingOverrides()` 注入，避免每个调用点都读配置文件。
//
// 计费口径：`inputTokens` 已经包含 cacheRead / cacheCreation，所以这里统一
// 按输入价计费 —— 对支持缓存折扣的提供商是**上限估计**，不会低估预算。

export interface ModelPricing {
  /** 每百万输入 token 的美元价格。 */
  inputPerMTok: number
  /** 每百万输出 token 的美元价格。 */
  outputPerMTok: number
}

/** catalog 描述里明确标价的模型。缺一条的后果不是"少一个数字"：`cost.ts` 的
 *  `estimateUsageCost()` 会恒返回 `priced: false`，`--max-cost` 预算判定就完全
 *  不会触发。加模型时请同步这里。 */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
  // anthropic 的 defaultModel，也是别名 `sonnet` 的解析目标（catalog.ts:228）
  ['anthropic:claude-sonnet-5-5', { inputPerMTok: 2, outputPerMTok: 10 }],
  // catalog 现描述未标价，但这是此前已公开的历史档位价格；保留以免已有用户的
  // 成本上报/预算判定突然失效。
  ['anthropic:claude-sonnet-5', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['anthropic:claude-haiku-5-5', { inputPerMTok: 0.1, outputPerMTok: 0.5 }],
  ['anthropic:claude-haiku-4-5', { inputPerMTok: 1, outputPerMTok: 5 }],
  ['xai:grok-4.3', { inputPerMTok: 1.25, outputPerMTok: 2.5 }],
  ['zhipu:glm-5.2', { inputPerMTok: 1.4, outputPerMTok: 4.4 }],
  ['zhipu:glm-5', { inputPerMTok: 1, outputPerMTok: 3.2 }],
  ['zhipu:glm-4.7', { inputPerMTok: 0.6, outputPerMTok: 2.2 }],
  ['zhipu:glm-5v-turbo', { inputPerMTok: 1.2, outputPerMTok: 4 }],
  ['zhipu:glm-4.6v', { inputPerMTok: 0.3, outputPerMTok: 0.9 }],
  ['openai:gpt-5.6-sol', { inputPerMTok: 4, outputPerMTok: 20 }],
  ['openai:gpt-5.6-terra', { inputPerMTok: 2, outputPerMTok: 12 }],
  ['openai:gpt-5.6-luna', { inputPerMTok: 0.2, outputPerMTok: 1.2 }],
  ['openai:gpt-5.4-mini', { inputPerMTok: 0.75, outputPerMTok: 4.5 }],
  ['openai:gpt-5.4-nano', { inputPerMTok: 0.2, outputPerMTok: 1.25 }],
])

let pricingOverrides: ReadonlyMap<string, ModelPricing> = new Map()

function normalizePricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const input = record.inputPerMTok
  const output = record.outputPerMTok
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return null
  return { inputPerMTok: input, outputPerMTok: output }
}

/** 用 `UserConfig.pricing` 覆盖内置价格。无效条目会被忽略而不是让启动失败。 */
export function setPricingOverrides(value: unknown): void {
  const next = new Map<string, ModelPricing>()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [modelId, raw] of Object.entries(value as Record<string, unknown>)) {
      const id = modelId.trim()
      const pricing = normalizePricing(raw)
      if (id && pricing) next.set(id, pricing)
    }
  }
  pricingOverrides = next
}

/** 仅用于测试：清空用户覆盖。 */
export function clearPricingOverrides(): void {
  pricingOverrides = new Map()
}

export function getModelPricing(modelId: string): ModelPricing | undefined {
  return pricingOverrides.get(modelId) ?? MODEL_PRICING.get(modelId)
}

/** 按每百万 token 单价估算一次请求的美元成本。 */
export function estimateCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  const input = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0
  const output = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0
  return (input / 1_000_000) * pricing.inputPerMTok + (output / 1_000_000) * pricing.outputPerMTok
}

/** 面向 UI 的金额格式：小额保留 4 位，大额保留 2 位。 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${value.toFixed(0)}`
}
