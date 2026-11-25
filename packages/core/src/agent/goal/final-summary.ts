import { buildFinalSummaryPrompt } from './prompts.js'
import type { GoalState, GoalStatus } from './types.js'

export interface RunFinalSummaryInput {
  goal: GoalState
  reason: Extract<GoalStatus, 'max_turns' | 'budget_limited'>
  runAgentTurn: (content: string, options: { silent: boolean; finalSummary: boolean }) => Promise<{ text?: string }>
}

export async function runFinalSummaryTurn(input: RunFinalSummaryInput): Promise<string> {
  let summary: string | undefined
  try {
    const result = await input.runAgentTurn(buildFinalSummaryPrompt(input.goal, input.reason), {
      silent: true,
      finalSummary: true,
    })
    summary = result.text?.trim()
  } catch (error) {
    // 摘要轮失败绝不能中断 finalization：调用方的 `clearPendingTransition` +
    // `updateGoalStatus` 必须执行，否则 goal 会卡在 active 并残留 pending
    // transition。主循环 turn 同样有 try/catch 兜底，这里与之对称。
    const reason = error instanceof Error ? error.message : String(error)
    summary = `${input.reason}: final summary turn failed: ${reason}`
  }
  return summary || `${input.reason}: final summary turn completed without a text response.`
}
