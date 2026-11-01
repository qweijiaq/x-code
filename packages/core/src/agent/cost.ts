// @x-code-cli/core — 用量成本估算
//
// 只做列表价换算，不负责预算判定（见 `budget.ts`）。成本来自
// `UsageBreakdown.byModel`，因此子代理、压缩和视觉回退使用不同模型时也能
// 分开计价；未定价模型会被显式列出来，而不是按 0 计入总额。
import { type ModelPricing, estimateCostUsd, getModelPricing } from '../providers/pricing.js'
import type { TokenUsage } from '../types/index.js'
import type { UsageBreakdown } from './usage.js'

export interface CostEstimate {
  /** 已定价部分的美元成本。 */
  usd: number
  /** 有 token 消耗但没有价格来源的模型 id。 */
  unpricedModels: string[]
}

function pricedCost(inputTokens: number, outputTokens: number, pricing: ModelPricing | undefined): number | null {
  if (!pricing) return null
  return estimateCostUsd(inputTokens, outputTokens, pricing)
}

/** 按模型拆分估算累计成本。 */
export function estimateBreakdownCost(breakdown: UsageBreakdown): CostEstimate {
  let usd = 0
  const unpriced = new Set<string>()
  for (const [modelId, delta] of Object.entries(breakdown.byModel)) {
    if (delta.inputTokens === 0 && delta.outputTokens === 0) continue
    const cost = pricedCost(delta.inputTokens, delta.outputTokens, getModelPricing(modelId))
    if (cost === null) unpriced.add(modelId)
    else usd += cost
  }
  return { usd, unpricedModels: [...unpriced].sort() }
}

/** 单个模型视图的成本（桌面 footer 用）。模型未定价时 `priced` 为 false。 */
export function estimateUsageCost(usage: TokenUsage, modelId: string): { usd: number; priced: boolean } {
  const pricing = getModelPricing(modelId)
  if (!pricing) return { usd: 0, priced: false }
  return {
    usd: estimateCostUsd(usage.inputTokens, usage.outputTokens, pricing),
    priced: true,
  }
}
