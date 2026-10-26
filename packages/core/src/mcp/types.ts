// @x-code-cli/core — MCP 公共类型
//
// mcp/ 子系统共享的形状。保持无依赖，使 loader/registry/UI 层能导入而不必
// 绕回 agent loop 或 CLI 造成循环。

/** stdio 型 MCP 服务器（本地子进程）。 */
export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 首次连接超时（毫秒）。默认 30_000。 */
  timeout?: number
  /** 默认 true。设为 false 则完全跳过该服务器。 */
  enabled?: boolean
}

/** Streamable HTTP MCP 服务器（远程）。 */
export interface McpHttpServerConfig {
  type?: 'http'
  url: string
  /** 附加到每个请求的静态头（例如 `X-Custom: foo`）。
   *  OAuth 的 `Authorization: Bearer ...` 会自动加上——不要把 access token
   *  放在这里，改走 OAuth 流程存储。 */
  headers?: Record<string, string>
  timeout?: number
  enabled?: boolean
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** 判别器：运行时区分 stdio 与 http 服务器。 */
export function isStdioConfig(c: McpServerConfig): c is McpStdioServerConfig {
  return 'command' in c
}
export function isHttpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return 'url' in c
}

/** 每个服务器的运行时状态。UI 经 /mcp list 读取它。 */
export type McpServerStatus =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; resourceCount: number }
  | { kind: 'needs_auth'; authUrl?: string }
  | { kind: 'failed'; error: string }

/** 一个 MCP 工具，名字改写之后。
 *
 *  callableName 是面向模型的名字（<server>__<tool>）；
 *  rawName 是我们回传给 client.callTool 的名字——MCP 服务器不知道我们的
 *  前缀方案。 */
export interface McpToolEntry {
  callableName: string
  rawName: string
  serverName: string
  description: string
  /** 从服务器收到的 JSON Schema。我们经 `jsonSchema(...)` 直接传给 AI SDK
   *  ——不做 zod 转换。 */
  inputSchema: Record<string, unknown>
  /** MCP 工具注解（readOnlyHint、destructiveHint 等）外加任何厂商扩展。
   *  我们读两个自定义键：
   *  - `alwaysLoad: true` → 永不延迟此工具（始终在 tools 数组里）
   *  - `searchHint: string` → 提升 toolSearch 召回率的额外关键词 */
  annotations?: Record<string, unknown>
}

/** 一个 MCP 资源（服务器允许我们拉取的数据）。 */
export interface McpResourceEntry {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverName: string
}

/** 调用一个 MCP 工具的结果——从 MCP 的 content-blocks 拍平，成为我们能塞进
 *  tool_result 消息的东西。文本块拼进 `text`；图像块单独呈现在 `images` 上，
 *  使具备视觉能力的模型真能看到它们（例如浏览器截图）。 */
export interface McpCallResult {
  /** 适合 tool_result 的文本表示。 */
  text: string
  /** 当且仅当服务器把该调用标记为错误（MCP `isError` 标志）时为 true。 */
  isError: boolean
  /** 工具返回的图像内容块（base64 数据 + IANA 媒体类型）。常见纯文本结果
   *  下缺省 / 为空。provider 兼容性决定它们留在 tool 结果里、移到下一条用户
   *  消息，还是变成文本回退。 */
  images?: Array<{ data: string; mediaType: string }>
}
