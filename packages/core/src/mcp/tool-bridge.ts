// @x-code-cli/core — MCP 工具 ↔ AI SDK 适配器
//
// 两个职责：
//   1. 把每个 McpToolEntry 转成 AI-SDK 的 `tool({...})` 定义，
//      使 streamText() 把它与内置工具一起宣告给模型。
//   2. 裁剪过长的服务器提供的描述，使它们不撑爆系统提示 / 工具列表。
//
// 这些工具刻意定义为没有 `execute` 函数。AI SDK 随后把模型的 tool_call 路由
// 进 `result.toolCalls`，我们的 `processToolCalls` 分派器手工处理它——与
// shell / writeFile / edit 同一路径。这正是我们能让每个 MCP 调用都经过
// 权限 + loop-guard 机制的原因。
import { jsonSchema, tool } from 'ai'

import type { McpToolEntry } from './types.js'

/** 每个工具面向模型描述长度的硬上限。
 *  - 200 字符对 "这工具干嘛的？" 指导足够了。
 *  - 野生的某些 MCP 服务器会把多段文档粘进 description 字段；不加限制
 *    会撑爆系统提示、耗尽 prompt 缓存窗口。
 *  - 截断按字符进行，带省略号标记，使模型知道字符串被裁剪了（该标记对
 *    服务器作者也有提示作用——他们在 /mcp tools 里看到自己的描述时）。 */
const DESCRIPTION_MAX_CHARS = 200

export function truncateDescription(input: string): string {
  if (input.length <= DESCRIPTION_MAX_CHARS) return input
  // 为省略号标记留出空间，使结果仍 <= 上限。
  return input.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…'
}

/** 把一个 MCP 工具适配成 AI SDK Tool。无 execute——我们在 tool-execution
 *  里手工分派。schema 作为原始 JSON Schema 直通（SDK 通过 `jsonSchema(...)`
 *  有一等支持，所以我们不需要 zod 转换步骤）。 */
export function bridgeMcpTool(entry: McpToolEntry) {
  return tool({
    description: truncateDescription(entry.description || `MCP tool from ${entry.serverName}`),
    // SDK 的 jsonSchema() 辅助器接受一个 JSON Schema 对象，产出与 `tool()`
    // 兼容的 Schema 实例。MCP 服务器按规范交回良构的 JSON Schema，所以无需
    // 预处理。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: jsonSchema(entry.inputSchema as any),
    // 无 execute——tool-execution.ts 里的手工分派让该调用经过权限 + loop-guard。
  })
}

/** 构建每个 MCP 工具的系统提示友好视图——简短描述 + 面向模型的名字。
 *  由 `system-prompt.ts` 用来渲染 `## MCP Tools` 段。 */
export function toSystemPromptEntries(entries: readonly McpToolEntry[]) {
  return entries.map((e) => ({
    callableName: e.callableName,
    serverName: e.serverName,
    description: truncateDescription(e.description),
  }))
}
