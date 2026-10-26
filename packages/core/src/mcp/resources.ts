// @x-code-cli/core — MCP Resources 呈现为两个内置工具
//
// MCP "resources" 是服务器暴露的、模型可能想拉取的数据
// （例如 filesystem-server 暴露的文件、日志条目、DB 行转储）。
// 与其把每个资源自动注入对话（费 token，常常无关），我们暴露两个工具：
//
//   - listMcpResources({ server? })  — 枚举模型可获取的 URI
//   - readMcpResource({ uri })       — 按 URI 获取一个
//
// 两个工具都定义为没有 `execute` 函数，所以 agent loop 的 processToolCalls
// 分派器会处理它们——见 tool-execution.ts 中的 BYPASS_LOOP_GUARD_HANDLERS。
// 只有当配置了 MCP registry 时它们才出现在系统提示里（buildTools 门禁其
// 包含）。
import { tool } from 'ai'

import { z } from 'zod'

export const listMcpResources = tool({
  description: `List resources exposed by connected MCP servers.

Output one resource per line: "<uri>\t[<server>] <name> (<mimeType>)" with a description on the next indented line when present.

Use this BEFORE readMcpResource so you have a URI to read. If the model already knows the URI (e.g. from a previous list call), readMcpResource directly is fine.`,
  inputSchema: z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter by. Omit to list resources from all servers.'),
  }),
  // 无 execute——在 tool-execution.ts 中经 BYPASS_LOOP_GUARD_HANDLERS 处理。
})

export const readMcpResource = tool({
  description: `Read the contents of an MCP resource by its URI.

URIs come from listMcpResources. Text resources return their text directly; binary resources surface a one-line marker noting the omitted content.`,
  inputSchema: z.object({
    uri: z.string().describe('The resource URI to read, as returned by listMcpResources.'),
  }),
})
