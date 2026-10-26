/**
 * 主进程、preload 桥、运行时 utility 进程与 renderer 共享的
 * 桌面 IPC 契约。保持本文件无依赖（仅类型），使每个进程都能导入它
 * 而无需引入 Node 或 DOM 全局。
 */

export interface ShellCreateParams {
  cols: number
  rows: number
  cwd?: string
}

export interface SmokeModuleReport {
  ok: boolean
  version?: string
  detail?: string
  error?: string
}

export interface SmokeReport {
  ok: boolean
  modules: Record<string, SmokeModuleReport>
  pty: { ok: boolean; output: string; error?: string }
  agent: { ok: boolean; text: string; error?: string }
  versions: Record<string, string>
}

// ─── App / 模型 ───────────────────────────────────────────────────────────

export interface ModelOption {
  id: string
  label: string
  provider: string
  description: string
  /** 此模型的上下文上限（tokens）。 */
  contextWindow?: number
  demo?: boolean
}

export interface ProviderStatus {
  name: string
  envKey: string
  keyUrl: string
  available: boolean
}

export interface AppState {
  workspace: string
  models: ModelOption[]
  providers: ProviderStatus[]
  activeModelId: string
  /** 活动模型的上下文上限（tokens）。 */
  contextWindow?: number
  demo: boolean
  thinking: boolean
  permissionMode: string
  taskMode: string
}

export interface TextReport {
  text: string
}

export interface DiagnosticsExportResult {
  path: string
  bytes: number
  generatedAt: string
}

export interface BackupCountsView {
  sessions: number
  skills: number
  commands: number
  memory: number
  agents: number
}

export interface BackupExportView {
  path: string
  createdAt: string
  counts: BackupCountsView
}

export interface BackupImportView {
  path: string
  imported: BackupCountsView
  skipped: BackupCountsView
}

export interface UpdateCheckResult {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  url?: string
  notes?: string
  /** 匹配此平台/架构的安装器文件名（当列出时）。 */
  artifact?: string
  error?: string
}

export interface UpdateDownloadView {
  version: string
  filePath: string
  fileName: string
  bytes: number
}

export interface ProjectOverridesView {
  modelId?: string
  taskMode?: string
  autoChecks?: boolean
}

export interface ProjectSettingsView {
  workspace: string
  overrides: ProjectOverridesView
  effective: { modelId: string; taskMode: string; autoChecks: boolean }
}

export interface StorageCategoryView {
  id: string
  label: string
  path: string
  bytes: number
  files: number
}

export interface StorageUsageView {
  categories: StorageCategoryView[]
  totalBytes: number
}

export interface MemoryTopicView {
  id: string
  type: string
  summary: string
  description: string
  facts: number
  updatedAt: string
  pinned: boolean
}

export interface MemoryPanelView {
  root: string
  coreProfile: string
  status: {
    initialized: boolean
    generation: number
    topics: number
    facts: number
    queue: { pending: number; running: number; failed: number }
    worker: string
    invalidTopics: Array<{ path: string; error: string }>
    error?: string
  }
  topics: MemoryTopicView[]
}

export interface CustomCommandView {
  name: string
  description: string
  source: 'user' | 'project' | 'plugin'
  pluginId?: string
}

export interface HookEntryView {
  event: string
  matcher?: string
  command: string
  description?: string
  timeout?: number
  failurePolicy?: string
  source: string
  pluginId: string
}

export interface HooksView {
  active: HookEntryView[]
  configs: { user: Record<string, unknown>; project: Record<string, unknown> }
  paths: { user: string; project: string }
  errors: string[]
  projectTrusted: boolean
  projectHooksPresent: boolean
}

export interface FileTreeEntryView {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileReadView {
  path: string
  content: string
  size: number
  binary: boolean
  truncated: boolean
}

export interface SubAgentView {
  agentName: string
  description: string
  status: 'running' | 'completed' | 'aborted' | 'failed'
  log: Array<{ kind: 'text' | 'tool' | 'result'; text: string }>
  finalText?: string
  turnCount?: number
  durationMs?: number
}

export interface CompactResult {
  status: 'done' | 'nothing' | 'failed'
  message: string
}

// ─── 设置 ───────────────────────────────────────────────────────────────

export type ApiKeySource = 'stored' | 'env' | 'none'

export interface ProviderSettingsView {
  name: string
  envKey: string
  keyUrl: string
  available: boolean
  source: ApiKeySource
  hint?: string
  baseUrl?: string
  /** 自定义 OpenAI 兼容模型 id（不带 `custom:` 前缀）。 */
  modelId?: string
}

export type SkillRuntimeStatus = 'none' | 'ready' | 'stale' | 'error' | 'unsupported'

export interface SkillRuntimeView {
  dir: string
  status: SkillRuntimeStatus
  manifests: string[]
  /** 旧安装器留在技能目录内的依赖文件夹。 */
  legacy: boolean
  message?: string
}

export interface SkillSettingsView {
  name: string
  description: string
  source: 'user' | 'project'
  pluginId?: string
  enabled: boolean
  removable: boolean
  runtime: SkillRuntimeView
}

export type McpServerStatusView =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; resourceCount: number }
  | { kind: 'needs_auth'; authUrl?: string }
  | { kind: 'failed'; error: string }

