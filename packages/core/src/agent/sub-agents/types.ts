// @x-code-cli/core — 子代理类型定义
import type { TokenUsage } from '../../types/index.js'

export interface SubAgentDefinition {
  name: string
  description: string
  /** Markdown 正文 = 子代理的系统提示词 */
  prompt: string
  /** 允许的工具。省略或 `['*']` = 除 `task` 外的所有可用工具。 */
  tools?: string[]
  /** 显式拒绝的工具（在 `tools` 之后应用） */
  disallowedTools?: string[]
  /** 模型覆盖（如 "anthropic:claude-sonnet-5"）。省略 = 继承父级 */
  model?: string
  /** 强制停止前的最大代理轮数 */
  maxTurns: number
  /** 要拒绝的 shell 命令（关键词匹配）。仅当 tools 里含 shell 时才有意义 */
  shellRestrictions?: string[]
  /** 拒绝所有未被归类为只读的 shell 命令。 */
  shellReadOnlyOnly?: boolean
  /** 该定义来自哪里 */
  source: 'built-in' | 'user' | 'project'
  /** 当该子代理来自插件贡献时，所属插件的 id（`name@marketplace`）。 */
  pluginId?: string
}

export interface SubAgentTrace {
  toolCalls: Array<{
    toolName: string
    input: unknown
    result: string
    durationMs: number
    isError: boolean
  }>
  finalText: string
  tokenUsage: TokenUsage
  turnCount: number
}

export type SubAgentEvent =
  | { kind: 'start'; toolCallId: string; agentName: string; description: string; prompt: string }
  | { kind: 'tool-call'; toolCallId: string; subToolName: string; subInput: unknown }
  | {
      kind: 'tool-result'
      toolCallId: string
      subToolName: string
      resultPreview: string
      durationMs: number
      isError: boolean
    }
  | { kind: 'text-delta'; toolCallId: string; delta: string }
  | {
      kind: 'end'
      toolCallId: string
      finalText: string
      tokenUsage: TokenUsage
      turnCount: number
      durationMs: number
      aborted: boolean
    }
