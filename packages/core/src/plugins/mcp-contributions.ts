/** 从包裹式的 x-code 配置形状或 Claude Code 插件使用的扁平 `.mcp.json`
 *  形状中提取服务器块。当存在包裹键时，原样返回其值，好让 schema 校验能
 *  对畸形输入报告精确的错误。 */
export function extractMcpServersBlock(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  if ('mcpServers' in obj) return obj.mcpServers
  return obj
}