export interface McpServerView {
  name: string
  scope: 'user' | 'project' | 'plugin'
  enabled: boolean
  config: Record<string, unknown>
  status: McpServerStatusView
}

export interface UserConfigFieldView {
  key: string
  type: 'string' | 'number' | 'boolean'
  sensitive: boolean
  prompt?: string
  required: boolean
  default?: string | number | boolean
  description?: string
}

export type UserConfigValues = Record<string, string | number | boolean>

export interface PluginSettingsView {
  id: string
  name: string
  version: string
  scope: 'user' | 'project'
  enabled: boolean
  marketplace: string
  userConfig?: UserConfigFieldView[]
  /** 当前有已保存值的 key。 */
  userConfigSet?: string[]
}

export interface ToolSettingsView {
  name: string
  label: string
  description: string
  enabled: boolean
  needsPermission: boolean
  alwaysAllow: boolean
}

export interface SearchProviderView {
  id: string
  label: string
  envKey: string
  signup: string
  configured: boolean
  source: 'stored' | 'env' | 'none'
  hint?: string
  /** DeepSeek 内置搜索使用模型 provider 的 key。 */
  modelKeyOnly?: boolean
}

export interface SearchTestResult {
  ok: boolean
  provider: string
  results: number
  latencyMs: number
  message: string
}

export type PermissionRuleType = 'exact' | 'prefix' | 'tool'

export interface PermissionRuleView {
  tool: string
  pattern: string
  type: PermissionRuleType
  /** shell 规则绑定到它们获批所在的项目。 */
  cwd?: string
  /** 人类可读形式，例如 `git commit:*`。 */
  label: string
}

export interface PermissionRulesResult {
  rules: PermissionRuleView[]
}

export interface SettingsSnapshot {
  workspace: string
  activeModelId: string
  contextWindow: number
  contextWindowOverride?: number
  providers: ProviderSettingsView[]
  skills: SkillSettingsView[]
  mcpServers: McpServerView[]
  mcpProjectSkipped: boolean
  plugins: PluginSettingsView[]
  pluginErrors: string[]
  tools: ToolSettingsView[]
  searchProviders: SearchProviderView[]
  /** 首选独立 provider id；空表示自动顺序。 */
  searchProvider: string
  toolProfile: 'full' | 'standard'
  thinking: boolean
  alwaysAllowAll: boolean
  browser: {
    /** 交互式浏览器子代理（`task` 可委托浏览器工作）。 */
    enabled: boolean
    /** 视觉变更后的一次性 localhost 截图。 */
    visualCheck: boolean
  }
  /** 存储的 API key 如何持久化：通过 safeStorage 做 OS 加密，或
   *  加密不可用时用 0600 明文。 */
  secretStorage: 'encrypted' | 'plain' | 'unknown'
  shellSandbox: { supported: boolean; enabled: boolean; allowNetwork: boolean; extensions: boolean }
  notifications: boolean
  onboarded: boolean
  updateFeed: string
}

export interface SettingsActionResult {
  state: AppState
  settings: SettingsSnapshot
}

export interface EnvironmentRefreshResult extends SettingsActionResult {
  environment: {
    refreshed: boolean
    shell: string
    added: number
    updated: string[]
    error?: string
  }
}

export interface WorkspaceListItem {
  path: string
  name: string
  current: boolean
}

export interface DocumentSheetView {
  name: string
  rows: string[][]
  totalRows: number
  totalColumns: number
}

export interface DocumentPageView {
  page: number
  dataUrl: string
  /** 此页文本：提取的文本，或当没有时的持久化 OCR。 */
  text: string
  /** 当 `text` 来自持久化 OCR 时为 true。 */
  ocr?: boolean
}

export interface DocumentTextPage {
  page: number
  text: string
}

export interface DocumentView {
  path: string
  name: string
  format: string
  text: string
  notes: string[]
  metadata: Record<string, string | number>
  pages?: DocumentPageView[]
  /** 每一页的提取文本，与加载了哪些页面图片无关。 */
  pageTexts?: DocumentTextPage[]
  sheets?: DocumentSheetView[]
  dataUrl?: string
  /** 仅 PDF：总页数以及是否还能加载更多页面图片。 */
  totalPages?: number
  hasMore?: boolean
  /** 当前有持久化 OCR 文本的页面。 */
  ocrPages?: number[]
  /** 对支持编辑审核的文本类文档为 true。 */
  editable?: boolean
  /** 存储基线的哈希（文档首次打开时的内容）。 */
  baselineHash?: string
  /** 当磁盘上的文件与存储基线不同时为 true。 */
  changed?: boolean
}

export interface ProjectCheckView {
  id: string
  label: string
  kind: 'node' | 'cargo'
  commandLine: string
}

export interface ProjectCheckResultView extends ProjectCheckView {
  status: 'passed' | 'failed' | 'skipped' | 'timeout'
  exitCode: number | null
  durationMs: number
  output: string
}

