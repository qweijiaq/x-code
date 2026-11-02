// @x-code-cli/core — 外部内容 taint 策略
//
// webFetch / webSearch / readDocument / MCP 的返回是模型上下文里唯一不来自
// 用户或本地的输入。它们可能包含间接提示注入，因此一旦进入本轮上下文，后续的
// 写入/shell 类工具必须重新经过用户批准（策略为 `approve`）。
//
// 这是一个显式策略而不是默认行为：默认 `off` 保持现有工作流，启用后只影响
// 高风险的写操作，读取类工具仍按原权限模型执行。

export type ExternalContentPolicy = 'off' | 'approve'

/** 会把外部内容带进模型上下文的工具。 */
export const EXTERNAL_CONTENT_TOOLS = new Set(['webFetch', 'webSearch', 'readDocument'])

/** taint 后需要重新批准的破坏性工具。 */
export const TAINT_SENSITIVE_TOOLS = new Set([
  'shell',
  'writeFile',
  'edit',
  'batchRename',
  'documentExport',
  'spreadsheet',
])

export interface ExternalContentState {
  policy: ExternalContentPolicy
  tainted: boolean
  /** 触发 taint 的工具名，用于审批说明。 */
  sources?: string[]
}

export function shouldRequireExternalContentApproval(
  policy: ExternalContentPolicy | undefined,
  tainted: boolean | undefined,
  toolName: string,
): boolean {
  return policy === 'approve' && tainted === true && TAINT_SENSITIVE_TOOLS.has(toolName)
}

export function isExternalContentTool(toolName: string): boolean {
  return EXTERNAL_CONTENT_TOOLS.has(toolName)
}

export interface ExternalContentTarget {
  externalContentTainted?: boolean
  externalContentSources?: string[]
}

/** 把一次外部工具结果记到当前轮次；同一来源只记录一次。 */
export function markExternalContent(target: ExternalContentTarget, toolName: string): void {
  if (!isExternalContentTool(toolName)) return
  target.externalContentTainted = true
  const sources = new Set(target.externalContentSources ?? [])
  sources.add(toolName)
  target.externalContentSources = [...sources]
}

/** 从一轮响应消息里扫描 SDK 自动执行的工具结果（webFetch 等不经过 pushToolResult）。 */
export function markExternalContentFromMessages(
  target: ExternalContentTarget,
  messages: readonly { content: unknown }[],
): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const record = part as { type?: unknown; toolName?: unknown }
      if (record.type === 'tool-result' && typeof record.toolName === 'string') {
        markExternalContent(target, record.toolName)
      }
    }
  }
}

/** 把子代理读入的外部内容传播给父级；子代理的写操作即使被拒绝，读入事实仍然成立。 */
export function propagateExternalContent(
  parent: ExternalContentTarget,
  child: ExternalContentTarget,
  agentName?: string,
): void {
  if (child.externalContentTainted !== true) return
  parent.externalContentTainted = true
  const sources = new Set(parent.externalContentSources ?? [])
  for (const source of child.externalContentSources ?? []) sources.add(source)
  if (agentName) sources.add(`subagent:${agentName}`)
  parent.externalContentSources = [...sources]
}
