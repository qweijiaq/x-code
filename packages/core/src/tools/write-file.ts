// @x-code-cli/core — writeFile 工具（无 execute —— 权限检查在 agent loop 中处理）
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description:
    'Create or completely overwrite a local file. Read an existing file first, prefer edit for targeted changes, and do not create documentation unless the user requested it. Files the user should keep belong inside the working directory, not the system temp directory.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // 无 execute —— 由 agent loop 手动处理以便做权限检查
})