export interface GitFileChangeView {
  path: string
  status: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitStatusView {
  isRepo: boolean
  root?: string
  branch?: string
  ahead?: number
  behind?: number
  files: GitFileChangeView[]
  additions: number
  removals: number
  checkpoint?: { turnId: string; createdAt: string }
}

export interface BranchInfoView {
  name: string
  current: boolean
  /** 已签出此分支的工作目录。 */
  worktreePath?: string
  /** 可被删除的关联 worktree（绝不是主检出）。 */
  removable?: boolean
  /** 远程跟踪分支条目（名称含远程，例如 origin/main）。 */
  remote?: boolean
  /** 远程条目创建/快进到的本地分支名。 */
  localName?: string
}

export interface BranchListView {
  isRepo: boolean
  current?: string
  branches: BranchInfoView[]
}

export interface WorktreeOpenResult {
  branch: string
  workspacePath: string
  created: boolean
}

export interface WorktreeRemoveResult {
  path: string
  removed: boolean
  forced: boolean
}

export interface LibrarySemanticView {
  backendInstalled: boolean
  modelReady: boolean
  note: string
}

export interface LibraryStatsView {
  files: number
  chunks: number
  characters: number
  vectors: number
  dimensions: number
  updatedAt: string
  indexPath: string
  lastRoot?: string
  semanticEnabled: boolean
  semantic: LibrarySemanticView
}

export interface LibraryIndexResultView {
  files: number
  indexed: number
  skipped: number
  removed: number
  chunks: number
  characters: number
  vectors: number
  semantic: boolean
  note?: string
  errors: string[]
}

export interface LibrarySearchItemView {
  filePath: string
  fileName: string
  page?: number
  score: number
  snippet: string
}

export interface LibrarySearchView {
  mode: 'hybrid' | 'keyword'
  results: LibrarySearchItemView[]
}

export interface DocumentDiffHunkView {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 统一 diff 行，每行以 ' '、'+' 或 '-' 为前缀。 */
  lines: string[]
}

export interface DocumentDiffView {
  /** 计算 diff 时磁盘上文件的哈希。 */
  hash: string
  baselineHash: string
  hunks: DocumentDiffHunkView[]
  additions: number
  removals: number
}

export interface DocumentRecentItem {
  path: string
  name: string
  updatedAt: string
  hasOcr: boolean
  exists: boolean
}

export interface WorkspaceFileItem {
  /** 绝对路径，可直接作为 @ 引用插入。 */
  path: string
  relative: string
  isDirectory: boolean
}

export interface WorkspaceInsightsView {
  hasPackageJson: boolean
  hasReadme: boolean
  hasCargo: boolean
  hasTex: boolean
  hasBib: boolean
  hasSpreadsheet: boolean
  hasDocuments: boolean
  recentDocument?: { name: string; path: string }
  checks: Array<{ id: string; label: string; commandLine: string }>
  git: { isRepo: boolean; changeCount: number }
}

export interface WorkspaceList {
  projects: WorkspaceListItem[]
  current: string
}

export interface TempDeliverableMoveResult {
  moved: Array<{ from: string; to: string }>
  errors: Array<{ path: string; error: string }>
}

export interface TestConnectionResult {
  ok: boolean
  modelId: string
  latencyMs: number
  message: string
}

export interface SkillImportResult {
  added: string[]
  settings: SettingsSnapshot
  plugin?: { pluginId: string; version: string }
}

export type SkillMarketProvider = 'skillhub' | 'skillsmp'

export interface SkillMarketEntryView {
  /** provider 特定的安装 id（`@namespace/slug` 或 SkillsMP skill id）。 */
  id: string
  provider: SkillMarketProvider
  name: string
  description: string
  /** 目录提供时的中文描述。 */
  descriptionZh?: string
  author?: string
  version?: string
  stars?: number
  downloads?: number
  category?: string
  homepage?: string
  /** SkillsMP 安装器使用的 GitHub source。 */
  sourceUrl?: string
  requiresKey?: boolean
  installed: boolean
}

export interface SkillMarketListView {
  provider: SkillMarketProvider
  entries: SkillMarketEntryView[]
  total?: number
}

export interface PluginInstallResult {
  pluginId: string
  version: string
  settings: SettingsSnapshot
}

export type PluginInstallTarget =
  | { kind: 'marketplace'; id: string }
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string }

export interface PluginConsentPreviewView {
  pluginId: string
  version: string
  description?: string
  marketplace: string
  verified: boolean
  fromReservedMarketplace: boolean
  source: { kind: 'git' | 'github' | 'local'; label: string }
  hookEvents: string[]
  inlineMcpServerNames: string[]
  hasPathMcpServers: boolean
  hasPathHooks: boolean
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  author?: string
  license?: string
  homepage?: string
  userConfig?: UserConfigFieldView[]
}

export interface MarketplaceEntryView {
  id: string
  name: string
  description?: string
  category?: string
  version?: string
  verified?: boolean
  marketplace: string
  homepage?: string
  installed: boolean
}

