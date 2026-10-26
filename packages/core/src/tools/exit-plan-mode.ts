// @x-code-cli/core — exitPlanMode 工具（用户审批关卡，无 execute —— 由 agent loop 处理）
import { tool } from 'ai'

import { z } from 'zod'

/** 把计划呈现给用户审批。用户会看到一个 Yes/No 对话框，正文就是计划内容；
 *  选 Yes 时，会话退出计划模式，下一轮即可写代码；选 No 时，会话停留在
 *  计划模式，并提示模型修改计划。
 *
 *  没有 `execute` 字段 —— `processToolCalls` 里的分发路径会读取计划文件，
 *  调用 `callbacks.onPlanApprovalRequest(planText)`，再把裁决作为合成的
 *  工具结果回传，让模型知道是继续还是迭代。 */
export const exitPlanMode = tool({
  description:
    'Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval. This tool reads the plan from the file you wrote during planning — pass an optional `plan` parameter only if you want to override what is in the file. The user sees the plan content in an approval dialog and chooses Yes/No. The model cannot leave plan mode without user approval; if rejected, revise the plan file (using edit) and call this again. Do NOT use this for research / Q&A — only when the user has asked you to implement something and you have a complete plan written to the plan file. Do NOT use askUser to ask "is this plan okay?" — exitPlanMode is the only correct way to request plan approval.',
  inputSchema: z.object({
    plan: z
      .string()
      .optional()
      .describe(
        'Optional override for the plan body. By default the plan body comes from the plan file you wrote during planning — only pass this argument if you want to use different content (rare).',
      ),
  }),
})
