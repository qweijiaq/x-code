import { tool } from 'ai'

import { z } from 'zod'

import { requestGoalBlocked, requestGoalComplete } from '../agent/goal/state.js'
import type { LoopState } from '../agent/loop-state.js'

export function createUpdateGoalTool(state: LoopState) {
  return tool({
    description:
      'Request terminal progress for the current durable goal. This does not directly mark the goal complete; the host verifies completion first.',
    inputSchema: z.object({
      status: z.enum(['complete', 'blocked']).describe('Request completion verification or report a repeated blocker.'),
      evidence: z.string().optional().describe('Concrete completion evidence, required for status=complete.'),
      summary: z.string().optional().describe('Concise summary of the current result.'),
      blocker: z.string().optional().describe('External blocker, required for status=blocked.'),
    }),
    execute: async (input, runOptions) => {
      // 与 getGoal 保持同一套返回契约：没有 goal / goal 不是 active / 必填字段
      // 为空都属于“调用不成立”，返回 { ok: false, error } 而不是把异常抛进
      // SDK 的工具执行链（那会让调用方永远只能看到成功，且重复调用变成未捕获
      // 的工具错误）。
      const goal = state.goal
      if (!goal) return { ok: false as const, error: 'No goal exists in this session.' }
      if (goal.status !== 'active') {
        return { ok: false as const, error: `Goal is ${goal.status}, not active.` }
      }

      if (input.status === 'complete') {
        if (!input.evidence?.trim()) {
          return { ok: false as const, error: 'status=complete requires non-empty evidence.' }
        }
        const transition = requestGoalComplete(state, {
          evidence: input.evidence,
          summary: input.summary,
          requestedByToolCallId: runOptions.toolCallId,
        })
        return {
          ok: true as const,
          status: 'completion_requested',
          message: 'Completion requested. Host verification will decide whether the goal becomes complete.',
          transition,
        }
      }

      if (!input.blocker?.trim()) {
        return { ok: false as const, error: 'status=blocked requires a non-empty blocker.' }
      }
      const transition = requestGoalBlocked(state, {
        blocker: input.blocker,
        evidence: input.evidence,
        summary: input.summary,
        requestedByToolCallId: runOptions.toolCallId,
      })
      return {
        ok: true as const,
        status: 'blocked_requested',
        message: 'Blocked state requested. The host accepts blocked only after the same blocker repeats.',
        transition,
      }
    },
  })
}
