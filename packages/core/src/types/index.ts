// @x-code-cli/core — 公共类型定义
import type { LanguageModel, ModelMessage, UserContent } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { MemoryService } from '../knowledge/memory/service.js'
import type { MemoryWriteNotice } from '../knowledge/memory/types.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PeerService } from '../peers/service.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SkillRegistry } from '../skills/registry.js'

// ─── 权限 ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

/** 当前会话的审批模式。
 *
 *    'default'      — 常规流程：写工具询问，模型可调用任何工具。
 *    'plan'         — 只读模式：模型被告知（通过系统提示词
 *                     覆盖层）去探索并把计划写到会话本地
 *                     计划文件，但不做其他编辑。执行是
 *                     基于提示词的 —— 与 Claude Code 一致，没有硬性的
 *                     权限层阻断 —— 因此不听话的模型
 *                     在 write/edit/shell 上仍会触发常规的 `ask` 提示。
 *    'acceptEdits'  — 写工具（writeFile / edit）无需询问自动批准；
 *                     shell 仍走常规分类（always-allow / ask / deny），
 *                     因此破坏性命令仍被门控。适合计划刚被批准之后 ——
 *                     用户已审核过计划，实现过程中每次 writeFile
 *                     都要点一次 "Yes" 纯粹是摩擦。exitPlanMode 批准时
 *                     会自动切换到这个模式。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

/** 权限提示返回的用户决策。对象形式是携带用户自由文本反馈的
 *  拒绝（kimi-cli 的“带反馈拒绝”）—— core 把它附加到拒绝的工具结果上，
 *  这样模型能调整下一次尝试，而不是猜测为何被拒绝。 */
export type PermissionDecision = 'yes' | 'always' | 'no' | { kind: 'deny'; feedback: string }

// ─── 执行权威与转录来源 ───

export interface PeerOrigin {
  instanceId: string
  nameAtReceipt: string
  messageId: string
}

export interface PeerOriginSummary {
  items: PeerOrigin[]
  totalCount: number
  digest: string
  truncated: boolean
}

export type MessageAuthority = 'user' | 'peer' | 'internal'

export interface MessageProvenance {
  authority: MessageAuthority
  derivedFromPeer: boolean
  peerOrigins?: PeerOriginSummary
}

export interface TrackedModelMessage {
  entryId: string
  message: ModelMessage
  provenance: MessageProvenance
}

export interface ContextSecurityState {
  peerInfluenceActive: boolean
  firstTaintedEntryId?: string
  peerOrigins?: PeerOriginSummary
  integrityFailure?: boolean
}

export interface ExecutionAuthority {
  source: 'user' | 'peer'
  peerTainted: boolean
  peerOrigins?: PeerOriginSummary
}

export type ToolCapability =
  | 'pure-compute'
  | 'session-metadata-read'
  | 'content-read'
  | 'sensitive-read'
  | 'network-egress'
  | 'peer-egress'
  | 'opaque-mcp'
  | 'local-mutation'
  | 'configuration-change'
  | 'unknown'

export interface AuthorityApprovalPreview {
  toolName: string
  serverId?: string
  paths?: string[]
  destination?: string
  summary: string
  outboundPayload?: {
    format: 'text' | 'canonical-json' | 'shell-command'
    canonical: string
    byteLength: number
    sha256: string
  }
  complete: boolean
  approvable: boolean
  reason?: string
  authorityHash: string
  canonicalCallSha256: string
}

export interface ClassifiedToolCall {
  capabilities: readonly ToolCapability[]
  approvalPreview: AuthorityApprovalPreview
}

export type AuthorityDecision =
  | {
      kind: 'allow'
      basis: 'pure-compute' | 'session-metadata' | 'user-authority' | 'user-approval-once'
    }
  | { kind: 'ask'; reason: string; preview: AuthorityApprovalPreview }
  | { kind: 'deny'; reason: string }

