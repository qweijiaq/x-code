// ChatInput 公开 + 内部数据类型。
import type { AuthorityApprovalPreview, DisplayMessage, PermissionDecision, TodoItem } from '@x-code-cli/core'

import type { ShellWaitStreak } from '../agent/shell-session-ui.js'
import type { TurnOwner } from '../agent/turn-coordinator.js'
import type { ActiveToolCall } from '../agent/types.js'

export interface ChatInputProps {
  messages: readonly DisplayMessage[]
  initialContentRows?: number
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onEscapeCancel?: () => void
  isLoading?: boolean
  notice?: string | null
  peerInfluenced?: boolean
  trustMode?: boolean
  pendingPeerCount?: number
  disabled?: boolean
  hidden?: boolean
  spinner?: SpinnerState | null
  activeTurnOwner?: TurnOwner | null
  hasStableForkBoundary?: boolean
  activeToolCalls?: readonly ActiveToolCall[]
  shellWaitStreak?: ShellWaitStreak | null
  backgroundTerminalCount?: number
  backgroundTerminalWarningCount?: number
  todos?: readonly TodoItem[]
  queuedMessages?: readonly { id: string; text: string }[]
  onPopQueued?: (id: string) => void
  draftRestore?: { text: string; nonce: number } | null
  errorMessage?: string | null
  permission?: PermissionRequest | null
  authorityRequest?: AuthorityRequest | null
  selectRequest?: SelectRequest | null
  commands?: readonly SlashCommand[]
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  contextUsage?: { used: number; window: number } | null
  modelLabel?: string
}

/** 斜杠补全菜单里的一行。顶层命令行和子命令行都通过这个形态渲染——展示列用
 *  `name`/`description`，但接受路径用 `applyText`，这样子命令行
 *  （`{ name: 'auth', applyText: '/mcp auth' }`）能正确地替换整个输入。 */
export interface MenuItem {
  name: string
  description: string
  applyText: string
  /** 菜单里 `name` 之后显示的暗色后缀（例如 `/thinking` 的 `[on|off]`）。只为
   *  第一阶段行填充；子命令行不携带它，因为描述列已经解释了形态。 */
  argumentHint?: string
}

export interface SlashCommand {
  name: string
  description: string
  /** 斜杠菜单里命令名之后显示的灰色占位符。示例：`argumentHint: '[on|off]'` 让
   *  菜单行显示为 `/thinking [on|off]  Toggle extended thinking ...`。供那些接收
   *  参数但没有固定可枚举子命令的命令使用（例如 `/model <model-id>`、
   *  `/review [PR]`）。 */
  argumentHint?: string
  /** 固定可枚举的子命令。存在时，输入 `/cmd `（带尾随空格）或 `/cmd <prefix>` 会
   *  在 `subcommands` 上弹出第二阶段的模糊菜单——与顶层命令菜单同样的 UI。留给那些
   *  有许多离散第二词、容易忘的命令（`/mcp` 有 8 个）。 */
  subcommands?: ReadonlyArray<{ name: string; description: string }>
}

interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: PermissionDecision) => void
  /** 当工具解析为 MCP 注册表条目时由 use-agent 设置。驱动对话框里 MCP 风格的标题
   *  / 预览 / always-allow 标签。内置工具（shell/edit/writeFile/…）没有此字段。 */
  mcp?: { serverName: string; rawName: string }
}

interface AuthorityRequest {
  requestId: number
  toolName: string
  preview: AuthorityApprovalPreview
  onResolve: (allow: boolean) => void
}

interface SelectRequest {
  question: string
  /** `freeform: true` 标记自动追加的「Other」行，它会打开一个内联文本输入，而不是
   *  用字面标签来解析。仿照 Claude Code 的 `__other__` 哨兵——这里保留为标志，让解
   *  析器直接返回输入的文本，无需一次哨兵往返。
   *
   *  `preview` 携带预渲染的 ANSI 行，当该选项是聚焦项时，对话框会在选项列表下方
   *  画出这些行。供 `/theme` 选择器在用户上下翻动时显示每个主题的实时色样。每一行
   *  应该已经是完整的 ANSI 样式字符串——对话框把它包进类似 `RawAnsi` 的单元格行，
   *  不再做进一步处理。 */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  onResolve: (answer: string) => void
  /** 对用户发起的选择器（如 `/theme`、`/model` 这类斜杠命令）为真——Esc 以空答案
   *  关闭对话框。AI 发起的对话框（askUser 工具、plan 审批）让此字段为假：Esc 被吞
   *  掉，避免模型被静默喂一个空答案。 */
  dismissible?: boolean
  /** 控制带描述的选项如何渲染：
   *  - `compact`（默认）：标签和描述在同一行，右对齐成两列。适合短标签。
   *  - `compact-vertical`：描述在标签下方单独缩进一行。适合长描述（askUser）。 */
  layout?: 'compact' | 'compact-vertical'
}
