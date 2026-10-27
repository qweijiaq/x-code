// @x-code-cli/core — task 工具（子 agent 分发）
//
// 工具定义没有 `execute` —— 分发在 tool-execution.ts 的 handleToolCall 里
// 手动处理，由它调用 runSubAgent。这是刻意的：task 工具需要访问 LoopState、
// AgentOptions 和回调，而这些在工具的 execute 上下文里都拿不到。
import { tool } from 'ai'

import { z } from 'zod'

import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'

/** 根据注册表动态构建 task 工具描述。
 *  每次会话构造系统提示词缓存时调用一次。可用 agent 的清单被嵌进描述里，
 *  这样模型才知道哪些 subagent_type 值合法。 */
function buildTaskToolDescription(registry: SubAgentRegistry): string {
  const agents = registry.list()
  const agentList = agents.map((a) => `  - ${a.name}: ${a.description}`).join('\n')

  return `Launch an isolated sub-agent for broad investigation or review. It receives a fresh context and returns only its final conclusion.

Available sub-agents:
${agentList}

Use it when a directed search is insufficient. Do not delegate known-symbol searches, a few specific files, or direct questions.

Prompt contract:
- Give a valid subagent_type, a 3-5 word description, and a self-contained prompt with the goal, paths or symbols, known facts, constraints, write permission, and required output.
- Set background: true for long independent work; the call returns a task id immediately, the user can keep chatting, and progress appears in the background task panel.
- Ask for concrete snippets or file:line references when needed, and trust a complete result instead of repeating its exploration.

Independent read-only agents may run concurrently in one assistant message. Never run concurrent agents that can write the same files or resources.`
}

/** 创建 task 工具定义。必须传入注册表，让描述里包含可用 agent 列表。 */
export function createTaskTool(registry: SubAgentRegistry) {
  return tool({
    description: buildTaskToolDescription(registry),
    inputSchema: z.object({
      description: z.string().describe('A short (3-5 words) description of the task'),
      subagent_type: z.string().describe(`Which sub-agent to use. Available: ${registry.names().join(', ')}`),
      prompt: z
        .string()
        .describe(
          'The complete task instruction sent to the sub-agent. Be specific — the sub-agent has no prior context.',
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          'Start the sub-agent in the background and return immediately with a task id. Use for long independent work; the user can keep chatting. Progress appears in the background task panel.',
        ),
    }),
    // 无 execute —— 在 tool-execution.ts 里手动处理
  })
}
