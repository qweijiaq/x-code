// @x-code-cli/core — enterPlanMode 工具（模式切换，无 execute —— 由 agent loop 处理）
import { tool } from 'ai'

import { z } from 'zod'

/** 没有 execute 字段：审批与模式切换由 dispatcher 负责。 */
export const enterPlanMode = tool({
  description: `Request plan mode before a non-trivial implementation that has unclear requirements, architectural choices, or coordinated multi-file changes. Skip it for small explicit edits and research/Q&A. In plan mode, inspect the code, clarify material choices, write the proposed implementation to the session plan file, then call exitPlanMode for approval.`,
  inputSchema: z.object({
    topic: z
      .string()
      .min(1)
      // 与 plan-storage.ts 的 SLUG_MAX_LEN 保持一致：更长的显式 slug 不会被截断。
      .max(40)
      // 显式 slug 会绕过 makePlanFilePath 里的 slugify 直接进 path.join，
      // 因此必须在这里就排除路径分隔符、`..` 与控制字符。
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens only.')
      .optional()
      .describe('Optional 3-5 word lowercase English filename slug, hyphen-separated.'),
  }),
})