export interface MarketplaceListView {
  entries: MarketplaceEntryView[]
  marketplaces: Array<{ name: string; displayName?: string; description?: string; count: number }>
  errors: string[]
}

// ─── 会话 ───────────────────────────────────────────────────────────────

export interface SessionListItem {
  filePath: string
  sessionId: string
  name?: string
  /** AI 生成的短标题（在 name 和 firstPrompt 之间的显示回退）。 */
  title?: string
  firstPrompt: string
  startedAt: string
  modelId: string
  mtime: number
  pinned?: boolean
  archived?: boolean
}

export interface SessionSearchResult {
  filePath: string
  sessionId: string
  name?: string
  firstPrompt: string
  snippet: string
  matchCount: number
  mtime: number
}

export interface SessionAttachmentView {
  name: string
  mime?: string
  /** 原始本地路径（当会话保留它时）。 */
  path?: string
  /** 对小到足以嵌入记录的栅格图片存在。 */
  dataUrl?: string
}

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error'
  text: string
  attachmentViews?: SessionAttachmentView[]
  toolName?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  toolOutput?: string
}

export interface LoadedSessionView {
  sessionId: string
  filePath: string
  modelId: string
  messages: SessionMessage[]
  usage: UsageView
}

export interface RewindCheckpointView {
  ckptId: string
  ts: string
  userPrompt: string
  messageCount: number
}

export interface RewindResultView {
  ok: boolean
  mode: 'both' | 'code' | 'conversation'
  restoredFiles: number
  messageCount: number
  view: LoadedSessionView
}

export type BackgroundShellStatus =
  | 'starting'
  | 'running'
  | 'root-exited'
  | 'terminating'
  | 'termination-failed'
  | 'finalizing'
  | 'exited'
  | 'failed'

export interface BackgroundShellView {
  shellId: string
  command: string
  cwd: string
  status: BackgroundShellStatus
  tty: boolean
  startedAt?: number
  elapsedMs?: number
  outputBytes?: number
  exitCode?: number
  timedOut: boolean
  failure?: string
  recentOutput: string
  omittedBytes: number
}

// ─── Agent 视图 ────────────────────────────────────────────────────────────

export interface UsageView {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  currentContextTokens: number
  contextWindow?: number
}

