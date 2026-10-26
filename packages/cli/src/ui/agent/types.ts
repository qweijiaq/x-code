import type {
  AgentLoopResult,
  AgentOptions,
  AuthorityApproval,
  AuthorityApprovalPreview,
  CacheMissSummary,
  DisplayMessage,
  ExecutionAuthority,
  GoalState,
  GoalVerifier,
  PermissionMode,
  StepStats,
  TodoItem,
  TokenUsage,
  UsageBreakdown,
} from '@x-code-cli/core'

import type { BackgroundTerminalView, ShellWaitStreak } from './shell-session-ui.js'
import type { TurnLease, TurnOwner } from './turn-coordinator.js'

export interface SubmitOptions {
  silent?: boolean
  toolFilter?: AgentOptions['toolFilter']
  maxTurns?: number
  signal?: AbortSignal
  /** 目标执行拥有它自己的提交序列，所以这里的空闲排水会与下一个目标回合竞争。 */
  skipIdleDrain?: boolean
  owner?: TurnOwner
  lease?: TurnLease
  authority?: ExecutionAuthority
  rawContent?: boolean
  peerInboxKeys?: readonly string[]
}

export type SubmitAgentInput = (text: string, options?: SubmitOptions) => Promise<AgentLoopResult | null>

export interface PendingPermission {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** 权限对话框使用的、已解析的 MCP 身份，而不是被混淆的工具名。 */
  mcp?: { serverName: string; rawName: string }
}

export interface PendingAuthority {
  requestId: number
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  preview: AuthorityApprovalPreview
  resolve: (approval: AuthorityApproval) => void
}

export interface PendingQuestion {
  question: string
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  resolve: (answer: string) => void
  /** 当活跃回合被中止时提供的值，让 agent 循环可以解除阻塞。 */
  abortAnswer: string
  /** 用户打开的选择器可以被关闭；模型问题必须收到一个显式回答。 */
  dismissible?: boolean
  layout?: 'compact' | 'compact-vertical'
}

/** 一个正在实时 UI 区域渲染的进行中工具调用。 */
export interface ActiveToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  progress?: string
  subToolHistory?: string[]
}

/** 一条在 agent 回合进行中排队等待的用户消息。 */
export interface QueuedMessage {
  id: string
  /** 在待处理列表中渲染、并提交到 scrollback 的文本。 */
  text: string
  /** 当与显示文本不同时，发送给模型的可选内容。 */
  inject?: string
}

export interface AgentState {
  messages: DisplayMessage[]
  isLoading: boolean
  activeToolCalls: ActiveToolCall[]
  shellOutput: string
  permissionQueue: PendingPermission[]
  authorityRequest?: PendingAuthority | null
  pendingQuestion: PendingQuestion | null
  /** 等待下一个工具边界或空闲排水的输入。 */
  queuedMessages: QueuedMessage[]
  /** 一次性的请求：在一个回合被中止后，把排队的文本恢复到输入框。 */
  restoredDraft: { text: string; nonce: number } | null
  usage: TokenUsage
  usageBreakdown: UsageBreakdown
  cacheMissSummary: CacheMissSummary
  error: string | null
  /** 实时模型标识符，从 agent ref 镜像过来用于 UI 更新。 */
  modelId: string
  /** 当前会话的实时审批模式。 */
  permissionMode: PermissionMode
  /** 由模型维护的实时检查清单。 */
  todos: TodoItem[]
  /** 让读取状态在连续的只读工具调用之间保持稳定。 */
  bufferingReads: boolean
  /** 当前的上下文压缩阶段，当压缩处于活跃状态时。 */
  compressionLabel: string | null
  /** 当前的本地附件处理阶段，包括模型下载进度。 */
  ingestLabel: string | null
  /** 瞬时的 provider 流恢复状态。 */
  reconnectLabel: string | null
  goalStatus: GoalState | null
  goalRunnerActive: boolean
  goalVerificationActive: boolean
  /** 在每次 agent 循环调用后记录的每步用量快照。 */
  stepStats: StepStats[]
  /** 从转录本派生的持久安全指示器。 */
  peerInfluenced?: boolean
  /** 从活跃 shell 事件中心投影出来的、仅显示用的状态。 */
  backgroundTerminals: BackgroundTerminalView[]
  shellWaitStreak: ShellWaitStreak | null
}

export interface RunGoalCommand {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  verifiers?: GoalVerifier[]
  requiresUserConfirmation?: boolean
}
