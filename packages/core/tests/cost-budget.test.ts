import { afterEach, describe, expect, it } from 'vitest'

import { checkBudget } from '../src/agent/budget.js'
import { estimateBreakdownCost, estimateUsageCost } from '../src/agent/cost.js'
import { createUsageBreakdown } from '../src/agent/usage.js'
import {
  clearPricingOverrides,
  estimateCostUsd,
  formatUsd,
  getModelPricing,
  setPricingOverrides,
} from '../src/providers/pricing.js'

afterEach(() => {
  clearPricingOverrides()
})

describe('model pricing', () => {
  it('prices models that the catalog advertises', () => {
    expect(getModelPricing('anthropic:claude-sonnet-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
    expect(getModelPricing('openai:gpt-5.4-nano')).toEqual({ inputPerMTok: 0.2, outputPerMTok: 1.25 })
  })

  it('leaves models without a reliable price unpriced', () => {
    expect(getModelPricing('deepseek:deepseek-flash')).toBeUndefined()
    expect(getModelPricing('unknownprovider:model')).toBeUndefined()
  })

  it('lets user overrides win and ignores malformed entries', () => {
    setPricingOverrides({
      'deepseek:deepseek-flash': { inputPerMTok: 0.28, outputPerMTok: 0.42 },
      'anthropic:claude-sonnet-5': { inputPerMTok: -1, outputPerMTok: 15 },
      broken: 'nope',
    })
    expect(getModelPricing('deepseek:deepseek-flash')).toEqual({ inputPerMTok: 0.28, outputPerMTok: 0.42 })
    // 无效条目被忽略，内置价格保持不变。
    expect(getModelPricing('anthropic:claude-sonnet-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
  })

  it('computes per-million-token cost', () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(18)
    expect(estimateCostUsd(0, 0, { inputPerMTok: 100, outputPerMTok: 100 })).toBe(0)
  })

  it('formats small and large amounts without lying about zero', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.00042)).toBe('$0.0004')
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(1234)).toBe('$1234')
  })
})

describe('cost estimates', () => {
  it('sums priced models and reports unpriced ones separately', () => {
    const breakdown = createUsageBreakdown()
    breakdown.byModel['openai:gpt-5.6-sol'] = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheReadReported: false,
      cacheCreationReported: false,
    }
    breakdown.byModel['deepseek:deepseek-flash'] = {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheReadReported: false,
      cacheCreationReported: false,
    }
    const estimate = estimateBreakdownCost(breakdown)
    expect(estimate.usd).toBe(4)
    expect(estimate.unpricedModels).toEqual(['deepseek:deepseek-flash'])
  })

  it('reports whether the active model is priced', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 2000,
    }
    expect(estimateUsageCost(usage, 'openai:gpt-5.6-sol').priced).toBe(true)
    expect(estimateUsageCost(usage, 'openai:gpt-5.6-sol').usd).toBeCloseTo(0.024, 10)
    expect(estimateUsageCost(usage, 'deepseek:deepseek-flash')).toEqual({ usd: 0, priced: false })
  })
})

describe('checkBudget', () => {
  it('is a no-op without limits', () => {
    expect(checkBudget(undefined, { tokens: 10, costUsd: 1 })).toEqual({ exceeded: false })
  })

  it('stops at the token cap and treats equality as exceeded', () => {
    const verdict = checkBudget({ maxTokens: 100 }, { tokens: 100, costUsd: 0 })
    expect(verdict.exceeded).toBe(true)
    if (verdict.exceeded) expect(verdict.reason).toBe('tokens')
  })

  it('stops at the cost cap and names unpriced models', () => {
    const verdict = checkBudget(
      { maxCostUsd: 0.5 },
      { tokens: 0, costUsd: 0.6, unpricedModels: ['deepseek:deepseek-flash'] },
    )
    expect(verdict.exceeded).toBe(true)
    if (verdict.exceeded) {
      expect(verdict.reason).toBe('cost')
      expect(verdict.message).toContain('deepseek:deepseek-flash')
    }
  })

  it('ignores invalid limits and stays under the cap', () => {
    expect(checkBudget({ maxTokens: -1, maxCostUsd: Number.NaN }, { tokens: 10, costUsd: 1 })).toEqual({
      exceeded: false,
    })
    expect(checkBudget({ maxTokens: 101 }, { tokens: 100, costUsd: 0 }).exceeded).toBe(false)
  })
})
