/**
 * Desktop IPC contract shared by the main process, the preload bridge, the
 * runtime utility process, and the renderer. Keep this file dependency-free
 * (types only) so every process can import it without pulling in Node or DOM
 * globals.
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

// ─── App / models ───────────────────────────────────────────────────────────

export interface ModelOption {
  id: string
  label: string
  provider: string
  description: string
  /** Context ceiling for this model (tokens). */
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
  /** Context ceiling for the active model (tokens). */
  contextWindow?: number
  demo: boolean
  thinking: boolean
  permissionMode: string
  taskMode: string
}

export interface TextReport {
  text: string
}

export interface UpdateCheckResult {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  url?: string
  notes?: string
  error?: string
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

// ─── Settings ───────────────────────────────────────────────────────────────

export type ApiKeySource = 'stored' | 'env' | 'none'

export interface ProviderSettingsView {
  name: string
  envKey: string
  keyUrl: string
  available: boolean
  source: ApiKeySource
  hint?: string
  baseUrl?: string
  /** Custom OpenAI-compatible model id (without the `custom:` prefix). */
  modelId?: string
}

export interface SkillSettingsView {
  name: string
  description: string
  source: 'user' | 'project'
  pluginId?: string
  enabled: boolean
  removable: boolean
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
  /** Keys that currently have a saved value. */
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

export interface SettingsSnapshot {
  workspace: string
  providers: ProviderSettingsView[]
  skills: SkillSettingsView[]
  mcpServers: McpServerView[]
  mcpProjectSkipped: boolean
  plugins: PluginSettingsView[]
  pluginErrors: string[]
  tools: ToolSettingsView[]
  toolProfile: 'full' | 'standard'
  thinking: boolean
  alwaysAllowAll: boolean
  /** How stored API keys are persisted: OS-encrypted via safeStorage, or
   *  plaintext with 0600 when encryption is unavailable. */
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
  /** Text for this page: extracted text, or persisted OCR when there was none. */
  text: string
  /** True when `text` came from persisted OCR. */
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
  /** Extracted text for every page, independent of which page images are loaded. */
  pageTexts?: DocumentTextPage[]
  sheets?: DocumentSheetView[]
  dataUrl?: string
  /** PDF only: total page count and whether more page images can be loaded. */
  totalPages?: number
  hasMore?: boolean
  /** Pages that currently have persisted OCR text. */
  ocrPages?: number[]
  /** True for text-like documents that support edit review. */
  editable?: boolean
  /** Hash of the stored baseline (content when the document was first opened). */
  baselineHash?: string
  /** True when the file on disk differs from the stored baseline. */
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
  /** Working directory that already has this branch checked out. */
  worktreePath?: string
  /** A linked worktree that can be removed (never the main checkout). */
  removable?: boolean
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
  /** Unified diff lines, each prefixed with ' ', '+', or '-'. */
  lines: string[]
}

export interface DocumentDiffView {
  /** Hash of the file on disk when the diff was computed. */
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
  /** Absolute path, ready to be inserted as an @ reference. */
  path: string
  relative: string
  isDirectory: boolean
}

export interface WorkspaceList {
  projects: WorkspaceListItem[]
  current: string
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

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface SessionListItem {
  filePath: string
  sessionId: string
  name?: string
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
  /** Original local path, when the session retained it. */
  path?: string
  /** Present for raster images small enough to embed in the transcript. */
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
  exitCode?: number
  timedOut: boolean
  failure?: string
  recentOutput: string
  omittedBytes: number
}

// ─── Agent views ────────────────────────────────────────────────────────────

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
  /** True when the runtime kept a pre/post snapshot for "revert this edit". */
  revertible?: boolean
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
}

// ─── Approvals ──────────────────────────────────────────────────────────────

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

// ─── Requests ───────────────────────────────────────────────────────────────

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
  'settings:set-skill-enabled': { params: { name: string; enabled: boolean }; result: SettingsActionResult }
  'settings:set-tool-enabled': { params: { name: string; enabled: boolean }; result: SettingsActionResult }
  'settings:set-tool-always-allow': {
    params: { name: string; enabled: boolean }
    result: SettingsActionResult
  }
  'settings:set-always-allow-all': { params: { enabled: boolean }; result: SettingsActionResult }
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
  'worktree:open': { params: { branch: string }; result: WorktreeOpenResult }
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

// ─── Events ─────────────────────────────────────────────────────────────────

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
  | { type: 'commands:changed' }
  | { type: 'audio:progress'; message: string }
  | { type: 'app:open-session'; sessionId: string }
  | { type: 'app:new-session' }
  | { type: 'library:progress'; phase: string; processed: number; total: number; chunks: number }
  | { type: 'checks:finished'; results: ProjectCheckResultView[]; auto: boolean; fixPrompt: string }
  | { type: 'background:changed' }
  | { type: 'mcp:auth-url'; server: string; url: string }
  | { type: 'shell:output'; id: string; data: string }
  | { type: 'shell:exit'; id: string; exitCode: number; signal?: number }
  | { type: 'smoke:result'; report: SmokeReport }

/** Main -> runtime utility process. */
export type RuntimeInbound =
  | { kind: 'request'; request: RuntimeRequest }
  | { kind: 'main-response'; id: string; ok: true; result: unknown }
  | { kind: 'main-response'; id: string; ok: false; error: string }
  | { kind: 'shutdown' }

/** Runtime -> main calls that only the Electron main process can serve. */
export type MainRequestMethod =
  | 'app:render-pdf'
  | 'app:notify'
  | 'app:reveal-path'
  | 'app:safe-storage-status'
  | 'app:safe-storage-encrypt'
  | 'app:safe-storage-decrypt'

/** Fields are method-specific; only `app:render-pdf` uses html/title, the
 *  safeStorage methods use `data` (plain text or base64 ciphertext), and
 *  `app:notify` uses title/body. */
export type MainRequestParams = {
  html?: string
  title?: string
  body?: string
  data?: string
  path?: string
  sessionId?: string
}

/** Runtime utility process -> main. */
export type RuntimeOutbound =
  | { kind: 'response'; response: RuntimeResponse }
  | { kind: 'event'; event: RuntimeEvent }
  | { kind: 'ready'; pid: number; versions: Record<string, string> }
  | { kind: 'main-request'; id: string; method: MainRequestMethod; params: MainRequestParams }

// ─── UI smoke ───────────────────────────────────────────────────────────────

export interface UiSmokeCheck {
  ok: boolean
  detail: string
}

export interface UiSmokeResult {
  ok: boolean
  checks: Record<string, UiSmokeCheck>
  error?: string
}

/** Preload bridge exposed on `window.xcode`. */
export interface XcodeBridge {
  request(request: RuntimeRequest): Promise<RuntimeResponse>
  onEvent(listener: (event: RuntimeEvent) => void): () => void
  /** Used only by `--ui-smoke`: report renderer-side results and exit. */
  reportUiSmoke(result: UiSmokeResult): void
  /** Copies text through Electron's clipboard (file:// pages have no
   *  reliable navigator.clipboard permission). */
  copyText(text: string): void
  /** Resolves a dropped File to its filesystem path (sandboxed renderers
   *  cannot read `File.path`). Returns '' when unavailable. */
  pathForFile(file: unknown): string
  platform: string
}
