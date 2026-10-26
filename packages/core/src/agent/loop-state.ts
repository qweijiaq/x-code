// @x-code-cli/core — 共享的 agent 循环状态
import type { ModelMessage } from 'ai'

import type { MemoryRecallAttachment, MemoryRecallTombstone, MemoryRecallTrace } from '../knowledge/memory/types.js'
import type { ReadFileCache } from '../tools/read-file.js'
import { UnifiedShellSessionManager } from '../tools/shell-session/manager.js'
import type { ManagedShellProvider } from '../tools/shell-session/provider.js'
import { getManagedShellProvider } from '../tools/shell-session/providers/index.js'
import type { ShellSessionController } from '../tools/shell-session/types.js'
import type {
  ContextSecurityState,
  ExecutionAuthority,
  PermissionMode,
  TodoItem,
  TokenUsage,
  TrackedModelMessage,
} from '../types/index.js'
import { generateTimestampId } from '../utils.js'
import { createCacheMissSummary } from './cache-stats.js'
import type { CacheMissReason, CacheMissSummary, ProviderTurnUsage } from './cache-stats.js'
import type { GoalInput, GoalState } from './goal/types.js'
import type { CheckpointEntry } from './snapshot.js'
import type { DeferredToolEntry } from './tool-search/catalog.js'
import { createModelMessageView, replaceTrackedMessages } from './tracked-messages.js'
import { createUsageBreakdown } from './usage.js'
import type { UsageBreakdown } from './usage.js'

/** 每次用户提交的 token 快照。每次 `agentLoop` 调用推入一条记录，
 *  记下该步的增量 token 和工具调用。持久化到会话 jsonl，好让
 *  `/resume` 恢复完整的步骤历史。 */
export interface StepStats {
  /** 用户消息的前 80 个字符 */
  prompt: string
  /** 本步消耗的输入 token（增量，非累计） */
  inputTokens: number
  /** 本步消耗的输出 token（增量，非累计） */
  outputTokens: number
  /** 本步的 API 轮次（streamText 轮）数量 */
  turnCount: number
  /** 本步派发的工具调用数量 */
  toolCallCount: number
  /** 本步开始的 ISO 时间戳 */
  startedAt: string
}

export interface CheckpointFileCacheEntry {
  size: number
  mtimeMs: number
  hash: string
}

