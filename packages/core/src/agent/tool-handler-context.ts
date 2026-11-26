import type { ModelMessage } from 'ai'

import type { ToolHookSnapshot } from '../hooks/bus.js'
import type { PreparedPeerSend } from '../peers/service.js'
import type { PreparedShellRequest, ShellHookOrigin } from '../tools/shell-session/types.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import type { ToolImage } from './messages.js'
import type { SubAgentLoopRunner } from './sub-agents/runner.js'

export interface ToolExecutionControl {
  stopTurn: boolean
}

/** 权限、准备与分发阶段共享的可变每调用上下文。 */
export interface ToolHandlerContext {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  parentModel: LanguageModel
  runSubAgentLoop?: SubAgentLoopRunner
  control: ToolExecutionControl
  /** 本轮迭代的延迟消息队列（见 `processToolCalls`）。处理器需要注入一条
   *  `role: 'user'` 消息时必须推到这里，而不是直接改 `state.messages`——在两条
   *  tool-result 之间插入 user 消息会造出 `assistant → tool → user → tool` 的形状，
   *  DeepSeek 等严格顺序提供方会直接 400。 */
  deferred?: ModelMessage[]
  authorityApprovedOnce?: boolean
  preparedPeerSend?: PreparedPeerSend
  effectiveCwd?: string
  preparedShell?: PreparedShellRequest
  shellHookSnapshot?: ToolHookSnapshot
  shellPreToolUse?: ShellHookOrigin['preToolUse']
}

export type ToolHandler = (context: ToolHandlerContext) => Promise<void>

export type PushToolResult = (
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
  images?: readonly ToolImage[],
  notifyUi?: boolean,
) => void