export interface AuthorityApproval {
  decision: 'allow-once' | 'deny'
  /** @deprecated 负载分页不再作为本地审批的门控。 */
  viewedComplete?: boolean
  canonicalPayloadSha256?: string
  canonicalCallSha256: string
  authorityHash: string
}

export interface PublicPeer {
  name: string
  address: `peer:${string}`
  cwd: string
  status: 'idle' | 'busy' | 'waiting'
  busyKind?: 'interactive-turn' | 'goal' | 'maintenance'
  startedAt: string
  sessionId?: string
}

export type QueuedAgentInput =
  | { id: string; source: 'user'; display: string; content: string }
  | {
      id: string
      source: 'peer'
      display: string
      content: string
      peer: PublicPeer
      messageId: string
      /** 服务拥有的入站台账键。仅在队列/生命周期交接内部使用，
       *  绝不包含在模型可见的内容中。 */
      inboxKey?: string
    }

// ─── 待办列表（TodoWrite 工具）───

/** 模型工作清单上的单个条目。
 *
 *    content    — 任务的祈使句表述（"Update auth handler"）
 *    activeForm — 用于实时指示的现在进行时表述
 *                 （"Updating auth handler"）；当状态为
 *                 'in_progress' 时显示在 UI 中，让用户看到
 *                 代理此刻在做什么。
 *    status     — 'pending' | 'in_progress' | 'completed'。
 *
 *  逐字镜像 Claude Code 的 TodoWrite 负载形状。仅内存持久化
 *  （LoopState.todos），每会话一份，不落盘。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

// ─── Token 用量 ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 读取的缓存提示词 token（Anthropic cache_read、OpenAI cached_tokens 等）。
   *  按正常输入费率的一部分计费 —— 比例取决于提供商。
   *  已计入 `inputTokens`；此字段纯属信息性。 */
  cacheReadTokens: number
  /** 写入提供商侧缓存的 token（Anthropic cache_creation_input_tokens）。
   *  按高于正常输入费率的溢价计费，但为后续轮次解锁廉价的读取。
   *  在不区分创建与读取的提供商上为零。 */
  cacheCreationTokens: number
  /** 当前上下文窗口占用 —— 最近一次 API 响应的
   *  `input_tokens + output_tokens`（`inputTokens` 已包含 cache_read
   *  + cache_write，因为 AI SDK v6 把它们归一为一个字段）。与上面
   *  的累计字段不同，这是一个快照 —— 每轮覆盖，而非累加。
   *  驱动页脚的 "N / M · X%" 指示。
   *
   *  为什么是 input + output（与每个提供商的定义一致）：
   *  每个主流 LLM API —— Anthropic、OpenAI、Google Gemini、DeepSeek、
   *  Moonshot、Alibaba、xAI —— 都把“上下文窗口”定义为 input + output 的
   *  共享预算池，`input + output ≤ context_window` 是架构约束
   *  （单个 KV-cache 上限）。页脚里只显示 input 会是另一个数字，
   *  与用户阅读提供商文档时看到的模型上下文窗口不符。上面的
   *  累计字段仍保留给 `/usage` 账单摘要。 */
  currentContextTokens: number
}

// ─── 显示消息 ───

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DisplayToolCall[]
  timestamp: number
  /** 对在流中段发出的助手文本块为 true（每个换行一个）。
   *  渲染时不带常规消息追加的尾部空行，
   *  因此连续的块在视觉上连成单个段落。通过把每个完整行
   *  直接发往滚动区，让流式文本远离底部单元格缓冲区
   *  （避免行位移抖动）。 */
  streamingChunk?: boolean
  /** 紧凑的斜杠命令渲染，匹配 Claude Code 的两行块：
   *    > /model
   *      ⎿  Set model to Sonnet 4.6
   *  'command-echo'（user 角色）去掉常规用户消息追加的尾部空行；
   *  'command-result'（assistant 角色）用 ⎿ 前缀和单个尾部换行渲染，
   *  而非 markdown + \n\n。仅用于简短的单行命令响应。
   *  较长的多行输出（/help、/usage）仍走常规的助手消息路径。 */
  kind?: 'command-echo' | 'command-result' | 'peer-message' | 'peer-status'
  peer?: {
    name: string
    address: string
    summary?: string
  }
}

