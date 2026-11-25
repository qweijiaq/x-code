import { randomUUID } from 'node:crypto'

import type { TokenUsage } from '../../types/index.js'
import { markExpectedCacheMiss } from '../cache-stats.js'
import type { LoopState } from '../loop-state.js'
import type {
  GoalAttempt,
  GoalPendingTransition,
  GoalState,
  GoalStatus,
  GoalVerificationResult,
  GoalVerifier,
} from './types.js'

export interface CreateGoalInput {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  verifiers?: GoalVerifier[]
  requiresUserConfirmation?: boolean
  createdBy?: GoalState['createdBy']
}

const TERMINAL_STATUSES = new Set<GoalStatus>([
  'blocked',
  'complete',
  'cancelled',
  'budget_limited',
  'usage_limited',
  'max_turns',
  'failed',
])

/** 可以回到 active 的状态。`blocked` / `max_turns` 虽是终态，但可以 resume；
 *  这份集合此前在本文件与调用方各写了一遍，容易漂移，统一由这里导出。 */
const RESUMABLE_STATUSES = new Set<GoalStatus>(['paused', 'blocked', 'max_turns'])

export function isGoalTerminal(status: GoalStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function isGoalResumable(status: GoalStatus): boolean {
  return RESUMABLE_STATUSES.has(status)
}

function assertActiveGoal(state: LoopState, goalId?: string): GoalState {
  const goal = state.goal
  if (!goal) throw new Error('No goal exists in this session')
  if (goalId && goal.id !== goalId) throw new Error(`Goal ${goalId} is not the current goal`)
  if (goal.status !== 'active') throw new Error(`Goal is ${goal.status}, not active`)
  return goal
}

export function createGoal(state: LoopState, input: CreateGoalInput): GoalState {
  const objective = input.objective.trim()
  if (!objective) throw new Error('Goal objective is required')
  if (state.goal && !isGoalTerminal(state.goal.status)) {
    throw new Error(`Cannot create a new goal while goal ${state.goal.id} is ${state.goal.status}`)
  }

  const now = new Date().toISOString()
  const goal: GoalState = {
    id: randomUUID(),
    objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? 'slash',
    authority: structuredClone(state.executionAuthority),
    maxTurns: input.maxTurns && input.maxTurns > 0 ? Math.floor(input.maxTurns) : undefined,
    turnCount: 0,
    tokenBudget: input.tokenBudget && input.tokenBudget > 0 ? Math.floor(input.tokenBudget) : undefined,
    baselineTokens: state.tokenUsage.totalTokens,
    verifiers: input.verifiers ?? [],
    verificationResults: [],
    repeatedBlockerCount: 0,
    repeatedVerificationFailureCount: 0,
    attempts: [],
    requiresUserConfirmation: input.requiresUserConfirmation,
  }
  state.goal = goal
  state.goalInputs = []
  state.systemPromptCache = null
  markExpectedCacheMiss(state, 'goal-change')
  return goal
}

export function updateGoalStatus(goal: GoalState, status: GoalStatus, summary?: string): GoalState {
  goal.status = status
  goal.updatedAt = new Date().toISOString()
  if (summary !== undefined) goal.finalSummary = summary
  return goal
}

/** 离开 active 时必须丢弃尚未消费的 pending transition：否则 pause/cancel 之后
 *  它一直挂在 state 上（UI 持续显示 "Pending transition: complete_requested"），
 *  且 resume 后 runner 会立刻拿用户已经放弃的旧请求去跑 verifier ladder。 */
export function pauseGoal(state: LoopState): GoalState {
  const goal = assertActiveGoal(state)
  updateGoalStatus(goal, 'paused')
  clearPendingTransition(goal)
  return goal
}

export function resumeGoal(state: LoopState): GoalState {
  if (!state.goal) throw new Error('No goal exists in this session')
  if (!isGoalResumable(state.goal.status)) {
    throw new Error(`Cannot resume a goal with status ${state.goal.status}`)
  }
  state.goal.status = 'active'
  // 恢复时丢弃暂停/阻塞前遗留的完成请求，避免 runner 立刻拿旧证据跑 verifier。
  clearPendingTransition(state.goal)
  if (!state.goal.authority) {
    state.goal.authority = { source: 'peer', peerTainted: true }
  }
  if (state.goal.authority.peerTainted || state.goal.authority.source === 'peer') {
    state.executionAuthority = structuredClone(state.goal.authority)
  }
  state.goal.updatedAt = new Date().toISOString()
  state.systemPromptCache = null
  markExpectedCacheMiss(state, 'goal-change')
  return state.goal
}

export function cancelGoal(state: LoopState): GoalState {
  if (!state.goal) throw new Error('No goal exists in this session')
  // 已经处于终态时不动 updatedAt/status：否则“完成时间”会被取消操作改写，
  // 事件日志里也会多出一条伪状态变更。
  if (isGoalTerminal(state.goal.status)) return state.goal
  updateGoalStatus(state.goal, 'cancelled')
  clearPendingTransition(state.goal)
  return state.goal
}

export function clearGoal(state: LoopState): void {
  state.goal = null
  state.goalInputs = []
  state.systemPromptCache = null
  markExpectedCacheMiss(state, 'goal-change')
}

export function requestGoalComplete(
  state: LoopState,
  input: { evidence: string; summary?: string; requestedByToolCallId?: string },
): GoalPendingTransition {
  const goal = assertActiveGoal(state)
  if (!input.evidence.trim()) throw new Error('Completion evidence is required')
  const transition: GoalPendingTransition = {
    kind: 'complete_requested',
    evidence: input.evidence.trim(),
    summary: input.summary?.trim() || undefined,
    requestedAt: new Date().toISOString(),
    requestedByToolCallId: input.requestedByToolCallId,
  }
  goal.pendingTransition = transition
  goal.updatedAt = transition.requestedAt
  return transition
}

export function requestGoalBlocked(
  state: LoopState,
  input: { blocker: string; evidence?: string; summary?: string; requestedByToolCallId?: string },
): GoalPendingTransition {
  const goal = assertActiveGoal(state)
  if (!input.blocker.trim()) throw new Error('Blocker is required')
  const transition: GoalPendingTransition = {
    kind: 'blocked_requested',
    evidence: input.evidence?.trim() || input.blocker.trim(),
    summary: input.summary?.trim() || undefined,
    blocker: input.blocker.trim(),
    requestedAt: new Date().toISOString(),
    requestedByToolCallId: input.requestedByToolCallId,
  }
  goal.pendingTransition = transition
  goal.updatedAt = transition.requestedAt
  return transition
}

export function clearPendingTransition(goal: GoalState): void {
  delete goal.pendingTransition
  goal.updatedAt = new Date().toISOString()
}

/** 保留的验证结果条数。每个结果可带最长 8000 字符的 stdout，无上限累积会让
 *  LoopState 持续膨胀并被写进会话记录；取 40 与桌面端报告的窗口一致，
 *  裁剪不会让任何已展示的内容消失。 */
const MAX_VERIFICATION_RESULTS = 40

export function recordGoalAttempt(goal: GoalState, attempt: GoalAttempt): void {
  // 从旧版本会话记录恢复的 goal 可能缺这些字段：`attempts.push` 会抛 TypeError，
  // 而 `turnCount` 为 undefined 时 `+= 1` 得到 NaN，令 runner 的
  // `turnCount >= maxTurns` 恒为 false——max_turns 保护彻底失效。
  if (!Array.isArray(goal.attempts)) goal.attempts = []
  goal.attempts.push(attempt)
  goal.turnCount = (Number.isFinite(goal.turnCount) ? goal.turnCount : 0) + 1
  goal.updatedAt = attempt.endedAt ?? new Date().toISOString()
}

export function recordVerificationResult(goal: GoalState, result: GoalVerificationResult): void {
  if (!Array.isArray(goal.verificationResults)) goal.verificationResults = []
  goal.verificationResults.push(result)
  if (goal.verificationResults.length > MAX_VERIFICATION_RESULTS) {
    goal.verificationResults.splice(0, goal.verificationResults.length - MAX_VERIFICATION_RESULTS)
  }
  goal.updatedAt = result.ts
}

export function recordVerificationFailure(goal: GoalState, results: GoalVerificationResult[]): number {
  const fingerprint = verificationFailureFingerprint(results)
  // 空指纹表示“无法判定是否重复”（没有可归一化的失败文本）。此时既不能把一个
  // 空串持久化进 lastVerificationFailureFingerprint（reset 用的是 delete 语义），
  // 也不能让计数停在旧值上，统一归零并返回 1。
  if (!fingerprint) {
    delete goal.lastVerificationFailureFingerprint
    goal.repeatedVerificationFailureCount = 1
    goal.updatedAt = new Date().toISOString()
    return 1
  }
  const repeatedCount =
    fingerprint === goal.lastVerificationFailureFingerprint ? goal.repeatedVerificationFailureCount + 1 : 1
  goal.lastVerificationFailureFingerprint = fingerprint
  goal.repeatedVerificationFailureCount = repeatedCount
  goal.updatedAt = new Date().toISOString()
  return repeatedCount
}

export function resetVerificationFailures(goal: GoalState): void {
  goal.repeatedVerificationFailureCount = 0
  delete goal.lastVerificationFailureFingerprint
  goal.updatedAt = new Date().toISOString()
}

function verificationFailureFingerprint(results: GoalVerificationResult[]): string {
  // 没有失败项时退化为“整体验证”的指纹：否则返回空串会让重复失败计数永远停在
  // 1，`buildVerifierFailurePrompt` 拿到的 consecutive count 也就永远升不上去。
  const failing = results.filter((result) => !result.ok)
  return (failing.length > 0 ? failing : results)
    .map((result) => {
      const verifier =
        result.verifier.kind === 'shell'
          ? `shell:${result.verifier.command}`
          : result.verifier.kind === 'subagent'
            ? `subagent:${result.verifier.agent}`
            : `file:${result.verifier.path}`
      const details = result.requiredFixes?.length ? result.requiredFixes : [result.summary]
      return `${verifier}:${details.map(normalizeFailureText).join('|')}`
    })
    .join('||')
}

function normalizeFailureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function snapshotUsage(usage: TokenUsage): TokenUsage {
  return { ...usage }
}

export function remainingTokenBudget(goal: GoalState, state: LoopState): number | undefined {
  if (!goal.tokenBudget) return undefined
  return Math.max(0, goal.tokenBudget - (state.tokenUsage.totalTokens - goal.baselineTokens))
}

export function tokenBudgetReached(goal: GoalState, state: LoopState): boolean {
  const remaining = remainingTokenBudget(goal, state)
  return remaining !== undefined && remaining <= 0
}
