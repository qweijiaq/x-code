// @x-code-cli/core — 后台任务查询工具
//
// 这些工具是只读的：列出现有的后台 shell / 后台子代理，读取某个任务的状态，
// 或拉取输出尾部。真正的执行、停止和权限仍由桌面端后台面板与现有工具负责。
import { tool } from 'ai'

import { z } from 'zod'

export const backgroundList = tool({
  description:
    'List background shells and background sub-agent tasks with their ids, status, elapsed time and a short description. Use this when the user asks what is running or for an overall progress summary.',
  inputSchema: z.object({}),
})

export const backgroundGet = tool({
  description:
    'Get the current status of one background shell or sub-agent task by id (from backgroundList or a tool result). Returns status, elapsed time, command/description, counts and any finished result. This does not wait.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The background task id, e.g. shell-12 or bg-...'),
  }),
})

export const backgroundOutput = tool({
  description:
    'Read the output tail of a background shell or sub-agent task. By default it returns immediately (block:false). Set block:true to wait for completion up to timeoutMs. Use it when the user asks how a background task is progressing or what it has printed so far.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The background task id, e.g. shell-12 or bg-...'),
    block: z
      .boolean()
      .optional()
      .describe('Wait for the task to finish instead of returning immediately (default false)'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(300_000)
      .optional()
      .describe('Maximum time to wait when block is true (default 30000 ms)'),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .optional()
      .describe('Maximum output characters to return (default 4000)'),
  }),
})