export interface DisplayToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  /** `error` 标记一个已结束但以非零退出 / 抛出异常收尾的工具 ——
   *  stdout 写入器把其结果体渲染为红色，让失败在滚动区中醒目。
   *  `denied` 保留给权限拒绝路径。 */
  status: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  /** 工具调用执行耗时（毫秒） */
  durationMs?: number
  /** writeFile / edit 产生的结构化补丁 —— 驱动滚动区工具条目下方的
   *  彩色 diff 块。非编辑类工具、水合的历史记录（会话恢复时不重算），
   *  以及实际上没有效果的编辑（oldContent === newContent）都没有此字段。 */
  editPayload?: EditDiffPayload
}

// ─── 代理回调（core → UI 桥接）───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  /** 工具运行时发出的流式进度消息（如
   *  "Searching: query" → "Found 5 results"）。实时 UI 中只显示最新
   *  一条消息；最终摘要经 onToolResult 传递。 */
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  /** 可选。在成功的 writeFile / edit 的 `onToolResult` 之前触发，
   *  携带结构化补丁 + 行数，这样 UI 能在工具条目下方渲染 diff 块。
   *  权限被拒 / 出错的写入（文件实际未变化）以及产生相同文件的
   *  无效果编辑会跳过此回调。 */
  onFileEdit?: (toolCallId: string, payload: EditDiffPayload) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<PermissionDecision>
  /** 受 peer 影响的调用使用独立的、仅允许一次的表面。该
   *  回调把本地决策绑定到完整的规范预览及其哈希；
   *  缺失此回调即为失败关闭（拒绝）。 */
  onAskAuthority?: (request: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    preview: AuthorityApprovalPreview
  }) => Promise<AuthorityApproval>
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  /** 由 `exitPlanMode` 触发。resolve `true` 表示退出计划模式、
   *  让模型开始实现；resolve `false` 表示拒绝该计划、
   *  让模型继续留在计划模式中迭代。 */
  onPlanApprovalRequest: (planText: string) => Promise<boolean>
  /** 每当 permissionMode 翻转时触发，让 UI 重新同步底部
   *  指示器，并（持久化时）把新值写入用户配置。 */
  onPlanModeChange: (mode: PermissionMode) => void
  /** 在模型调用 `todoWrite` 后触发，让 UI 能显示当前清单。
   *  每次调用都传完整列表（todoWrite 是全量替换工具，而非增量）——
   *  UI 只需存下来。 */
  onTodosUpdate: (todos: TodoItem[]) => void
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  /** 在上下文压缩的每个阶段边界触发，让 UI 能显示
   *  跟踪进度的 spinner 标签。 */
  onCompressionProgress?: (description: string) => void
  /** 瞬态的流重连状态。null 事件表示提供商数据已恢复
   *  或重试序列已结束。 */
  onStreamRetry?: (event: StreamRetryEvent | null) => void
  onError: (error: Error) => void
  /** 由子代理运行器触发，用于流式传递子代理循环的进度。
   *  CLI UI 用这些事件构建折叠 / 展开的任务块。 */
  onSubAgentEvent?: (event: SubAgentEvent) => void
  /** 可选的、来自持久记忆工作线程的程序化遥测。CLI
   *  有意保持此项未设置，让后台持久化保持静默。 */
  onMemoryWrite?: (notice: MemoryWriteNotice) => void
}

export interface StreamRetryEvent {
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: 'network' | 'idle-timeout'
}

