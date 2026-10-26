// @x-code-cli/core — `toolSearch` 内建工具：延迟工具的发现入口
//
// 一个条件注册的工具（和 task / activateSkill 一样 —— 不在静态
// toolRegistry 里）。buildTools 只把它加给顶层 agent，而且只在存在可搜索的
// 延迟目录时才加。它一旦存在就始终直接加载：它是加载其它一切的入口，若再
// 延迟它，模型就会被困在延迟集合里出不来。
//
// 定义时没有 `execute`，由 processToolCalls 经 BYPASS_LOOP_GUARD_HANDLERS
// 手动分发（模型每个任务合法地会搜索多次；loop guard 只会碍事）。分发与
// 目录匹配在 agent/tool-search/ 里实现 —— 本文件只是叶子定义（零 agent-loop
// 依赖），保持与其它 tools/ 文件相同的分层。
import { jsonSchema, tool } from 'ai'

export const TOOL_SEARCH_TOOL_NAME = 'toolSearch'

const DESCRIPTION = `Load deferred tools listed by name in the system prompt. Use capability keywords to find matches, or \`select:<exact_name>,<exact_name>\` when you know the names. Their schemas become callable on the next step. Do not search for tools already present in the current tool list.`

export const toolSearch = tool({
  description: DESCRIPTION,
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to find deferred tools, or "select:<name>,<name>" to load exact tools by name.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of tools to return (default 5).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  // 无 execute —— 在 tool-execution.ts 里手动分发（BYPASS_LOOP_GUARD_HANDLERS）。
})
