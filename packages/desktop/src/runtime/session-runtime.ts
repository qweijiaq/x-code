// @x-code-cli/desktop — 单会话运行时状态
//
// AgentHost 仍然持有工作区级服务（bootstrap、MCP、设置、文件/ Git 访问）。
// 这个类只装“每个会话必须独立”的状态：消息循环、模型、当前 turn、审批、
// goal 活动。AgentHost 用 Map<sessionId, SessionRuntime> 让多个标签并行。
import type { LanguageModel, LoopState } from '@x-code-cli/core'

import type { ActiveTurn, PendingApproval } from './agent-host-support.js'
import { DEMO_MODEL_ID } from './bootstrap.js'

export class SessionRuntime {
  loopState: LoopState | null = null
  model: LanguageModel | null = null
  modelId = DEMO_MODEL_ID
  demo = true
  activeTurn: ActiveTurn | null = null
  controller: AbortController | null = null
  approvals = new Map<string, PendingApproval>()
  turnSeq = 0
  goalActivity: string | null = null
  goalEmitAt = 0
  shellUnsubscribe: (() => void) | null = null

  get sessionId(): string | null {
    return this.loopState?.sessionId ?? null
  }

  get busy(): boolean {
    return this.activeTurn !== null
  }
}