// ─── 代理选项 ───

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  /** 单次 `agentLoop` 调用内迭代次数的硬上限。省略时，
   *  循环无轮次上限运行 —— 用户的 Esc / Ctrl+C
   *  是唯一的停止方式。子代理和 `--print` 模式是真正
   *  传值的两个调用方；交互式会话保持未设置。 */
  maxTurns?: number
  printMode: boolean
  /** 为 true 时，代理循环选择每个提供商支持的最大推理量
   *  （映射见 providers/thinking.ts）。
   *  以 `thinking: boolean` 持久化在 `~/.x-code/config.json` 中，
   *  运行时通过 `/thinking on|off` 切换。默认 false。 */
  thinking?: boolean
  /** 实验性的工具集策略。默认 full。 */
  toolProfile?: 'full' | 'standard'
  /** 根代理是否可运行一次性本地浏览器视觉检查。
   *  默认 true，与交互式浏览器子代理相互独立。 */
  browserVisualCheckEnabled?: boolean
  /** 会话的初始权限模式。默认 'default'。
   *  由 `--plan` CLI 标志或 `loadUserConfig().permissionMode` 设置。 */
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal
  /** 显式的调用权威。即使调用方不小心在这里传入干净值，
   *  循环也始终把持久的上下文污染作为上限应用。 */
  executionAuthority?: ExecutionAuthority
  /** 提供商流断开时的应用层重试预算。 */
  streamMaxRetries?: number
  /** 请求被视作过期之前，流块之间允许的静默时间。
   *  零表示关闭看门狗。 */
  streamIdleTimeoutMs?: number

  // ── 子代理支持 ──

  /** 用于解析子代理模型覆盖的提供商注册表。
   *  由 CLI 在启动时注入。缺失 = 子代理继承父模型
   *  （没有独立的模型选择）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel }
  /** 请求边界钩子，用于在进程外认证变更后替换活跃提供商。
   *  调用方只有在能使用返回的模型后，才可调用 `onApplied`。 */
  beforeModelRequest?: (currentModelId: string) => Promise<{
    blockedMessage?: string
    model?: LanguageModel
    modelId?: string
    notice?: string
    onApplied?: () => void
  } | void>
  /** 子代理注册表。CLI 在启动时扫描内置 + 自定义代理定义后注入。
   *  缺失 = 不注册 task 工具（无子代理支持）。 */
  subAgentRegistry?: SubAgentRegistry
  /** 工具允许/拒绝过滤器。子代理循环用它限制子代理能调用哪些
   *  工具。`task` 始终在 `deny` 中。 */
  toolFilter?: { allow?: string[]; deny?: string[] }
  /** 在权限检查之前就要拒绝的 shell 命令关键词。用于工具面包含
   *  shell 但必须保持只读的子代理。 */
  shellRestrictions?: readonly string[]
  /** 无需提示即拒绝非只读的 shell 命令。用于绝不能改动
   *  被检状态的独立验证代理。 */
  shellReadOnlyOnly?: boolean

  /** 工具名后缀：每次请求前把较早的结果折叠为一个占位符
   *  （只保留最新一条），从而阻止大型的、完全被取代的负载 ——
   *  浏览器无障碍快照和截图 —— 每轮都重新计费。由浏览器子代理设置；
   *  未设置（默认）表示不折叠。按后缀匹配，这样 'browser_snapshot'
   *  这样的原始 MCP 名能命中被改写过的可调用名。 */
  collapseStaleToolResults?: readonly string[]

  // ── 技能支持 ──

  /** 技能注册表，由 createSkillRegistry 在 CLI 启动时填充。
   *  缺失表示未配置技能 —— 不注册 activateSkill 工具，且系统提示词中
   *  省略 `## Available Skills` 一节。 */
  skillRegistry?: SkillRegistry

  // ── MCP 支持 ──

  /** MCP 注册表，由 loadMcpServers 在 CLI 启动时填充。缺失表示
   *  MCP 完全禁用（没有配置任何服务器）—— 代理循环短路所有
   *  MCP 机制。注册表本身在会话生命周期内不可变；`/mcp refresh`
   *  会在下一次进入 agentLoop 时替换整个对象。 */
  mcpRegistry?: McpRegistry
  /** MCP 工具调用的权限存储。每个 CLI 进程创建一次，缓存持久化的
   *  always-allow 列表 + 会话范围的允许项。
   *  缺失 ⇒ 工具执行回退为每次都询问的语义。 */
  mcpPermissionStore?: McpPermissionStore
  /** 后台 MCP 连接完成（异步启动第二阶段）时由 CLI 触发。
   *  代理层用它使 `systemPromptCache` + `deferredCatalog` 失效，
   *  让下一轮能获取到新可用的 MCP 工具。 */
  onMcpReady?: () => void

  // ── 插件支持 ──

  /** 插件注册表，由 loadAllPlugins 在 CLI 启动时填充。持有每个
   *  成功加载的插件（启用 + 禁用），暴露出来让 `/plugin ...` 斜杠
   *  命令族能列出 / 查看 / 切换而无需重新扫描缓存。插件贡献
   *  （skills / agents / mcp）已由 CLI 启动接线合并进各自的
   *  注册表 —— 此字段只是斜杠命令 UI 的元数据表面。
   *  缺失 ⇒ 插件被禁用（`--no-plugins`）或未安装任何插件。 */
  pluginRegistry?: PluginRegistry

  /** 由启用插件的 `hooks` 贡献构建的钩子总线。代理循环通过它发出
   *  SessionStart / UserPromptSubmit / TurnComplete / SessionEnd 事件；
   *  工具执行再补充 PreToolUse / PostToolUse。缺失 ⇒ 不发出钩子
   *  （代理循环完全跳过这些发出点）。测试 / 子代理应使用
   *  `emptyHookBus()`，让它们可以调用这些发出点但没有任何监听器。 */
  hookBus?: HookBus

  /** 基于文件的斜杠命令注册表，由插件贡献的 `commands/` 目录构建。
   *  App.tsx 的默认斜杠分发器在内置命令列表和技能注册表之后检查它；
   *  在这里匹配到名字会展开命令体（做 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT}
   *  替换）并作为模型提示词提交。缺失 ⇒ 没有可用的插件命令。 */
  commandRegistry?: CommandRegistry

  // ── 轮次中的用户消息队列（转向）──

  /** 循环运行期间排队的用户消息的排出回调。代理循环在安全边界
   *  调用它 —— 一批工具结束后（下一次 API 请求之前）以及 `stop`
   *  结束时 —— 并把返回的输入作为一条合并的用户消息（包裹
   *  “你工作时发来的”标记）注入 `state.messages`。
   *  必须有排出语义：返回当前队列内容并原子地清空它，
   *  这样一条消息绝不会被注入两次。没有排队内容时返回
   *  undefined/空。缺失 ⇒ 轮次中排队被禁用（子代理、--print）。
   *  镜像 Codex 的 steer_input 和 Claude Code 的优先级 'next' 队列消费。 */
  consumeQueuedInputs?: () => QueuedAgentInput[] | undefined

  /** 通过与普通提交相同的附件管道解析本地排队的用户输入。
   *  仅在队列被原子排空后、对用户来源的条目调用；peer 输入必须
   *  保持为转义的纯文本。 */
  prepareQueuedUserInput?: (input: string) => Promise<UserContent>

  /** 进程持有的 peer 服务。仅当启动时显式启用了跨会话消息时
   *  出现在根代理上。 */
  peerService?: PeerService

  /** 全局 Memory v2 服务。仅出现在根代理上。 */
  memoryService?: MemoryService
}

export interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string
  keyResults: string[]
  pendingWork: string[]
  filesModified: string[]
  decisions: string[]
}

// ─── 再导出 AI SDK 类型 ───

export type { ModelMessage, LanguageModel }

// ─── 再导出子代理类型 ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
