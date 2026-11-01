// @x-code-cli/core — 每次提交的花费/用量预算
//
// 预算是“每次 agentLoop 调用”的增量，而不是整会话累计：交互式会话会跨多次
// submit 复用同一个 LoopState，若按累计值判断，达到上限后整个会话就永久锁死。
// 调用方传入基线差值（本次 submit 开始后新增的 token / 成本）。
import { formatUsd } from '../providers/pricing.js'

export interface BudgetLimits {
  /** 本次 submit 允许消耗的 token 上限。 */
  maxTokens?: number
  /** 本次 submit 允许消耗的估算美元上限。 */
  maxCostUsd?: number
}

export interface BudgetUsage {
  tokens: number
  costUsd: number
  /** 成本估算中未定价的模型；非空时 `costUsd` 只是下界。 */
  unpricedModels?: readonly string[]
}

export type BudgetVerdict = { exceeded: false } | { exceeded: true; reason: 'tokens' | 'cost'; message: string }

function validLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 判定是否超过预算。阈值相等也算超限（预算是“不超过”的上界）。 */
export function checkBudget(limits: BudgetLimits | undefined, usage: BudgetUsage): BudgetVerdict {
  if (!limits) return { exceeded: false }
  const maxTokens = validLimit(limits.maxTokens)
  if (maxTokens !== undefined && usage.tokens >= maxTokens) {
    return {
      exceeded: true,
      reason: 'tokens',
      message: `Token budget reached for this prompt: ${usage.tokens.toLocaleString('en-US')} / ${maxTokens.toLocaleString('en-US')} tokens. Raise --max-tokens or start a new prompt to continue.`,
    }
  }
  const maxCost = validLimit(limits.maxCostUsd)
  if (maxCost !== undefined && usage.costUsd >= maxCost) {
    const unpriced = usage.unpricedModels?.length
      ? ` (estimate is a lower bound; unpriced: ${usage.unpricedModels.join(', ')})`
      : ''
    return {
      exceeded: true,
      reason: 'cost',
      message: `Cost budget reached for this prompt: ${formatUsd(usage.costUsd)} / ${formatUsd(maxCost)}${unpriced}. Raise --max-cost or start a new prompt to continue.`,
    }
  }
  return { exceeded: false }
}