export interface LoopState {
  /** 规范转录。消息对象与其 provenance 总是一起移动；下面的 `messages`
   *  是一个无存储的兼容投影。 */
  trackedMessages: TrackedModelMessage[]
  messages: ModelMessage[]
  contextSecurity: ContextSecurityState
  executionAuthority: ExecutionAuthority
  /** 最后完整提交的转录 epoch。undefined 表示一条新的或旧式转录，
   *  其首次变更必须是一个根快照。 */
  committedTranscriptEpochId?: string
  transcriptIntegrity: 'clean' | 'legacy' | 'failed'
  transcriptRequiresSnapshot: boolean
  /** buildTools 剥离 `execute` 时会捕获手动工具体；这保证在每个携带数据的
   *  工具执行之前都进行 authority 评估。 */
  manualToolExecutors: Map<
    string,
    (input: Record<string, unknown>, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>
  >
  tokenUsage: TokenUsage
  /** 以两种方式索引的累计用量。source 和 model 是同一批请求的并行视图，
   *  绝不能相加。 */
  usageBreakdown: UsageBreakdown
  /** 最近一次 API 响应报告的真实输入 token 数，用于触发压缩。 */
  lastInputTokens: number
  sessionId: string
  /** 为此运行时捕获的 CLI 调用 cwd。shell cwd 解析和权限存储使用这个稳定根。 */
  projectCwd: string
  /** 生命周期行为的运行时身份，不得从工具过滤推断。hydrated 状态和普通
   *  状态是根；被委派的 agent 在其全新状态创建时显式 opt-in。 */
  agentRole: 'root' | 'sub-agent'
  /** 精确的转录路径。新会话为 null，直到 appendHeader 钉住仅含时间戳的
   *  路径；hydrated 的旧式会话保留其原始 slug 前缀路径，好让 resume
   *  继续就地追加。 */
  sessionFilePath: string | null
  startedAt: string
  filesModified: Set<string>
  /** 当前 agentLoop 调用期间变更过的文件，包括本会话中更早一次 submit
   *  已经改过的路径。 */
  turnFilesModified: Set<string>
  /** 最近已执行工具调用的滚动记录，以「工具名 + 稳定序列化输入」的哈希为
   *  键。被 doom-loop 守卫用来检测模型是否在同一个失败调用上打转。 */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** 自最近一次成功文件变更以来，当前 submit 内的视觉检查尝试次数。
   *  这给截图 QA 一个有界的熔断器，又不妨碍正常的「编辑 → 复查」流程。 */
  visualCheckCallsSinceMutation: number
  /** 缓存的系统提示词文本——每个会话重建一次，让前缀跨轮保持字节稳定，
   *  从而在 OpenAI 兼容提供商（DeepSeek、Moonshot、Alibaba、…）上启用自动
   *  前缀缓存。在 `permissionMode` 变更时失效（置为 null），好让下一轮
   *  在有/没有 plan 模式覆盖层的情况下重建它。 */
  systemPromptCache: string | null
  /** 嵌入缓存系统提示词中的确切 capability 块，在构建时快照下来。
   *  上下文构成估算器（context-usage.ts）从提示词里减去它们，以隔离出
   *  每个类别的 token 数——稍后重新计算会在会话中途的 /skill 或 /mcp
   *  刷新后不匹配。与 systemPromptCache 一起设置；对 sub-agent 和
   *  首轮之前的状态为 undefined。 */
  systemPromptBlocks?: { knowledge: string; skill: string; mcpDeferred: string }
  /** 当前审批模式——通过 /plan 斜杠命令（用户）或 enterPlanMode/exitPlanMode
   *  工具（模型）在 'default' 和 'plan' 之间切换。工具执行时读取它来决定
   *  应用哪个系统提示词覆盖层，以及宣传哪些工具。 */
  permissionMode: PermissionMode
  /** plan 模式下计划文件的路径（`.x-code/plans/{sessionId}.md`），
   *  否则为 null。在模型首次调用 `enterPlanMode` 时懒创建，并在该 plan 模式
   *  会话的剩余时间里复用。退出时清除。 */
  currentPlanPath: string | null
  /** 从用户首条消息本地推导出的小写连字符 slug。用于可读的计划文件名，
   *  并保留在会话元数据里供旧式 resume 查找；转录文件名只含时间戳。 */
  taskSlug: string
  /** 模型通过 `todoWrite` 工具维护的当前清单。全量替换语义——每次
   *  todoWrite 调用都重写这个数组。仅内存，永不持久化。当模型提交一份
   *  所有条目都完成的列表时，自动清空回 []。在 `/clear` 和 `/resume` 时
   *  清空（新的 LoopState 以 [] 全新开始）；跨 `/compact` 保留，好让
   *  多步任务在历史摘要后存活。 */
  todos: TodoItem[]
  /** 支撑 `/rewind` 命令的逐用户消息快照。由 `createCheckpoint`
   *  （snapshot.ts）在每条用户消息落入 `messages` 之后立即推入。仅内存：
   *  环形缓冲 100 条。被 `markBoundaryAndReflush` 清空——压缩会就地重写
   *  消息数组，使之前每个 `messageCount` 锚点失效。以 `meta:checkpoint`
   *  行持久化到 jsonl；加载器的「最后边界之后的一切胜出」规则会在
   *  resume 时自然丢弃压缩前的条目。 */
  checkpoints: CheckpointEntry[]
  /** `/rewind` 覆盖的文件的最后成功哈希元数据。未变更的文件在下一个
   *  检查点复用其内容哈希。 */
  checkpointFileCache: Map<string, CheckpointFileCacheEntry>
  /** 已持久化到会话 jsonl 文件的消息数。agent 循环在轮边界调用
   *  `flushPendingMessages`，它会追加
   *  `state.messages.slice(persistedMessageCount)` 并递增计数器。
   *  在任何压缩（轻量或深度）后重置为 `state.messages.length`——那些
   *  重写的消息会在一条 `compact-boundary` 行之后重新 flush，好让加载器
   *  的「最后边界之后的一切胜出」规则在 resume 时重建相同的内存状态。
   *  见 `agent/session-store.ts`。 */
  persistedMessageCount: number
  /** LoopState 级转录事务链的尾部。状态派生（父 epoch/消息范围）和持久
   *  I/O 都在这条链内运行，所以并发的「轮末」和「退出时」flush 无法创建
   *  兄弟 epoch。`saveSession` 等待这次完整状态提交。 */
  pendingFlush: Promise<void> | null

  // ── 缓存命中中断检测 ──

  /** 上一轮的每轮缓存读取 token 数。用于检测意外的缓存未命中
   *  （例如某个代码改动破坏了系统提示词的字节稳定性）。 */
  prevTurnCacheRead: number
  /** 为 true 时，下一轮的缓存读取下降是预期的（例如压缩或
   *  permissionMode 变更之后），不应触发警告。一轮之后自动清除。 */
  expectCacheMiss: boolean
  /** 供下一个主提供商请求消费的结构化原因。 */
  expectedCacheMissReasons: Set<CacheMissReason>
  /** 仅主请求样本；辅助用量快照永不进入此列表。 */
  providerTurns: ProviderTurnUsage[]
  /** 增量维护的诊断摘要。更新它只需把最新的提供商轮次与其直接前驱
   *  比较。 */
  cacheMissSummary: CacheMissSummary

  // ── Sub-agent 支持（在 agentLoop 里设置一次，工具执行时读取） ──

  /** 用于 sub-agent 系统提示词的缓存知识上下文。在 agentLoop 里
   *  buildKnowledgeContext 解析后设置一次；对 sub-agent 循环透明
   *  （它们自己不会调用 buildKnowledgeContext）。 */
  knowledgeContext?: string
  /** cwd 是否是 git 仓库。为 sub-agent 系统提示词缓存。 */
  isGitRepo?: boolean

  /** 会话范围的读取去重缓存（绝对路径 → 最后投递的 mtime+size）。
   *  当文件未变更被重复读取时，readFile 返回短 stub 而不是重发全文，
   *  以节省上下文 token。sub-agent 有自己的（全新 LoopState），所以
   *  缓存绝不跨 agent。仅内存。 */
  readFileCache: ReadFileCache

  /** 统一的仅运行时 shell 管理器。其 managerInstanceId 在每次 create/hydrate 时重新生成。 */
  shellSessions: ShellSessionController

  /** 会话范围的持久目标。由 /goal 和 getGoal/updateGoal 工具变更。
   *  动态目标细节刻意排除在缓存的系统提示词之外；模型通过工具或
   *  续接输入来检查它们。 */
  goal: GoalState | null
  /** 供 goal runner 用的持久排队输入。一旦提升就是普通用户消息，
   *  但被单独跟踪，好让暂停/恢复/崩溃恢复能在安全的边界继续。 */
  goalInputs: GoalInput[]

  /** 每步 token 用量快照。每次 `agentLoop` 调用（= 一次用户 submit）
   *  一条。持久化到会话 jsonl；在 `/resume` 时恢复。在 `/clear` 时清空。 */
  stepStats: StepStats[]

  // ── Deferred 工具 / toolSearch（仅顶层 agent） ──

  /** 模型可以通过 `toolSearch` 发现、但在激活之前【不在】请求工具列表里的
   *  deferred 工具目录。由 buildTools 在循环启动时构建一次。对 sub-agent
   *  为 undefined（它们在策划过的、较小的工具集上保持完整工具注入）。 */
  deferredCatalog?: DeferredToolEntry[]
  /** 模型本会话中已通过 `toolSearch` 加载的 deferred 工具名。
   *  composeTurnTools 每轮把它们的定义拼进请求工具集。整个会话持续——
   *  已加载的工具保持已加载（对齐 Claude Code / Codex 的「discovered
   *  tools」语义）。仅内存；Set 的迭代顺序即插入顺序，让拼进工具映射
   *  尾部的部分跨轮保持稳定。 */
  activatedTools: Set<string>

  // ── Memory v2 动态召回 ──

  memoryGeneration: number
  memoryRecallAttachments: MemoryRecallAttachment[]
  memoryRecallTombstones: MemoryRecallTombstone[]
  surfacedMemoryHashes: Set<string>
  memoryTokensInWindow: number
  lastMemoryRecallTrace: MemoryRecallTrace | null
}

/** 生成一个人类可扫读的会话 id：`YYYYMMDD-HHMMSS-mmm`（本地时间，
 *  毫秒尾数用于在快速连续启动之间保证唯一性）。取代旧的
 *  `Date.now().toString(36)`（`mohbm95d`）——它在 `ls .x-code/sessions/`
 *  里不可读。时间戳形状与计划文件命名一致，好让两个目录列表以相同方式
 *  排序和扫读。 */

export interface CreateLoopStateOptions {
  ownerSessionId?: string
  projectCwd?: string
  agentRole?: 'root' | 'sub-agent'
  shellProvider?: ManagedShellProvider
}

export function createLoopState(
  initialMode: PermissionMode = 'default',
  options: CreateLoopStateOptions = {},
): LoopState {
  const sessionId = options.ownerSessionId ?? generateTimestampId()
  const projectCwd = options.projectCwd ?? process.cwd()
  const state = {
    trackedMessages: [],
    messages: [] as ModelMessage[],
    contextSecurity: { peerInfluenceActive: false },
    executionAuthority: { source: 'user', peerTainted: false },
    transcriptIntegrity: 'clean',
    transcriptRequiresSnapshot: false,
    manualToolExecutors: new Map(),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    usageBreakdown: createUsageBreakdown(),
    lastInputTokens: 0,
    sessionId,
    projectCwd,
    agentRole: options.agentRole ?? 'root',
    sessionFilePath: null,
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    turnFilesModified: new Set(),
    recentToolCalls: [],
    visualCheckCallsSinceMutation: 0,
    systemPromptCache: null,
    systemPromptBlocks: undefined,
    permissionMode: initialMode,
    // 计划路径在消息落地后从用户的任务文本【懒】推导——在
    // agentLoop / enterPlanMode 处理器里完成。这里不能做 slugify，
    // 因为会话构建时用户意图尚不可见。
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    checkpoints: [],
    checkpointFileCache: new Map(),
    persistedMessageCount: 0,
    pendingFlush: null,
    prevTurnCacheRead: 0,
    expectCacheMiss: false,
    expectedCacheMissReasons: new Set(),
    providerTurns: [],
    cacheMissSummary: createCacheMissSummary(),
    readFileCache: new Map(),
    shellSessions: new UnifiedShellSessionManager({
      ownerSessionId: sessionId,
      projectCwd,
      provider: options.shellProvider ?? getManagedShellProvider(),
    }),
    goal: null,
    goalInputs: [],
    activatedTools: new Set(),
    stepStats: [],
    memoryGeneration: 0,
    memoryRecallAttachments: [],
    memoryRecallTombstones: [],
    surfacedMemoryHashes: new Set(),
    memoryTokensInWindow: 0,
    lastMemoryRecallTrace: null,
  } satisfies LoopState
  const view = createModelMessageView(state)
  Object.defineProperty(state, 'messages', {
    enumerable: true,
    configurable: false,
    get: () => view,
    set: (messages: ModelMessage[]) => replaceTrackedMessages(state, messages),
  })
  return state
}