export interface TodoView {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface FileEditView {
  filePath: string
  additions: number
  removals: number
  isCreate: boolean
  content?: string
  /** 当运行时为「撤销此编辑」保留了前后快照时为 true。 */
  revertible?: boolean
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
}

// ─── 审批 ──────────────────────────────────────────────────────────────

export type ApprovalKind = 'permission' | 'authority' | 'question' | 'plan'

export interface ApprovalRequestEvent {
  requestId: string
  kind: ApprovalKind
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  question?: string
  options?: Array<{ label: string; description: string }>
  planText?: string
  preview?: {
    summary: string
    paths?: string[]
    destination?: string
    complete: boolean
    approvable: boolean
    reason?: string
  }
}

// ─── 请求 ───────────────────────────────────────────────────────────────

export interface RequestMap {
  'agent:submit': {
    params: { prompt: string; attachments?: string[] }
    result: { text: string; reason: string; sessionId: string; modelId: string }
  }
  'agent:abort': { params: Record<string, never>; result: { aborted: boolean } }
  'agent:set-thinking': { params: { enabled: boolean }; result: { thinking: boolean } }
  'agent:set-permission-mode': { params: { mode: 'default' | 'plan' }; result: { mode: string } }
  'agent:set-task-mode': {
    params: { mode: 'coding' | 'writing' | 'research' | 'office' }
    result: AppState
  }
  'agent:compact': { params: Record<string, never>; result: CompactResult }
  'context:stats': { params: Record<string, never>; result: TextReport }
  'usage:summary': { params: Record<string, never>; result: TextReport }
  'usage:history': { params: Record<string, never>; result: TextReport }
  'memory:get': { params: Record<string, never>; result: TextReport }
  'memory:panel': { params: Record<string, never>; result: MemoryPanelView }
  'memory:topic': { params: { id: string }; result: { id: string; content: string } }
  'memory:save-topic': { params: { id: string; content: string }; result: MemoryPanelView }
  'memory:delete-topic': { params: { id: string }; result: MemoryPanelView }
  'memory:reload': { params: Record<string, never>; result: MemoryPanelView }
  'commands:list': { params: Record<string, never>; result: { commands: CustomCommandView[] } }
  'commands:detail': {
    params: { name: string }
    result: { name: string; description: string; body: string; source: 'user' | 'project' | 'plugin' }
  }
  'commands:run': { params: { name: string; args?: string }; result: { name: string; prompt: string } }
  'commands:save': {
    params: { name: string; description: string; body: string; scope: 'user' | 'project' }
    result: { commands: CustomCommandView[] }
  }
  'commands:delete': {
    params: { name: string; scope: 'user' | 'project' }
    result: { commands: CustomCommandView[] }
  }
  'hooks:get': { params: Record<string, never>; result: HooksView }
  'hooks:save': {
    params: { scope: 'user' | 'project'; config: Record<string, unknown> }
    result: HooksView
  }
  'hooks:trust-project': { params: { trusted: boolean }; result: HooksView }
  'files:list': { params: { path?: string }; result: { path: string; entries: FileTreeEntryView[] } }
  'files:read': { params: { path: string }; result: FileReadView }
  'files:write': { params: { path: string; content: string }; result: { path: string; size: number } }
  'files:create': { params: { path: string; content?: string }; result: { path: string; size: number } }
  'doctor:run': { params: Record<string, never>; result: TextReport }
  'diagnostics:export': { params: Record<string, never>; result: DiagnosticsExportResult }
  'renderer:error': { params: { message: string; stack: string }; result: null }
  'backup:export': { params: { destination: string }; result: BackupExportView }
  'backup:import': { params: { source: string }; result: BackupImportView }
  'shell:list': { params: Record<string, never>; result: TextReport }
  'agents:list': { params: Record<string, never>; result: TextReport }
  'goal:get': { params: Record<string, never>; result: TextReport }
  'app:quit': { params: Record<string, never>; result: null }
  'app:new-window': {
    params: { sessionFilePath?: string; workspacePath?: string }
    result: { created: boolean; focused: boolean }
  }
  'app:set-window-sessions': { params: { filePaths: string[] }; result: null }
  'app:window-info': {
    params: Record<string, never>
    result: {
      count: number
      focusedId: number | null
      senderId: number | null
      windows: Array<{ id: number; workspace?: string; focused: boolean; sessionFiles: string[] }>
    }
  }
  'app:reveal-path': { params: { path: string }; result: { opened: boolean } }
  'app:image-preview': {
    params: { path: string }
    result: { dataUrl: string; mime: string; name: string; size: number }
  }
  'app:capture-screen': {
    params: Record<string, never>
    result: { dataUrl: string; width: number; height: number; name: string }
  }
  'app:capture-region': {
    params: Record<string, never>
    result: { dataUrl: string; width: number; height: number; cancelled: boolean }
  }
  'app:microphone-access': { params: Record<string, never>; result: { granted: boolean } }
  'app:set-zoom': { params: { factor: number }; result: { factor: number } }
  'app:open-in-editor': {
    params: { filePath: string; line?: number; column?: number }
    result: { opened: boolean; editor?: string; error?: string }
  }
  'audio:transcribe': {
    params: { data: string; mime: string; language?: string }
    result: { text: string }
  }
  'app:state': { params: Record<string, never>; result: AppState }
  'app:save-pasted-image': { params: { data: string; mime: string }; result: { path: string } }
  'background:list': { params: Record<string, never>; result: { sessions: BackgroundShellView[] } }
  'background:stop': { params: { shellId: string }; result: { ok: boolean } }
  'models:set': { params: { modelId: string }; result: AppState }
  'models:discover': { params: Record<string, never>; result: AppState }
  'session:list': { params: Record<string, never>; result: SessionListItem[] }
  'session:load': { params: { filePath: string }; result: LoadedSessionView }
  'session:salvage': {
    params: { filePath: string }
    result: { sessionId: string; filePath: string; messageCount: number; view: LoadedSessionView }
  }
  'session:new': { params: Record<string, never>; result: { sessionId: string } }
  'session:rename': { params: { filePath: string; name: string }; result: { name: string } }
  'session:delete': { params: { filePath: string }; result: { deleted: boolean; resetActive: boolean } }
  'session:set-pinned': { params: { filePath: string; pinned: boolean }; result: { pinned: boolean } }
  'session:set-archived': { params: { filePath: string; archived: boolean }; result: { archived: boolean } }
  'session:search': {
    params: { query: string; limit?: number }
    result: { results: SessionSearchResult[] }
  }
  'session:export': {
    params: { filePath: string; format: 'markdown' | 'json' | 'pdf' }
    result: { path: string; size: number }
  }
  'session:checkpoints': { params: Record<string, never>; result: { checkpoints: RewindCheckpointView[] } }
  'session:checkpoint-diff': {
    params: { ckptId: string }
    result: { filesChanged: string[]; insertions: number; deletions: number } | null
  }
  'session:rewind': {
    params: { ckptId: string; mode?: 'both' | 'code' | 'conversation' }
    result: RewindResultView
  }
  'session:fork': {
    params: { name?: string }
    result: { sessionId: string; filePath: string; view: LoadedSessionView }
  }
  'approval:respond': {
    params: {
      requestId: string
      kind: ApprovalKind
      decision?: 'yes' | 'always' | 'no'
      answer?: string
      approved?: boolean
    }
    result: null
  }
  'approvals:cancel-all': { params: Record<string, never>; result: null }
  'app:open-external': { params: { url: string }; result: null }
  'settings:get': { params: Record<string, never>; result: SettingsSnapshot }
  'settings:set-api-key': { params: { provider: string; key: string; baseUrl?: string }; result: SettingsActionResult }
  'settings:set-custom-model': {
    params: { modelId: string; key?: string; baseUrl?: string }
    result: SettingsActionResult
  }
  'settings:clear-api-key': { params: { provider: string }; result: SettingsActionResult }
  'settings:set-search-key': { params: { provider: string; key: string }; result: SettingsActionResult }
  'settings:clear-search-key': { params: { provider: string }; result: SettingsActionResult }
  'settings:set-search-provider': {
    params: { provider: string | null }
    result: SettingsActionResult
  }
  'settings:test-search-key': {
    params: { provider: string; key?: string }
    result: SearchTestResult
  }
  'settings:set-skill-enabled': { params: { name: string; enabled: boolean }; result: SettingsActionResult }
  'settings:set-tool-enabled': { params: { name: string; enabled: boolean }; result: SettingsActionResult }
  'settings:set-tool-always-allow': {
    params: { name: string; enabled: boolean }
    result: SettingsActionResult
  }
  'settings:set-always-allow-all': { params: { enabled: boolean }; result: SettingsActionResult }
  'settings:set-context-window': {
    params: { modelId: string; tokens: number | null }
    result: SettingsActionResult
  }
  'settings:set-browser-enabled': { params: { enabled: boolean }; result: SettingsActionResult }
  'settings:set-browser-visual-check': { params: { enabled: boolean }; result: SettingsActionResult }
  'permissions:rules': { params: Record<string, never>; result: PermissionRulesResult }
  'permissions:add-rule': {
    params: { tool: string; type: PermissionRuleType; pattern: string }
    result: PermissionRulesResult
  }
  'permissions:remove-rule': {
    params: { tool: string; type: PermissionRuleType; pattern: string; cwd?: string }
    result: PermissionRulesResult
  }
  'settings:set-notifications': { params: { enabled: boolean }; result: SettingsActionResult }
  'settings:set-onboarded': { params: { value: boolean }; result: SettingsActionResult }
  'settings:set-update-feed': { params: { feed: string }; result: SettingsActionResult }
  'project:settings': { params: Record<string, never>; result: ProjectSettingsView }
  'project:save': {
    params: { modelId?: string | null; taskMode?: string | null; autoChecks?: boolean | null }
    result: SettingsActionResult
  }
  'storage:usage': { params: Record<string, never>; result: StorageUsageView }
  'storage:cleanup': {
    params: {
      sessionsOlderThanDays?: number
      attachmentsOlderThanDays?: number
      library?: boolean
      whisperModels?: boolean
    }
    result: { deletedFiles: number; freedBytes: number; usage: StorageUsageView }
  }
  'app:check-update': { params: { feed: string }; result: UpdateCheckResult }
  'app:download-update': {
    params: { feed: string; destPath?: string }
    result: UpdateDownloadView
  }
  'app:pick-update-path': {
    params: { suggestedName?: string }
    result: { path: string | null }
  }
  'app:cancel-update-download': { params: Record<string, never>; result: { cancelled: boolean } }
  'app:open-update': { params: { filePath: string }; result: null }
  'settings:set-shell-sandbox': {
    params: { enabled?: boolean; allowNetwork?: boolean; extensions?: boolean }
    result: SettingsActionResult
  }
  'settings:test-api-key': {
    params: { provider: string; key?: string; baseUrl?: string }
    result: TestConnectionResult
  }
  'skills:import': { params: { path: string }; result: SkillImportResult }
  'skills:install-command': { params: { command: string }; result: SkillImportResult }
  'skills:reload': { params: Record<string, never>; result: SettingsActionResult }
  'skills:runtime-install': { params: { name: string }; result: SettingsActionResult }
  'skills:runtime-clear': { params: { name: string }; result: SettingsActionResult }
  'skills:runtime-clear-legacy': { params: { name: string }; result: SettingsActionResult }
  'settings:refresh-environment': { params: Record<string, never>; result: EnvironmentRefreshResult }
  'skill-market:search': {
    params: { provider: SkillMarketProvider; query: string; limit?: number }
    result: SkillMarketListView
  }
  'skill-market:install': {
    params: { provider: SkillMarketProvider; id: string; version?: string; sourceUrl?: string }
    result: SkillImportResult
  }
  'skill-market:register-mcp': { params: Record<string, never>; result: SettingsActionResult }
  'plugins:import': { params: { path: string }; result: PluginInstallResult }
  'plugins:install-command': {
    params: { command: string; userConfig?: UserConfigValues }
    result: PluginInstallResult
  }
  'plugins:preview': { params: { target: PluginInstallTarget }; result: PluginConsentPreviewView }
  'plugins:install': {
    params: { target: PluginInstallTarget; userConfig?: UserConfigValues }
    result: PluginInstallResult
  }
  'plugins:user-config': {
    params: { id: string }
    result: { fields: UserConfigFieldView[]; values: UserConfigValues; setKeys: string[] }
  }
  'plugins:save-user-config': {
    params: { id: string; values: UserConfigValues }
    result: SettingsActionResult
  }
  'plugins:uninstall': { params: { id: string }; result: SettingsActionResult }
  'skills:remove': { params: { name: string }; result: SettingsActionResult }
  'settings:mcp-trust-project': { params: Record<string, never>; result: SettingsActionResult }
  'settings:mcp-auth': { params: { name: string }; result: SettingsActionResult }
  'settings:marketplace-list': {
    params: { query?: string; refresh?: boolean }
    result: MarketplaceListView
  }
  'settings:marketplace-install': { params: { id: string }; result: PluginInstallResult }
  'settings:marketplace-add': {
    params: { name: string; source: string }
    result: MarketplaceListView
  }
  'app:pick-path': {
    params: { kind: 'skill' | 'plugin' | 'project' | 'document' | 'folder' }
    result: { path: string | null; paths?: string[] }
  }
  'workspace:list': { params: Record<string, never>; result: WorkspaceList }
  'workspace:move-temp-files': {
    params: { paths: string[] }
    result: TempDeliverableMoveResult
  }
  'document:open': {
    params: { path: string; start?: number; count?: number }
    result: DocumentView
  }
  'document:pages': {
    params: { path: string; start: number; count: number }
    result: { pages: DocumentPageView[]; hasMore: boolean }
  }
  'document:ocr-page': { params: { path: string; page: number }; result: { text: string } }
  'document:forget-ocr': { params: { path: string }; result: { cleared: number } }
  'document:list': { params: Record<string, never>; result: { documents: DocumentRecentItem[] } }
  'document:diff': { params: { path: string }; result: { diff: DocumentDiffView | null } }
  'document:apply-hunks': {
    params: { path: string; accepted: number[]; hash: string }
    result: { hash: string; applied: number }
  }
  'document:save-baseline': { params: { path: string }; result: { hash: string } }
  'library:stats': { params: Record<string, never>; result: LibraryStatsView }
  'library:index': {
    params: { path: string; recursive?: boolean; semantic?: boolean }
    result: LibraryIndexResultView
  }
  'library:search': {
    params: { query: string; limit?: number; path?: string }
    result: LibrarySearchView
  }
  'library:clear': { params: Record<string, never>; result: null }
  'library:set-semantic': { params: { enabled: boolean }; result: { enabled: boolean } }
  'checks:detect': { params: Record<string, never>; result: { checks: ProjectCheckView[] } }
  'checks:run': {
    params: { ids?: string[]; stopOnFailure?: boolean }
    result: { results: ProjectCheckResultView[]; summary: string; fixPrompt: string }
  }
  'checks:status': {
    params: Record<string, never>
    result: { autoChecks: boolean; lastResults?: ProjectCheckResultView[] }
  }
  'checks:set-auto': { params: { enabled: boolean }; result: { enabled: boolean } }
  'git:status': { params: Record<string, never>; result: GitStatusView }
  'git:branches': { params: Record<string, never>; result: BranchListView }
  'worktree:open': { params: { branch: string; remoteRef?: string }; result: WorktreeOpenResult }
  'worktree:create': { params: { branch: string; from?: string; parentDir?: string }; result: WorktreeOpenResult }
  'worktree:remove': { params: { path: string; force?: boolean }; result: WorktreeRemoveResult }
  'worktree:prune': { params: Record<string, never>; result: { ok: boolean } }
  'git:diff': { params: { path: string; staged?: boolean }; result: { diff: string; truncated: boolean } }
  'git:undo-turn': {
    params: { turnId?: string }
    result: { ok: boolean; restored: number; deleted: number; message: string }
  }
  'edit:revert': {
    params: { toolCallId: string }
    result: { ok: boolean; filePath: string; message: string }
  }
  'workspace:files': {
    params: { query: string; limit?: number }
    result: { files: WorkspaceFileItem[] }
  }
  'workspace:insights': { params: Record<string, never>; result: WorkspaceInsightsView }
  'workspace:switch': { params: { path: string }; result: SettingsActionResult }
  'settings:set-tool-profile': { params: { profile: 'full' | 'standard' }; result: SettingsActionResult }
  'settings:set-plugin-enabled': { params: { id: string; enabled: boolean }; result: SettingsActionResult }
  'settings:mcp-save': {
    params: { name: string; config: Record<string, unknown> }
    result: SettingsActionResult
  }
  'settings:mcp-remove': { params: { name: string }; result: SettingsActionResult }
  'settings:mcp-reload': { params: Record<string, never>; result: SettingsActionResult }
  'settings:reload': { params: Record<string, never>; result: SettingsActionResult }
  'shell:create': { params: ShellCreateParams; result: { id: string } }
  'shell:write': { params: { id: string; data: string }; result: null }
  'shell:resize': { params: { id: string; cols: number; rows: number }; result: null }
  'shell:kill': { params: { id: string }; result: null }
  'smoke:run': { params: Record<string, never>; result: SmokeReport }
}

export type RequestMethod = keyof RequestMap

export type RuntimeRequest = {
  [M in RequestMethod]: { id: string; method: M; params: RequestMap[M]['params'] }
}[RequestMethod]

export interface RuntimeError {
  code: string
  message: string
}

export type RuntimeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: RuntimeError }

