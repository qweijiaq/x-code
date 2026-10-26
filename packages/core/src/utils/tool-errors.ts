// @x-code-cli/core — 共享的工具错误格式化
//
// 所有 `tool({ execute })` 主体都遵循同一模式：捕获 unknown，提取字符串消息，
// 并返回 `Error <action>: <msg>`。集中在这里能保持措辞一致，并去掉约 7 份
// `err instanceof Error ? err.message : String(err)` 片段。

function toErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current instanceof Error && messages.length < 6 && !seen.has(current)) {
    seen.add(current)
    if (current.message && !messages.includes(current.message)) messages.push(current.message)
    current = current.cause
  }

  if (messages.length <= 1) return messages[0] ?? err.name
  return `${messages[0]} (cause: ${messages.slice(1).join(' → ')})`
}

/** 把工具失败格式化为面向用户的字符串，模型会将其视作工具结果。`action`
 *  是一个简短动词短语（如 "reading file"、"searching"）。 */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}
