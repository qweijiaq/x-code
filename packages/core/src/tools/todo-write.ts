// @x-code-cli/core — todoWrite 工具（模型维护的清单，无 execute —— 由 agent loop 处理）
import { tool } from 'ai'

import { z } from 'zod'

/** 模型通过该工具维护一个进行中的清单。每次调用都会替换整份清单
 *  （不做合并/增量）—— 模型被要求每次都传完整的更新数组，包括未变化的项。
 *  当所有项都完成时，agent loop 会自动清空清单以释放实时 UI 面板。
 *
 *  存储：保存在 `LoopState.todos` 的内存中，通过 `callbacks.onTodosUpdate`
 *  镜像到 React 状态。从不持久化到磁盘（与 Claude Code 一致）—— 清单是
 *  会话范围的工作记忆，不是记录。
 *
 *  没有 `execute` 字段 —— 副作用（改动 LoopState.todos 并通知 UI）在
 *  `processToolCalls` 里手动处理，和 askUser / enterPlanMode 同一套模式。 */
export const todoWrite = tool({
  description: `Replace the complete live checklist for work with at least three milestones. Include unchanged items and keep exactly one item in_progress until every item is completed. Update IMMEDIATELY after each milestone — mark items completed as soon as their work finishes, never batch completions at the end of the turn; a stale checklist is a mistake. Completed lists are automatically cleared. Skip for trivial work and pure research.`,
  inputSchema: z.object({
    explanation: z.string().optional().describe('Optional reason for the update.'),
    todos: z
      .array(
        z.object({
          content: z.string().optional().describe('Task label, such as "Run tests".'),
          activeForm: z.string().optional().describe('Active UI label, such as "Running tests".'),
          status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Lifecycle state.'),
        }),
      )
      .describe('Complete replacement list, including unchanged items.'),
  }),
})