// ─── 事件 ─────────────────────────────────────────────────────────────────

export type RuntimeEvent =
  | { type: 'runtime:ready'; pid: number; versions: Record<string, string> }
  | { type: 'runtime:log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'app:state'; state: AppState }
  | { type: 'agent:turn-start'; turnId: string; sessionId: string }
  | { type: 'agent:text-delta'; turnId: string; delta: string }
  | { type: 'agent:tool-call'; turnId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'agent:tool-progress'; turnId: string; toolCallId: string; message: string }
  | {
      type: 'agent:tool-result'
      turnId: string
      toolCallId: string
      result: string
      isError: boolean
    }
  | { type: 'agent:file-edit'; turnId: string; toolCallId: string; payload: FileEditView }
  | {
      type: 'agent:subagent'
      toolCallId: string
      phase: 'start' | 'text' | 'tool' | 'tool-result' | 'end'
      agentName?: string
      description?: string
      text?: string
      subToolName?: string
      isError?: boolean
      durationMs?: number
      turnCount?: number
      aborted?: boolean
    }
  | { type: 'agent:todos'; todos: TodoView[] }
  | { type: 'agent:usage'; usage: UsageView }
  | { type: 'agent:context-compressed'; summary: string }
  | { type: 'agent:compression-progress'; description: string }
  | { type: 'agent:ingest-progress'; description: string }
  | { type: 'agent:attachments'; files: string[]; mediaParts: number; textBytes: number }
  | { type: 'agent:stream-retry'; attempt: number; maxAttempts: number; delayMs?: number }
  | { type: 'agent:permission-mode'; mode: string }
  | { type: 'agent:turn-end'; turnId: string; sessionId: string; reason: string; text: string }
  | { type: 'agent:error'; turnId: string; message: string }
  | ({ type: 'approval:request' } & ApprovalRequestEvent)
  | { type: 'session:saved'; item: SessionListItem }
  | { type: 'settings:changed'; settings: SettingsSnapshot }
  | { type: 'app:settings-changed' }
  | { type: 'session:title'; sessionId: string; title: string }
  | { type: 'commands:changed' }
  | { type: 'audio:progress'; message: string }
  | { type: 'app:open-session'; sessionId: string }
  | { type: 'app:new-session' }
  | { type: 'library:progress'; phase: string; processed: number; total: number; chunks: number }
  | {
      type: 'app:update-download-progress'
      receivedBytes: number
      totalBytes?: number
      bytesPerSecond?: number
    }
  | { type: 'checks:finished'; results: ProjectCheckResultView[]; auto: boolean; fixPrompt: string }
  | { type: 'background:changed' }
  | { type: 'mcp:auth-url'; server: string; url: string }
  | { type: 'shell:output'; id: string; data: string }
  | { type: 'shell:exit'; id: string; exitCode: number; signal?: number }
  | { type: 'smoke:result'; report: SmokeReport }

/** 主进程 → 运行时 utility 进程。 */
export type RuntimeInbound =
  | { kind: 'request'; request: RuntimeRequest }
  | { kind: 'main-response'; id: string; ok: true; result: unknown }
  | { kind: 'main-response'; id: string; ok: false; error: string }
  | { kind: 'shutdown' }

/** 运行时 → 只有 Electron 主进程能服务的调用。 */
export type MainRequestMethod =
  | 'app:render-pdf'
  | 'app:notify'
  | 'app:reveal-path'
  | 'app:safe-storage-status'
  | 'app:safe-storage-encrypt'
  | 'app:safe-storage-decrypt'

/** 字段是方法特定的；只有 `app:render-pdf` 使用 html/title，
 *  safeStorage 方法使用 `data`（明文或 base64 密文），而
 *  `app:notify` 使用 title/body。 */
export type MainRequestParams = {
  html?: string
  title?: string
  body?: string
  data?: string
  path?: string
  sessionId?: string
}

/** 运行时 utility 进程 → 主进程。 */
export type RuntimeOutbound =
  | { kind: 'response'; response: RuntimeResponse }
  | { kind: 'event'; event: RuntimeEvent }
  | { kind: 'ready'; pid: number; versions: Record<string, string> }
  | { kind: 'main-request'; id: string; method: MainRequestMethod; params: MainRequestParams }

// ─── UI 冒烟 ───────────────────────────────────────────────────────────────

export interface UiSmokeCheck {
  ok: boolean
  detail: string
}

export interface UiSmokeResult {
  ok: boolean
  checks: Record<string, UiSmokeCheck>
  error?: string
}

/** 暴露在 `window.xcode` 上的 preload 桥。 */
export interface XcodeBridge {
  request(request: RuntimeRequest): Promise<RuntimeResponse>
  onEvent(listener: (event: RuntimeEvent) => void): () => void
  /** 仅供 `--ui-smoke` 使用：上报 renderer 侧结果并退出。 */
  reportUiSmoke(result: UiSmokeResult): void
  /** 保持冒烟看门狗存活，并记录最后一个完成的检查。 */
  reportUiSmokeProgress(name: string): void
  /** 通过 Electron 的剪贴板复制文本（file:// 页面没有
   *  可靠的 navigator.clipboard 权限）。 */
  copyText(text: string): void
  /** 把拖放的 File 解析为其文件系统路径（沙箱化的 renderer
   *  无法读取 `File.path`）。不可用时返回 ''。 */
  pathForFile(file: unknown): string
  platform: string
}
