import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import {
  KEEP_RECENT_TOKENS,
  MIN_CONTEXT_WINDOW_OVERRIDE,
  PROVIDERS,
  WEB_SEARCH_PROVIDERS,
  addSessionAllowRule,
  agentLoop,
  appendCheckpoint,
  buildContextBreakdownInput,
  buildUserContent,
  calibrateContextBreakdown,
  capabilitiesOf,
  captureSessionForkSnapshot,
  classifyApiError,
  clearDocumentLibrary,
  clearPluginEntry,
  clearPluginUserConfig,
  compressTrackedMessagesWithUsage,
  createLoopState,
  createModelRegistry,
  deleteSession as deleteSessionFile,
  estimateContextBreakdown,
  expandCommandBody,
  extractFileReferences,
  extractText,
  forkSession as forkSessionFile,
  getContextWindow,
  getDiffStatsForCheckpoint,
  getModelContextWindowOverride,
  getPermissionLevel,
  getPluginUserConfig,
  hydrateLoopState,
  indexLibrary,
  libraryStats,
  listSessions,
  loadLocalHookConfigs,
  loadPluginCommands,
  loadUserConfig,
  localHookPaths,
  markBoundaryAndReflush,
  modelSupportsVision,
  parseHookConfig,
  persistRule,
  readPersistedRules,
  reloadSkillRegistry,
  removePersistedRule,
  removeSessionAllowRule,
  renameSession as renameSessionFile,
  restoreCheckpoint,
  salvageSession as salvageSessionFile,
  saveSession,
  saveUserConfig,
  scanWorkspaceFiles,
  scoreAndRank,
  searchLibrary,
  setModelContextWindowOverrides,
  setPluginEnabled,
  setPluginUserConfig,
  setShellSandbox,
  setSkillDisabled,
  shutdownBrowserMcp,
  testWebSearchProvider,
  toolRegistry,
  transcribeAudio,
  uninstallPlugin,
  userXcodeDir,
} from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AllowRule,
  AuthorityApproval,
  EditDiffPayload,
  FileEntry,
  IngestedPart,
  LanguageModel,
  LoopState,
  PermissionDecision,
  StreamRetryEvent,
  TodoItem,
  TokenUsage,
  UserConfigItem,
} from '@x-code-cli/core'

import { DEFAULT_UPDATE_FEED } from '../shared/constants.js'
import type {
  AppState,
  ApprovalKind,
  ApprovalRequestEvent,
  BackgroundShellView,
  BackupExportView,
  BackupImportView,
  BranchListView,
  CompactResult,
  CustomCommandView,
  DiagnosticsExportResult,
  EnvironmentRefreshResult,
  FileEditView,
  FileReadView,
  FileTreeEntryView,
  GitStatusView,
  HooksView,
  LibraryIndexResultView,
  LibrarySearchView,
  LibraryStatsView,
  LoadedSessionView,
  MarketplaceListView,
  McpServerView,
  MemoryPanelView,
  PermissionRuleType,
  PermissionRulesResult,
  PluginConsentPreviewView,
  PluginInstallResult,
  PluginInstallTarget,
  PluginSettingsView,
  ProjectCheckResultView,
  ProjectSettingsView,
  ProviderSettingsView,
  RewindCheckpointView,
  RewindResultView,
  RuntimeEvent,
  SearchProviderView,
  SearchTestResult,
  SessionListItem,
  SessionSearchResult,
  SettingsActionResult,
  SettingsSnapshot,
  SkillImportResult,
  SkillMarketListView,
  SkillMarketProvider,
  SkillSettingsView,
  StorageUsageView,
  TestConnectionResult,
  TextReport,
  ToolSettingsView,
  UsageView,
  UserConfigFieldView,
  UserConfigValues,
  WorkspaceInsightsView,
  WorkspaceList,
  WorktreeOpenResult,
} from '../shared/protocol.js'
import { DEMO_MODEL_ID, bootstrapRuntime } from './bootstrap.js'
import type { RuntimeBootstrap } from './bootstrap.js'
import { testProviderConnection } from './connection-test.js'
import { createDemoModel } from './demo-model.js'
import { applySearchProviderPreference, loadDesktopSettings, saveDesktopSettings } from './desktop-settings.js'
import type { ProjectOverrides } from './desktop-settings.js'
import { recentDocuments } from './document-store.js'
import {
  createBranchWorktree,
  createTurnCheckpoint,
  gitBranches,
  gitFileDiff,
  gitStatus,
  openBranchWorktree,
  pruneWorktrees,
  removeBranchWorktree,
  undoCheckpoint,
} from './git.js'
import type { GitCheckpoint } from './git.js'
import { discoverLocalModels, withLocalModels } from './local-models.js'
import { requestMain } from './main-bridge.js'
import { addMarketplace, installMarketplacePluginInfo, listMarketplacePlugins } from './marketplace-service.js'
import { McpService } from './mcp-service.js'
import { normalizeNewPermissionRule, visiblePermissionRules } from './permission-rules.js'
import {
  coerceUserConfigValue,
  installPluginTarget,
  installPluginWithConsent,
  previewPluginInstall,
} from './plugin-install.js'
import {
  checkCommandLabel,
  detectProjectChecks,
  failuresForAgent,
  runProjectChecks,
  summarizeCheckResults,
} from './project-checks.js'
import type { CheckResult } from './project-checks.js'
import {
  clearProviderKey,
  clearSearchKey as clearStoredSearchKey,
  providerSecretStatus,
  saveCustomBaseUrl,
  saveProviderKey,
  saveSearchKey,
  searchSecretStatus,
  secretStorageKind,
} from './secrets.js'
import { listSessionItems, loadSessionView, searchSessionItems, toSessionMessages, usageView } from './sessions.js'
import { refreshShellEnvironment } from './shell-env.js'
import { importSkillIntoUserDir } from './skill-import.js'
import { installSkillsFromCommand, isPluginInstallCommand } from './skill-install-command.js'
import type { CopiedSkill } from './skill-install-command.js'
import { assertGitHubSkillUrl, installSkillHubSkill, searchSkillMarket } from './skill-market.js'
import {
  applySkillRuntimeHints,
  clearLegacySkillRuntime as clearLegacyRuntime,
  clearSkillRuntime as clearRuntime,
  installSkillRuntime as installRuntime,
  skillRuntimeView,
} from './skill-runtime.js'
import { DEFAULT_TASK_MODE, isTaskMode, taskModeInstruction } from './task-modes.js'
import type { TaskMode } from './task-modes.js'
import { exportUserBackup, importUserBackup } from './user-backup.js'

interface ActiveTurn {
  id: string
  text: string
}

interface PendingApproval {
  kind: ApprovalKind
  resolve: (value: unknown) => void
  authority?: { canonicalCallSha256: string; authorityHash: string }
}

export interface TurnResult {
  text: string
  reason: string
  sessionId: string
  modelId: string
}

const FILE_TREE_SKIP = new Set([
  '.git',
  '.x-code',
  '.DS_Store',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
])
const MAX_EDITOR_READ_BYTES = 1_000_000
const MAX_EDITOR_WRITE_BYTES = 2_000_000

/** Chinese labels for the built-in tool surface. The model-facing tool names
 *  and English descriptions stay untouched. */
const TOOL_META: Record<string, { label: string; description: string }> = {
  readFile: { label: '读取文件', description: '读取本地文件的完整内容' },
  readDocument: {
    label: '读取文档',
    description: '从 PDF、Word、Excel、Markdown、CSV、EPUB、MOBI、图片、音频、视频中提取文本与元数据（本地解析）',
  },
  writeFile: { label: '写入文件', description: '创建或覆盖本地文件（写入权限）' },
  edit: { label: '编辑文件', description: '对文件做精确查找替换（写入权限）' },
  shell: { label: '执行命令', description: '运行 shell 命令并返回输出（写入权限）' },
  glob: { label: '查找文件', description: '按 glob 模式查找文件' },
  grep: { label: '搜索内容', description: '按正则搜索文件内容' },
  listDir: { label: '列出目录', description: '列出目录中的文件与子目录' },
  webSearch: { label: '联网搜索', description: '通过搜索服务检索网页' },
  webFetch: { label: '抓取网页', description: '抓取指定 URL 的网页内容' },
  askUser: { label: '询问用户', description: '向用户提出一个选择题' },
  enterPlanMode: { label: '进入计划模式', description: '切换到只读计划模式' },
  exitPlanMode: { label: '退出计划模式', description: '提交计划并请求批准' },
  todoWrite: { label: '待办清单', description: '更新当前任务的待办列表' },
  shellOutput: { label: '读取后台输出', description: '读取后台 shell 的输出' },
  killShell: { label: '终止后台进程', description: '终止一个后台 shell 进程（写入权限）' },
  batchRename: {
    label: '批量重命名',
    description: '按规则批量为文件改名，默认仅预览、不覆盖、上限 100 个（写入权限）',
  },
  convert: { label: '格式转换', description: '合并 PDF、提取 PDF 页面、macOS 图片格式转换（写入权限）' },
  transcribe: { label: '语音转写', description: '用本机 whisper 将音频转写为带时间戳的文本，音频不上传' },
  spreadsheet: { label: '表格处理', description: '读取、过滤聚合、写回 xlsx，并生成简单 SVG 图表（写入需授权）' },
  documentSearch: { label: '文档检索', description: '在本地文档库中做关键词与语义混合检索，返回文件、页码与片段' },
  documentLibrary: { label: '文档库', description: '索引文件夹、查看统计或清空本地文档库（清空需授权）' },
}

function toCheckResultView(result: CheckResult): ProjectCheckResultView {
  return {
    id: result.id,
    label: result.label,
    kind: result.kind,
    commandLine: checkCommandLabel(result),
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.output,
  }
}

function toUserConfigFields(items: UserConfigItem[] | undefined): UserConfigFieldView[] {
  return (items ?? []).map((item) => ({
    key: item.key,
    type: item.type,
    sensitive: item.sensitive === true,
    ...(item.prompt ? { prompt: item.prompt } : {}),
    required: item.required === true,
    ...(item.default !== undefined ? { default: item.default } : {}),
    ...(item.description ? { description: item.description } : {}),
  }))
}

function toUsageView(usage: TokenUsage, modelId: string): UsageView {
  return usageView(usage, modelId)
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/** Resolve the deepest existing ancestor through symlinks, then append the
 *  missing suffix. Mirrors core's permission-path helper without exporting
 *  another public API. */
async function directoryStats(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(target)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(target)
          bytes += stat.size
          files += 1
        } catch {
          // Vanished during the scan.
        }
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

function realpathAllowMissing(target: string): string {
  const suffix: string[] = []
  let current = target
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

function toFileEditView(payload: EditDiffPayload): FileEditView {
  return {
    filePath: payload.filePath,
    additions: payload.additions,
    removals: payload.removals,
    isCreate: payload.isCreate,
    content: payload.content,
    revertible: payload.afterContent !== undefined && (payload.isCreate || payload.beforeContent !== undefined),
    hunks: payload.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
    })),
  }
}

function toTodoViews(todos: TodoItem[]): Array<{ content: string; activeForm: string; status: TodoItem['status'] }> {
  return todos.map((todo) => ({ content: todo.content, activeForm: todo.activeForm, status: todo.status }))
}

const SKILL_SIGNATURE_SKIP = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'runtime',
  'models',
  'dist',
  'build',
  'target',
])

/** Cheap change detector for external skill installs. Walks only skill
 *  directories (bounded depth) and hashes path+mtime+size of SKILL.md. */
async function collectSkillSignatures(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKILL_SIGNATURE_SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSkillSignatures(full, depth + 1, out)
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      try {
        const stat = await fs.promises.stat(full)
        out.push(`${full}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        // Vanished while walking.
      }
    }
  }
}

export class AgentHost {
  private bootstrap: RuntimeBootstrap | null = null
  private state: AppState | null = null
  private loopState: LoopState | null = null
  private model: LanguageModel | null = null
  private modelId = DEMO_MODEL_ID
  private demo = true
  private activeTurn: ActiveTurn | null = null
  private controller: AbortController | null = null
  private approvals = new Map<string, PendingApproval>()
  private mcp: McpService | null = null
  private disabledTools = new Set<string>()
  private autoAllowedTools = new Set<string>()
  private alwaysAllowAll = false
  private workspaceOverride: string | undefined
  /** This runtime was started for a specific window workspace (e.g. a worktree). */
  private fixedWorkspace = false
  private reloadingSettings: Promise<void> | null = null
  private fileIndex: { workspace: string; entries: FileEntry[]; at: number } | null = null
  private taskMode: TaskMode = DEFAULT_TASK_MODE
  private autoChecksRunning = false
  private lastCheckResults: CheckResult[] = []
  private gitCheckpoints = new Map<string, GitCheckpoint>()
  private latestCheckpoint: GitCheckpoint | null = null
  private editHistory = new Map<
    string,
    { filePath: string; beforeContent?: string; afterContent?: string; isCreate: boolean }
  >()
  private shellUnsubscribe: (() => void) | null = null
  private turnSeq = 0
  private approvalSeq = 0
  private skillPollTimer: ReturnType<typeof setInterval> | null = null
  private skillSignature = ''

  constructor(
    private readonly send: (event: RuntimeEvent) => void,
    private readonly options: { workspace?: string } = {},
  ) {}

  async init(): Promise<AppState> {
    const savedSettings = loadDesktopSettings()
    const requestedWorkspace = this.options.workspace?.trim()
    const pinnedWorkspace =
      requestedWorkspace && fs.existsSync(requestedWorkspace) && fs.statSync(requestedWorkspace).isDirectory()
        ? path.resolve(requestedWorkspace)
        : undefined
    const savedWorkspace = savedSettings.lastWorkspace
    if (pinnedWorkspace) {
      this.workspaceOverride = pinnedWorkspace
    } else if (savedWorkspace && fs.existsSync(savedWorkspace) && fs.statSync(savedWorkspace).isDirectory()) {
      this.workspaceOverride = savedWorkspace
    }
    this.bootstrap = await bootstrapRuntime(this.workspaceOverride)
    this.taskMode = isTaskMode(savedSettings.taskMode) ? savedSettings.taskMode : DEFAULT_TASK_MODE
    // A window explicitly opened on a worktree must not become the workspace
    // used by the next fresh launch, even if the user switches projects in it.
    this.fixedWorkspace = Boolean(pinnedWorkspace)
    this.rememberWorkspace(this.bootstrap.workspace, !this.fixedWorkspace)
    this.model = this.bootstrap.model
    this.modelId = this.bootstrap.modelId
    this.demo = this.bootstrap.demo
    this.state = { ...this.bootstrap.appState }
    const desktopSettings = loadDesktopSettings()
    this.disabledTools = new Set(desktopSettings.disabledTools ?? [])
    this.autoAllowedTools = new Set(desktopSettings.autoAllowedTools ?? [])
    this.alwaysAllowAll = desktopSettings.alwaysAllowAll === true
    this.bootstrap.baseOptions.trustMode = this.alwaysAllowAll
    this.applyToolFilter()
    this.mcp = new McpService(
      this.bootstrap.workspace,
      this.bootstrap.mcpExtraServers,
      () => {
        this.invalidatePromptCache()
        void this.emitSettings()
      },
      (server, url) => this.send({ type: 'mcp:auth-url', server, url }),
    )
    try {
      await this.mcp.load()
    } catch (error) {
      this.send({
        type: 'runtime:log',
        level: 'warn',
        message: `mcp load failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    this.rewireMcp()
    if (this.bootstrap.hookBus.has('SessionStart')) {
      void this.bootstrap.hookBus
        .emit({ name: 'SessionStart', session: { cwd: this.bootstrap.workspace, modelId: this.modelId } })
        .catch(() => undefined)
    }
    this.applyProjectOverrides()
    this.send({ type: 'app:state', state: this.getState() })
    void this.emitSettings()
    this.startSkillPolling()
    return this.getState()
  }

  getState(): AppState {
    if (!this.state) throw new Error('runtime-not-initialized')
    return {
      ...this.state,
      permissionMode: this.loopState?.permissionMode ?? this.state.permissionMode,
      taskMode: this.taskMode,
      contextWindow: getContextWindow(this.modelId),
      models: [...this.state.models],
      providers: [...this.state.providers],
    }
  }

  async listSessions(): Promise<SessionListItem[]> {
    const settings = loadDesktopSettings()
    const pinned = new Set(settings.pinnedSessions ?? [])
    const archived = new Set(settings.archivedSessions ?? [])
    const items = await listSessionItems(this.requireBootstrap().workspace)
    return items.map((item) => ({
      ...item,
      pinned: pinned.has(item.filePath),
      archived: archived.has(item.filePath),
    }))
  }

  listWorkspaces(): WorkspaceList {
    const current = this.requireBootstrap().workspace
    const recent = loadDesktopSettings().recentProjects ?? []
    const all = [current, ...recent.filter((entry) => path.resolve(entry) !== path.resolve(current))]
    return {
      current,
      projects: all.slice(0, 20).map((entry) => ({
        path: entry,
        name: path.basename(entry) || entry,
        current: path.resolve(entry) === path.resolve(current),
      })),
    }
  }

  /** Backs the renderer's `@` menu. The scan is cached briefly per workspace:
   *  a query changes on every keystroke but the index does not. Queries are
   *  ranked against workspace-relative paths, so an absolute path fragment
   *  (what the menu itself inserts) is normalized first. */
  async listWorkspaceFiles(
    query: string,
    limit = 20,
  ): Promise<Array<{ path: string; relative: string; isDirectory: boolean }>> {
    const workspace = this.requireBootstrap().workspace
    const now = Date.now()
    if (!this.fileIndex || this.fileIndex.workspace !== workspace || now - this.fileIndex.at > 15_000) {
      const entries = await scanWorkspaceFiles({ rootDir: workspace })
      this.fileIndex = { workspace, entries, at: now }
    }
    const prefix = workspace.endsWith(path.sep) ? workspace : workspace + path.sep
    let normalized = query.replace(/\\/g, '/')
    const normalizedPrefix = prefix.replace(/\\/g, '/')
    if (normalized.startsWith(normalizedPrefix)) normalized = normalized.slice(normalizedPrefix.length)
    else if (normalized.startsWith('/')) normalized = normalized.replace(/^\/+/, '')
    return scoreAndRank(this.fileIndex.entries, normalized)
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((entry) => ({
        path: path.join(workspace, entry.relPath),
        relative: entry.relPath,
        isDirectory: entry.isDirectory,
      }))
  }

  /** Cheap workspace shape used by the empty-state starter actions. Only the
   *  top level is inspected; no recursive scan. */
  async workspaceInsights(): Promise<WorkspaceInsightsView> {
    const workspace = this.requireBootstrap().workspace
    const names = await fs.promises.readdir(workspace).catch(() => [] as string[])
    const lower = names.map((name) => name.toLowerCase())
    const hasExtension = (extensions: string[]): boolean =>
      lower.some((name) => extensions.some((extension) => name.endsWith(extension)))
    const [checks, git] = await Promise.all([
      detectProjectChecks(workspace).catch(() => []),
      gitStatus(workspace).catch(() => null),
    ])
    const recent = recentDocuments()[0]
    return {
      hasPackageJson: lower.includes('package.json'),
      hasReadme: lower.some((name) => name.startsWith('readme')),
      hasCargo: lower.includes('cargo.toml'),
      hasTex: hasExtension(['.tex']),
      hasBib: hasExtension(['.bib']),
      hasSpreadsheet: hasExtension(['.xlsx', '.xls', '.csv', '.ods']),
      hasDocuments: hasExtension(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.odt', '.odp']) || recent !== undefined,
      ...(recent ? { recentDocument: { name: recent.name, path: recent.path } } : {}),
      checks: checks.map((check) => ({
        id: check.id,
        label: check.label,
        commandLine: [check.command, ...check.args].join(' '),
      })),
      git: { isRepo: git?.isRepo === true, changeCount: git?.files.length ?? 0 },
    }
  }

  async switchWorkspace(nextPath: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const resolved = path.resolve(nextPath)
    let stat: fs.Stats | null = null
    try {
      stat = await fs.promises.stat(resolved)
    } catch {
      stat = null
    }
    if (!stat?.isDirectory()) throw new Error(`项目目录不存在：${resolved}`)
    if (path.resolve(this.requireBootstrap().workspace) === resolved) return this.settingsResult()

    if (this.loopState && this.loopState.messages.length > 0) {
      const model = this.demo ? createDemoModel() : this.model
      if (model) await saveSession(this.loopState, model).catch(() => undefined)
    }
    this.cancelAllApprovals()
    this.workspaceOverride = resolved
    this.shellUnsubscribe?.()
    this.shellUnsubscribe = null
    this.loopState = null
    this.fileIndex = null
    this.clearGitCheckpoints()
    await this.reloadExtensions(this.modelId)
    this.rememberWorkspace(resolved, !this.fixedWorkspace)
    this.send({ type: 'app:state', state: this.getState() })
    void this.emitSettings()
    return this.settingsResult()
  }

  private rememberWorkspace(workspace: string, persistLast = true): void {
    const resolved = path.resolve(workspace)
    const existing = loadDesktopSettings().recentProjects ?? []
    const next = [resolved, ...existing.filter((entry) => path.resolve(entry) !== resolved)].slice(0, 20)
    saveDesktopSettings({ recentProjects: next, ...(persistLast ? { lastWorkspace: resolved } : {}) })
  }

  async loadSession(filePath: string): Promise<LoadedSessionView> {
    if (this.activeTurn) throw new Error('turn-busy')
    this.cancelAllApprovals()
    const loaded = await loadSessionView(filePath)
    if (!loaded) throw new Error(`session-not-found: ${filePath}`)
    if (loaded.loaded.transcriptIntegrity === 'failed') {
      throw new Error('该会话的 transcript 完整性校验失败，可能已损坏，已拒绝加载。')
    }

    let modelChanged = false
    if (loaded.view.modelId && loaded.view.modelId !== this.modelId) {
      try {
        this.applyModel(loaded.view.modelId, false)
        modelChanged = true
      } catch {
        // Keep the current model when the saved one is no longer available.
      }
    }

    this.loopState = hydrateLoopState(loaded.loaded, 'default', this.requireBootstrap().workspace)
    this.watchShellSessions(this.loopState)
    this.clearGitCheckpoints()
    if (modelChanged) this.send({ type: 'app:state', state: this.getState() })
    return loaded.view
  }

  /** Recover parseable messages from a damaged transcript into a new session.
   *  The source file is left untouched; this is only invoked from the explicit
   *  recovery dialog. */
  async salvageSession(
    filePath: string,
  ): Promise<{ sessionId: string; filePath: string; messageCount: number; view: LoadedSessionView }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const salvaged = await salvageSessionFile(filePath)
    const loaded = await loadSessionView(salvaged.filePath)
    if (!loaded) throw new Error('恢复会话写入后无法读取')
    let modelChanged = false
    if (loaded.view.modelId && loaded.view.modelId !== this.modelId) {
      try {
        this.applyModel(loaded.view.modelId, false)
        modelChanged = true
      } catch {
        // Keep the current model when the saved one is no longer available.
      }
    }
    this.cancelAllApprovals()
    this.loopState = hydrateLoopState(loaded.loaded, 'default', this.requireBootstrap().workspace)
    this.watchShellSessions(this.loopState)
    this.clearGitCheckpoints()
    if (modelChanged) this.send({ type: 'app:state', state: this.getState() })
    return {
      sessionId: loaded.view.sessionId,
      filePath: loaded.view.filePath,
      messageCount: salvaged.messageCount,
      view: loaded.view,
    }
  }

  newSession(): { sessionId: string } {
    if (this.activeTurn) throw new Error('turn-busy')
    this.cancelAllApprovals()
    this.loopState = createLoopState('default', { projectCwd: this.requireBootstrap().workspace })
    this.watchShellSessions(this.loopState)
    this.clearGitCheckpoints()
    return { sessionId: this.loopState.sessionId }
  }

  /** Subscribe to background shell lifecycle so the renderer's task panel can
   *  refresh and long-running commands can raise a system notification even
   *  when the turn that started them has already ended. */
  private watchShellSessions(state: LoopState): void {
    this.shellUnsubscribe?.()
    this.shellUnsubscribe = state.shellSessions.subscribe((event) => {
      if (event.kind === 'snapshot') {
        this.send({ type: 'background:changed' })
        return
      }
      if (event.kind === 'started' || event.kind === 'yielded') {
        this.send({ type: 'background:changed' })
        return
      }
      if (event.kind === 'root-exited' || event.kind === 'residual-registered') {
        this.send({ type: 'background:changed' })
        if (!this.activeTurn && event.kind === 'root-exited') {
          this.notify(
            '后台任务已结束',
            `退出码 ${event.exitCode ?? '未知'} · ${event.shellId}`,
            this.loopState?.sessionId,
          )
        }
      }
    })
  }

  private notify(title: string, body: string, sessionId?: string): void {
    if (loadDesktopSettings().notifications === false) return
    void requestMain('app:notify', {
      title,
      body,
      ...(sessionId ? { sessionId } : {}),
    }).catch(() => undefined)
  }

  rewindCheckpoints(): RewindCheckpointView[] {
    return (this.loopState?.checkpoints ?? []).map((checkpoint) => ({
      ckptId: checkpoint.ckptId,
      ts: checkpoint.ts,
      userPrompt: checkpoint.userPrompt,
      messageCount: checkpoint.messageCount,
    }))
  }

  async checkpointDiff(
    ckptId: string,
  ): Promise<{ filesChanged: string[]; insertions: number; deletions: number } | null> {
    const state = this.loopState
    if (!state) return null
    return getDiffStatsForCheckpoint(state, ckptId, state.projectCwd)
  }

  async rewind(ckptId: string, mode: 'both' | 'code' | 'conversation' = 'both'): Promise<RewindResultView> {
    if (this.activeTurn) throw new Error('turn-busy')
    const state = this.loopState
    if (!state) throw new Error('没有可回退的会话')
    const target = state.checkpoints.find((checkpoint) => checkpoint.ckptId === ckptId)
    if (!target) throw new Error('找不到该检查点（可能已被上下文压缩清理）')

    let restoredFiles = 0
    if (mode === 'both' || mode === 'code') {
      const stats = await getDiffStatsForCheckpoint(state, ckptId, state.projectCwd)
      const restored = await restoreCheckpoint(state, ckptId, state.projectCwd)
      if (!restored) throw new Error('无法读取检查点备份，文件可能已被清理')
      restoredFiles = stats?.filesChanged.length ?? 0
    }

    let messageCount = state.messages.length
    if (mode === 'both' || mode === 'conversation') {
      messageCount = Math.max(0, target.messageCount - 1)
      const candidate = state.trackedMessages.slice(0, messageCount)
      const surviving = state.checkpoints.filter((checkpoint) => checkpoint.messageCount <= candidate.length)
      await markBoundaryAndReflush(state, undefined, candidate)
      state.checkpoints = surviving
      for (const checkpoint of surviving) await appendCheckpoint(state, checkpoint)
    }

    this.cancelAllApprovals()
    this.clearGitCheckpoints()
    return {
      ok: true,
      mode,
      restoredFiles,
      messageCount,
      view: {
        sessionId: state.sessionId,
        filePath: state.sessionFilePath ?? '',
        modelId: this.modelId,
        messages: toSessionMessages(state.messages),
        usage: usageView(state.tokenUsage, this.modelId),
      },
    }
  }

  /** Branch the current conversation into a new session file and make it the
   *  active one. The source session is left untouched on disk. */
  async forkCurrentSession(name?: string): Promise<{ sessionId: string; filePath: string; view: LoadedSessionView }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const state = this.loopState
    if (!state || state.trackedMessages.length === 0) throw new Error('当前会话还没有内容，无法派生')
    const snapshot = captureSessionForkSnapshot(state)
    const stamp = new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const forked = await forkSessionFile(snapshot, this.modelId, {
      cwd: this.requireBootstrap().workspace,
      name: name?.trim() || `分支 ${stamp}`,
    })
    const loaded = await loadSessionView(forked.filePath)
    if (!loaded) throw new Error('派生会话写入后无法读取')
    this.cancelAllApprovals()
    this.loopState = hydrateLoopState(loaded.loaded, 'default', this.requireBootstrap().workspace)
    this.watchShellSessions(this.loopState)
    this.clearGitCheckpoints()
    return { sessionId: loaded.view.sessionId, filePath: loaded.view.filePath, view: loaded.view }
  }

  backgroundSessions(): BackgroundShellView[] {
    const sessions = this.loopState?.shellSessions.list() ?? []
    const now = performance.now()
    return sessions.map((session) => ({
      shellId: session.shellId,
      command: session.command,
      cwd: session.effectiveCwd,
      status: session.status,
      tty: session.tty,
      ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
      ...(session.startedAt !== undefined
        ? { elapsedMs: Math.max(0, Math.round((session.exitedAt ?? now) - session.startedAt)) }
        : {}),
      outputBytes: session.omittedBytes + Buffer.byteLength(session.recentOutput, 'utf8'),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      timedOut: session.timedOut,
      ...(session.failure ? { failure: session.failure.message } : {}),
      recentOutput: session.recentOutput,
      omittedBytes: session.omittedBytes,
    }))
  }

  async stopBackgroundShell(shellId: string): Promise<{ ok: boolean }> {
    const manager = this.loopState?.shellSessions
    if (!manager) return { ok: false }
    await manager.terminate(shellId, 'kill-tool')
    return { ok: true }
  }

  async libraryStats(): Promise<LibraryStatsView> {
    const stats = await libraryStats()
    const settings = loadDesktopSettings()
    return {
      ...stats,
      lastRoot: settings.libraryRoot,
      semanticEnabled: settings.librarySemantic === true,
    }
  }

  librarySetSemantic(enabled: boolean): { enabled: boolean } {
    saveDesktopSettings({ librarySemantic: enabled })
    return { enabled }
  }

  async libraryIndex(
    target: string,
    options: { recursive?: boolean; semantic?: boolean } = {},
  ): Promise<LibraryIndexResultView> {
    const resolved = path.resolve(target)
    const semantic = options.semantic ?? loadDesktopSettings().librarySemantic === true
    const result = await indexLibrary(resolved, {
      recursive: options.recursive !== false,
      semantic,
      onProgress: (progress) => this.send({ type: 'library:progress', ...progress }),
    })
    saveDesktopSettings({ libraryRoot: resolved, librarySemantic: semantic })
    return result
  }

  async librarySearch(query: string, limit?: number, scope?: string): Promise<LibrarySearchView> {
    const settings = loadDesktopSettings()
    return searchLibrary(query, {
      limit,
      path: scope,
      semantic: settings.librarySemantic !== false,
    })
  }

  async libraryClear(): Promise<null> {
    await clearDocumentLibrary()
    return null
  }

  async gitStatusView(): Promise<GitStatusView> {
    return gitStatus(
      this.requireBootstrap().workspace,
      this.latestCheckpoint
        ? { turnId: this.latestCheckpoint.turnId, createdAt: this.latestCheckpoint.createdAt }
        : undefined,
    )
  }

  async gitDiff(relativePath: string, staged?: boolean): Promise<{ diff: string; truncated: boolean }> {
    return gitFileDiff(this.requireBootstrap().workspace, relativePath, staged === true)
  }

  async gitBranchList(): Promise<BranchListView> {
    return gitBranches(this.requireBootstrap().workspace)
  }

  async openWorktree(branch: string, remoteRef?: string): Promise<WorktreeOpenResult> {
    return openBranchWorktree(this.requireBootstrap().workspace, branch, remoteRef)
  }

  async createWorktree(branch: string, from?: string, parentDir?: string): Promise<WorktreeOpenResult> {
    return createBranchWorktree(this.requireBootstrap().workspace, branch, from, parentDir)
  }

  async removeWorktree(
    targetPath: string,
    force?: boolean,
  ): Promise<{ path: string; removed: boolean; forced: boolean }> {
    return removeBranchWorktree(this.requireBootstrap().workspace, targetPath, force === true)
  }

  async pruneWorktrees(): Promise<{ ok: boolean }> {
    await pruneWorktrees(this.requireBootstrap().workspace)
    return { ok: true }
  }

  /** Revert one edit/write tool call using the snapshots captured before and
   *  after it ran. Refuses when the file has changed since (the user or a
   *  later tool touched it), so a stale revert can never clobber newer work. */
  async revertEdit(toolCallId: string): Promise<{ ok: boolean; filePath: string; message: string }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const entry = this.editHistory.get(toolCallId)
    if (!entry) throw new Error('找不到这次编辑的快照（可能来自已恢复的旧会话）')
    if (entry.afterContent === undefined || (!entry.isCreate && entry.beforeContent === undefined)) {
      throw new Error('文件过大，没有保存可回退的快照')
    }
    const absolute = path.resolve(this.requireBootstrap().workspace, entry.filePath)
    const current = await fs.promises.readFile(absolute, 'utf-8').catch(() => null)
    if (current !== entry.afterContent) {
      throw new Error('文件之后又被修改过，无法只回退这一次编辑')
    }
    if (entry.isCreate) await fs.promises.unlink(absolute)
    else await fs.promises.writeFile(absolute, entry.beforeContent!, 'utf-8')
    this.editHistory.delete(toolCallId)
    return {
      ok: true,
      filePath: absolute,
      message: entry.isCreate ? '已删除本次新建的文件' : '已恢复编辑前的内容',
    }
  }

  async undoGitTurn(turnId?: string): Promise<{ ok: boolean; restored: number; deleted: number; message: string }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const checkpoint = turnId ? this.gitCheckpoints.get(turnId) : this.latestCheckpoint
    if (!checkpoint) throw new Error('没有可撤销的 checkpoint（本轮可能尚未产生改动）')
    const result = await undoCheckpoint(checkpoint)
    this.gitCheckpoints.delete(checkpoint.turnId)
    if (this.latestCheckpoint?.turnId === checkpoint.turnId) this.latestCheckpoint = null
    return { ok: true, ...result }
  }

  private clearGitCheckpoints(): void {
    this.gitCheckpoints.clear()
    this.latestCheckpoint = null
  }

  async renameSession(filePath: string, name: string): Promise<{ name: string }> {
    const renamed = await renameSessionFile(filePath, name)
    return { name: renamed }
  }

  async deleteSession(filePath: string): Promise<{ deleted: boolean; resetActive: boolean }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const fileId = path.basename(filePath, '.jsonl')
    const resetActive = this.loopState?.sessionId === fileId
    await deleteSessionFile(filePath)
    if (resetActive) {
      this.cancelAllApprovals()
      this.shellUnsubscribe?.()
      this.shellUnsubscribe = null
      this.loopState = null
    }
    return { deleted: true, resetActive }
  }

  setSessionPinned(filePath: string, pinned: boolean): { pinned: boolean } {
    const settings = loadDesktopSettings()
    const next = new Set(settings.pinnedSessions ?? [])
    if (pinned) next.add(filePath)
    else next.delete(filePath)
    saveDesktopSettings({ pinnedSessions: [...next] })
    return { pinned }
  }

  setSessionArchived(filePath: string, archived: boolean): { archived: boolean } {
    const settings = loadDesktopSettings()
    const next = new Set(settings.archivedSessions ?? [])
    if (archived) next.add(filePath)
    else next.delete(filePath)
    saveDesktopSettings({ archivedSessions: [...next] })
    return { archived }
  }

  async searchSessions(query: string, limit?: number): Promise<{ results: SessionSearchResult[] }> {
    return { results: await searchSessionItems(this.requireBootstrap().workspace, query, limit) }
  }

  async exportSession(filePath: string, format: 'markdown' | 'json' | 'pdf'): Promise<{ path: string; size: number }> {
    const loaded = await loadSessionView(filePath)
    if (!loaded) throw new Error(`会话不存在：${filePath}`)
    const view = loaded.view
    const title = view.messages.find((message) => message.role === 'user')?.text.slice(0, 60) || view.sessionId
    const safeTitle =
      title
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'session'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = process.env.X_CODE_EXPORT_DIR?.trim() || path.join(os.homedir(), 'Downloads')
    await fs.promises.mkdir(dir, { recursive: true })

    if (format === 'json') {
      const target = path.join(dir, `x-code-${safeTitle}-${stamp}.json`)
      const data = JSON.stringify(
        {
          sessionId: view.sessionId,
          filePath: view.filePath,
          modelId: view.modelId,
          name: title,
          usage: view.usage,
          messages: view.messages,
        },
        null,
        2,
      )
      await fs.promises.writeFile(target, data, 'utf-8')
      return { path: target, size: Buffer.byteLength(data) }
    }

    if (format === 'markdown') {
      const lines: string[] = [
        `# ${title}`,
        '',
        `- 会话：${view.sessionId}`,
        `- 模型：${view.modelId}`,
        `- 用量：↑${view.usage.inputTokens} ↓${view.usage.outputTokens}`,
        '',
      ]
      for (const message of view.messages) {
        if (message.role === 'user') lines.push('## 你', '', message.text, '')
        else if (message.role === 'assistant') lines.push('## X-CODE', '', message.text, '')
        else if (message.role === 'system') lines.push(`> ${message.text}`, '')
        else if (message.role === 'tool' && message.toolOutput) {
          lines.push(`### 工具 · ${message.toolName ?? ''}`, '', '```', message.toolOutput.slice(0, 4000), '```', '')
        }
      }
      const target = path.join(dir, `x-code-${safeTitle}-${stamp}.md`)
      const content = lines.join('\n')
      await fs.promises.writeFile(target, content, 'utf-8')
      return { path: target, size: Buffer.byteLength(content) }
    }

    const escapeHtml = (value: string): string =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const blocks = view.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map(
        (message) =>
          `<section class="${message.role}"><h2>${message.role === 'user' ? '你' : 'X-CODE'}</h2><pre>${escapeHtml(message.text)}</pre></section>`,
      )
      .join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; margin: 32px; color: #1c1a16; }
      h1 { font-size: 20px; margin-bottom: 4px; }
      h2 { font-size: 12px; color: #8a8378; margin: 18px 0 4px; }
      pre { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; }
      section { border-top: 1px solid #e6e0d6; padding-top: 8px; }
    </style></head><body><h1>${escapeHtml(title)}</h1><div>${escapeHtml(view.sessionId)} · ${escapeHtml(view.modelId)}</div>${blocks}</body></html>`
    const rendered = await requestMain<{ data: string }>('app:render-pdf', { html, title })
    const target = path.join(dir, `x-code-${safeTitle}-${stamp}.pdf`)
    const pdf = Buffer.from(rendered.data, 'base64')
    await fs.promises.writeFile(target, pdf)
    return { path: target, size: pdf.length }
  }

  async transcribeRecording(data: string, mime: string, language?: string): Promise<{ text: string }> {
    if (mime !== 'audio/wav' && mime !== 'audio/x-wav') throw new Error('不支持的录音格式')
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) throw new Error('录音内容为空')
    if (buffer.length > 50_000_000) throw new Error('录音超过 50MB')
    const dir = path.join(userXcodeDir(), 'attachments')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, `recording-${Date.now()}.wav`)
    await fs.promises.writeFile(file, buffer, { mode: 0o600 })
    try {
      const result = await transcribeAudio(file, {
        ...(language ? { language } : {}),
        onNotice: (message) => this.send({ type: 'audio:progress', message }),
      })
      if (typeof result === 'string') throw new Error(result)
      return { text: result.text.trim() }
    } finally {
      await fs.promises.unlink(file).catch(() => undefined)
    }
  }

  async detectChecks(): Promise<Array<{ id: string; label: string; kind: 'node' | 'cargo'; commandLine: string }>> {
    const checks = await detectProjectChecks(this.requireBootstrap().workspace)
    return checks.map((check) => ({
      id: check.id,
      label: check.label,
      kind: check.kind,
      commandLine: checkCommandLabel(check),
    }))
  }

  async runChecks(
    ids?: string[],
    stopOnFailure = true,
  ): Promise<{ results: ProjectCheckResultView[]; summary: string; fixPrompt: string }> {
    if (this.autoChecksRunning) throw new Error('checks-busy')
    const results = await runProjectChecks(this.requireBootstrap().workspace, { ids, stopOnFailure })
    this.lastCheckResults = results
    return {
      results: results.map(toCheckResultView),
      summary: summarizeCheckResults(results),
      fixPrompt: failuresForAgent(results),
    }
  }

  private projectOverrides(): ProjectOverrides {
    const workspace = path.resolve(this.requireBootstrap().workspace)
    return loadDesktopSettings().projectSettings?.[workspace] ?? {}
  }

  private autoChecksEnabled(): boolean {
    const settings = loadDesktopSettings()
    return this.projectOverrides().autoChecks ?? settings.autoChecks === true
  }

  checksStatus(): { autoChecks: boolean; lastResults?: ProjectCheckResultView[] } {
    return {
      autoChecks: this.autoChecksEnabled(),
      ...(this.lastCheckResults.length > 0 ? { lastResults: this.lastCheckResults.map(toCheckResultView) } : {}),
    }
  }

  setAutoChecks(enabled: boolean): { enabled: boolean } {
    saveDesktopSettings({ autoChecks: enabled })
    return { enabled }
  }

  projectSettingsView(): ProjectSettingsView {
    const workspace = path.resolve(this.requireBootstrap().workspace)
    const settings = loadDesktopSettings()
    const overrides = settings.projectSettings?.[workspace] ?? {}
    return {
      workspace,
      overrides,
      effective: {
        modelId: overrides.modelId ?? this.modelId,
        taskMode: overrides.taskMode ?? this.taskMode,
        autoChecks: overrides.autoChecks ?? settings.autoChecks === true,
      },
    }
  }

  async saveProjectSettings(update: {
    modelId?: string | null
    taskMode?: string | null
    autoChecks?: boolean | null
  }): Promise<SettingsActionResult> {
    if (this.activeTurn) throw new Error('turn-busy')
    const workspace = path.resolve(this.requireBootstrap().workspace)
    const settings = loadDesktopSettings()
    const next: ProjectOverrides = { ...(settings.projectSettings?.[workspace] ?? {}) }

    if (update.modelId !== undefined) {
      if (update.modelId === null || !update.modelId.trim()) delete next.modelId
      else next.modelId = update.modelId.trim()
    }
    if (update.taskMode !== undefined) {
      if (update.taskMode === null || !isTaskMode(update.taskMode)) delete next.taskMode
      else next.taskMode = update.taskMode
    }
    if (update.autoChecks !== undefined) {
      if (update.autoChecks === null) delete next.autoChecks
      else next.autoChecks = update.autoChecks
    }

    const projectSettings = { ...(settings.projectSettings ?? {}) }
    if (Object.keys(next).length === 0) delete projectSettings[workspace]
    else projectSettings[workspace] = next
    saveDesktopSettings({ projectSettings })

    if (next.taskMode && isTaskMode(next.taskMode) && next.taskMode !== this.taskMode) {
      this.taskMode = next.taskMode
      if (this.loopState) {
        this.loopState.systemPromptCache = null
        this.loopState.systemPromptBlocks = undefined
      }
    } else if (update.taskMode === null && isTaskMode(settings.taskMode ?? '') && settings.taskMode !== this.taskMode) {
      this.taskMode = settings.taskMode as TaskMode
      if (this.loopState) {
        this.loopState.systemPromptCache = null
        this.loopState.systemPromptBlocks = undefined
      }
    }
    if (next.modelId && this.state?.models.some((model) => model.id === next.modelId)) {
      try {
        this.applyModel(next.modelId, false)
      } catch {
        // Keep the current model when a saved local model disappeared.
      }
    } else if (update.modelId === null) {
      const baseModel = this.requireBootstrap().modelId
      if (this.state?.models.some((model) => model.id === baseModel)) {
        try {
          this.applyModel(baseModel, false)
        } catch {
          // Ignore.
        }
      }
    }
    this.send({ type: 'app:state', state: this.getState() })
    return this.settingsResult()
  }

  private async storageUsage(): Promise<StorageUsageView> {
    const workspace = path.resolve(this.requireBootstrap().workspace)
    const root = userXcodeDir()
    const definitions = [
      { id: 'sessions', label: '会话记录', path: path.join(workspace, '.x-code', 'sessions') },
      { id: 'library', label: '文档库', path: path.join(root, 'library') },
      { id: 'attachments', label: '附件与截图', path: path.join(root, 'attachments') },
      { id: 'whisper', label: '语音模型', path: path.join(root, 'whisper-models') },
      { id: 'logs', label: '日志', path: path.join(root, 'logs') },
    ]
    const categories = []
    for (const definition of definitions) {
      const stats = await directoryStats(definition.path)
      categories.push({ ...definition, ...stats })
    }
    return { categories, totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0) }
  }

  async storageUsageView(): Promise<StorageUsageView> {
    return this.storageUsage()
  }

  async cleanupStorage(options: {
    sessionsOlderThanDays?: number
    attachmentsOlderThanDays?: number
    library?: boolean
    whisperModels?: boolean
  }): Promise<{ deletedFiles: number; freedBytes: number; usage: StorageUsageView }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const workspace = path.resolve(this.requireBootstrap().workspace)
    const root = userXcodeDir()
    const now = Date.now()
    let deletedFiles = 0
    let freedBytes = 0

    const removeIfOlder = async (dir: string, predicate: (name: string) => boolean, days: number): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      const cutoff = now - days * 24 * 60 * 60 * 1000
      for (const entry of entries) {
        if (!entry.isFile() || !predicate(entry.name)) continue
        const target = path.join(dir, entry.name)
        try {
          const stat = await fs.promises.stat(target)
          if (stat.mtimeMs > cutoff) continue
          await fs.promises.unlink(target)
          deletedFiles += 1
          freedBytes += stat.size
        } catch {
          // Skip files that vanished or cannot be removed.
        }
      }
    }

    if (options.sessionsOlderThanDays) {
      const days = Math.max(1, Math.min(3650, Math.round(options.sessionsOlderThanDays)))
      const dir = path.join(workspace, '.x-code', 'sessions')
      const pinned = new Set(loadDesktopSettings().pinnedSessions ?? [])
      const active = this.loopState?.sessionFilePath
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        entries = []
      }
      const cutoff = now - days * 24 * 60 * 60 * 1000
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const target = path.join(dir, entry.name)
        if (pinned.has(target) || target === active) continue
        try {
          const stat = await fs.promises.stat(target)
          if (stat.mtimeMs > cutoff) continue
          await fs.promises.unlink(target)
          deletedFiles += 1
          freedBytes += stat.size
        } catch {
          // Skip.
        }
      }
    }

    if (options.attachmentsOlderThanDays) {
      const days = Math.max(1, Math.min(3650, Math.round(options.attachmentsOlderThanDays)))
      await removeIfOlder(
        path.join(root, 'attachments'),
        (name) => name.startsWith('pasted-') || name.startsWith('recording-'),
        days,
      )
    }

    if (options.library) {
      const before = await directoryStats(path.join(root, 'library'))
      await clearDocumentLibrary()
      freedBytes += before.bytes
      deletedFiles += before.files
    }

    if (options.whisperModels) {
      const dir = path.join(root, 'whisper-models')
      const before = await directoryStats(dir)
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      freedBytes += before.bytes
      deletedFiles += before.files
    }

    return { deletedFiles, freedBytes, usage: await this.storageUsage() }
  }

  /** Apply per-workspace overrides after init or a workspace switch. */
  private applyProjectOverrides(): void {
    const overrides = this.projectOverrides()
    if (overrides.taskMode && isTaskMode(overrides.taskMode)) this.taskMode = overrides.taskMode
    if (overrides.modelId && this.state?.models.some((model) => model.id === overrides.modelId)) {
      try {
        this.applyModel(overrides.modelId, false)
      } catch {
        // Fall back to the default model.
      }
    }
  }

  async setNotifications(enabled: boolean): Promise<SettingsActionResult> {
    saveDesktopSettings({ notifications: enabled })
    return this.settingsResult()
  }

  async setOnboarded(value: boolean): Promise<SettingsActionResult> {
    saveDesktopSettings({ onboarded: value })
    return this.settingsResult()
  }

  async setUpdateFeed(feed: string): Promise<SettingsActionResult> {
    saveDesktopSettings({ updateFeed: feed.trim() })
    return this.settingsResult()
  }

  private async runAutoChecks(): Promise<void> {
    if (this.autoChecksRunning) return
    this.autoChecksRunning = true
    try {
      const results = await runProjectChecks(this.requireBootstrap().workspace, { stopOnFailure: true })
      if (results.length === 0) return
      this.lastCheckResults = results
      this.send({
        type: 'checks:finished',
        results: results.map(toCheckResultView),
        auto: true,
        fixPrompt: failuresForAgent(results),
      })
    } catch {
      // Auto checks are advisory; never surface a failure here as a turn error.
    } finally {
      this.autoChecksRunning = false
    }
  }

  setTaskMode(mode: TaskMode): AppState {
    if (!isTaskMode(mode)) throw new Error(`unknown-task-mode: ${String(mode)}`)
    this.taskMode = mode
    saveDesktopSettings({ taskMode: mode })
    if (this.loopState) {
      this.loopState.systemPromptCache = null
      this.loopState.systemPromptBlocks = undefined
    }
    const state = this.getState()
    this.send({ type: 'app:state', state })
    return state
  }

  setModel(modelId: string): AppState {
    if (this.activeTurn) throw new Error('turn-busy')
    this.applyModel(modelId, true)
    if (modelId.startsWith('custom:')) {
      saveDesktopSettings({ customModelId: modelId.slice('custom:'.length) })
    }
    if (this.state && !this.state.models.some((model) => model.id === modelId)) {
      this.state.models.unshift({
        id: modelId,
        label: modelId,
        provider: modelId.split(':')[0] ?? 'custom',
        description: '自定义模型',
      })
    }
    this.send({ type: 'app:state', state: this.getState() })
    return this.getState()
  }

  /** Re-probe Ollama / LM Studio and refresh the model list in place. */
  async discoverLocal(): Promise<AppState> {
    if (this.activeTurn) throw new Error('turn-busy')
    const local = await discoverLocalModels()
    if (this.state) {
      this.state.models = [
        ...this.state.models.filter((model) => !model.id.startsWith('ollama:') && !model.id.startsWith('lmstudio:')),
        ...local.map((model) => ({
          id: model.id,
          label: model.label,
          provider: model.provider,
          description: model.description,
          contextWindow: getContextWindow(model.id),
        })),
      ]
    }
    this.send({ type: 'app:state', state: this.getState() })
    return this.getState()
  }

  private applyModel(modelId: string, persist: boolean): void {
    if (modelId === DEMO_MODEL_ID) {
      this.model = null
      this.demo = true
    } else {
      const registry = withLocalModels(createModelRegistry())
      const model = registry.languageModel(modelId as `${string}:${string}`)
      this.model = model
      this.demo = false
      const bootstrap = this.requireBootstrap()
      bootstrap.baseOptions.modelRegistry = registry
      bootstrap.baseOptions.modelId = modelId
    }

    this.modelId = modelId
    this.bootstrap?.memoryService?.setActiveModelId(modelId)
    if (this.loopState) {
      this.loopState.systemPromptCache = null
      this.loopState.systemPromptBlocks = undefined
    }
    if (this.state) {
      this.state.activeModelId = modelId
      this.state.demo = this.demo
    }
    if (persist && !this.demo) saveUserConfig({ model: modelId })
  }

  async submit(prompt: string, attachments: string[] = []): Promise<TurnResult> {
    if (this.activeTurn) throw new Error('turn-busy')
    // Cached for 30s: makes tools installed in another terminal visible on the
    // next turn without the per-turn cost of a login shell spawn.
    await refreshShellEnvironment()
    const bootstrap = this.requireBootstrap()
    const existing = this.loopState
    const state = existing ?? createLoopState('default', { projectCwd: bootstrap.workspace })
    this.loopState = state
    if (!existing) this.watchShellSessions(state)

    const model = this.demo ? createDemoModel() : this.model
    if (!model) throw new Error('no-model-configured')

    const turnId = `turn-${++this.turnSeq}`
    const turn: ActiveTurn = { id: turnId, text: '' }
    this.activeTurn = turn
    const controller = new AbortController()
    this.controller = controller

    const checkpoint = await createTurnCheckpoint(bootstrap.workspace, turnId).catch(() => null)
    if (checkpoint) {
      this.gitCheckpoints.set(turnId, checkpoint)
      this.latestCheckpoint = checkpoint
      while (this.gitCheckpoints.size > 20) {
        const oldest = this.gitCheckpoints.keys().next().value
        if (oldest === undefined) break
        this.gitCheckpoints.delete(oldest)
      }
    }

    this.send({ type: 'agent:turn-start', turnId, sessionId: state.sessionId })

    const callbacks = this.buildCallbacks(turnId, turn)
    let reason = 'completed'
    try {
      const content = await this.prepareUserContent(prompt, attachments, state, controller.signal)
      const result = await agentLoop(
        content,
        model,
        {
          ...bootstrap.baseOptions,
          modelId: this.modelId,
          abortSignal: controller.signal,
          systemPromptExtra: taskModeInstruction(this.taskMode),
        },
        callbacks,
        state,
      )
      this.loopState = result.state
      if (controller.signal.aborted) reason = 'aborted'
    } catch (error) {
      reason = controller.signal.aborted ? 'aborted' : 'failed'
      const message = controller.signal.aborted
        ? 'Turn aborted'
        : classifyApiError(error).message || (error instanceof Error ? error.message : String(error))
      this.send({ type: 'agent:error', turnId, message })
      throw error
    } finally {
      this.activeTurn = null
      this.controller = null
      if (this.loopState && this.loopState.messages.length > 0) {
        try {
          await saveSession(this.loopState, model)
        } catch {
          // A failed session flush must not hide the completed turn.
        }
        this.emitSessionSaved(this.loopState)
      }
      this.send({
        type: 'agent:turn-end',
        turnId,
        sessionId: state.sessionId,
        reason,
        text: turn.text,
      })
      if (reason === 'completed') {
        this.notify('任务完成', turn.text.trim().slice(0, 160) || '这一轮已完成', state.sessionId)
      } else if (reason === 'failed') {
        this.notify('任务失败', '本轮执行失败，打开应用查看错误详情', state.sessionId)
      }
      if (reason === 'completed' && this.autoChecksEnabled()) {
        void this.runAutoChecks()
      }
    }

    return { text: turn.text, reason, sessionId: state.sessionId, modelId: this.modelId }
  }

  /** Attachments are resolved against the workspace and appended to the
   *  prompt as `@path` references, which core's file-ingest turns into image,
   *  document, or text parts. Without attachments this stays the string fast
   *  path so provider caching is unchanged. */
  private async prepareUserContent(
    prompt: string,
    attachments: string[],
    state: LoopState,
    signal: AbortSignal,
  ): Promise<string | IngestedPart[]> {
    if (attachments.length === 0 && extractFileReferences(prompt).length === 0) return prompt
    const workspace = this.requireBootstrap().workspace
    const paths = attachments.map((entry) => path.resolve(workspace, entry))
    const refs = paths.map((entry) => `@"${entry.replace(/"/g, '\\"')}"`).join(' ')
    const text = refs ? `${prompt}\n\n${refs}` : prompt
    const capabilities = capabilitiesOf(this.modelId)
    const content = await buildUserContent(
      text,
      modelSupportsVision(this.modelId) ? capabilities : { ...capabilities, image: false },
      (description) => this.send({ type: 'agent:ingest-progress', description }),
      signal,
      undefined,
      this.modelId,
      state.readFileCache,
    )
    const parts = typeof content === 'string' ? [] : content
    if (paths.length > 0) {
      this.send({
        type: 'agent:attachments',
        files: paths,
        mediaParts: parts.filter((part) => part.type !== 'text').length,
        textBytes: parts.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0),
      })
    }
    return content
  }

  abort(): { aborted: boolean } {
    const controller = this.controller
    if (!controller) return { aborted: false }
    this.cancelAllApprovals()
    controller.abort()
    return { aborted: true }
  }

  setThinking(enabled: boolean): { thinking: boolean } {
    this.requireBootstrap().baseOptions.thinking = enabled
    if (this.state) this.state.thinking = enabled
    saveUserConfig({ thinking: enabled })
    this.send({ type: 'app:state', state: this.getState() })
    return { thinking: enabled }
  }

  setPermissionMode(mode: 'default' | 'plan'): { mode: string } {
    if (this.loopState) {
      this.loopState.permissionMode = mode
      this.loopState.systemPromptCache = null
      this.loopState.systemPromptBlocks = undefined
    }
    this.requireBootstrap().baseOptions.permissionMode = mode
    if (this.state) this.state.permissionMode = mode
    this.send({ type: 'agent:permission-mode', mode })
    this.send({ type: 'app:state', state: this.getState() })
    return { mode }
  }

  async compactConversation(): Promise<CompactResult> {
    this.assertIdle()
    const state = this.loopState
    if (!state || state.trackedMessages.length === 0) {
      return { status: 'nothing', message: '没有可压缩的对话。' }
    }
    const model = this.demo ? createDemoModel() : this.model
    if (!model) return { status: 'failed', message: '当前没有可用模型。' }

    const first = state.trackedMessages[0]?.message
    const prefix = '[Previous conversation summary]\n'
    const previousSummary =
      first?.role === 'user' && typeof first.content === 'string' && first.content.startsWith(prefix)
        ? first.content.slice(prefix.length)
        : undefined
    const filesTracked = {
      modified: [...state.filesModified],
      read: [...state.readFileCache.keys()].filter((file) => !state.filesModified.has(file)),
    }
    const before = state.messages.length
    try {
      const compressed = await compressTrackedMessagesWithUsage(
        state.trackedMessages,
        model,
        previousSummary,
        filesTracked,
      )
      const unchanged =
        compressed.trackedMessages.length === state.trackedMessages.length &&
        compressed.trackedMessages.every((entry, index) => entry.entryId === state.trackedMessages[index]?.entryId)
      if (unchanged) {
        return {
          status: 'nothing',
          message: `对话仍在保留窗口内（约 ${formatTokens(KEEP_RECENT_TOKENS)} tokens），无需压缩。`,
        }
      }
      await markBoundaryAndReflush(state, compressed.summary, compressed.trackedMessages)
      return { status: 'done', message: `已压缩：${before} → ${state.messages.length} 条消息。` }
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  contextStats(): TextReport {
    const state = this.loopState
    if (!state) return { text: '暂无活动会话上下文。' }
    const input = buildContextBreakdownInput(this.requireBootstrap().baseOptions, state)
    if (!input) return { text: '无法估算上下文：系统提示尚未构建。发送一条消息后再试。' }
    const estimate = estimateContextBreakdown(input)
    const real = state.tokenUsage.currentContextTokens
    const window = getContextWindow(this.modelId)
    const categories =
      real > 0
        ? calibrateContextBreakdown(estimate, real).map((category) => ({
            label: category.label,
            tokens: category.tokens,
          }))
        : estimate.categories.map((category) => ({
            label: category.label,
            tokens: category.estimatedTokens,
          }))
    const lines = [
      '上下文用量',
      '',
      `- 模型：${this.modelId}`,
      `- 窗口：${formatTokens(window)}`,
      `- 最近请求：${formatTokens(real)}（${window > 0 ? Math.round((real / window) * 100) : 0}%）`,
      '',
    ]
    for (const category of categories) {
      lines.push(`- ${category.label}: ${formatTokens(category.tokens)}`)
    }
    for (const warning of estimate.warnings ?? []) lines.push(`- 警告：${warning}`)
    return { text: lines.join('\n') }
  }

  usageSummary(): TextReport {
    const usage = this.loopState?.tokenUsage
    if (!usage || usage.totalTokens === 0) return { text: '本会话尚无用量。' }
    const window = getContextWindow(this.modelId)
    const cacheRatio =
      usage.inputTokens > 0 ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}%` : 'n/a'
    return {
      text: [
        '用量',
        '',
        `- 模型：${this.modelId}`,
        `- 输入：${formatTokens(usage.inputTokens)}`,
        `- 输出：${formatTokens(usage.outputTokens)}`,
        `- 缓存读取：${formatTokens(usage.cacheReadTokens)}（占输入 ${cacheRatio}）`,
        `- 缓存写入：${formatTokens(usage.cacheCreationTokens)}`,
        `- 总计：${formatTokens(usage.totalTokens)}`,
        `- 当前上下文：${formatTokens(usage.currentContextTokens)} / ${formatTokens(window)}`,
      ].join('\n'),
    }
  }

  async usageHistoryReport(): Promise<TextReport> {
    const sessions = await listSessions(this.requireBootstrap().workspace)
    if (sessions.length === 0) return { text: '暂无历史会话。' }
    const lines = ['用量历史', '']
    for (const session of sessions.slice(0, 10)) {
      const tokens = session.tokenUsage ? formatTokens(session.tokenUsage.totalTokens) : '无用量'
      const when = new Date(session.mtime).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const title = (session.name || session.firstPrompt || session.sessionId).replace(/\s+/g, ' ').slice(0, 40)
      lines.push(`- ${when} · ${session.modelId} · ${tokens} · ${title}`)
    }
    return { text: lines.join('\n') }
  }

  memoryReport(): TextReport {
    const root = path.join(userXcodeDir(), 'memory')
    const memoryFile = path.join(root, 'MEMORY.md')
    const lines = ['记忆', '']
    if (fs.existsSync(memoryFile)) {
      lines.push(fs.readFileSync(memoryFile, 'utf-8').slice(0, 4000))
    } else {
      lines.push('尚未生成用户记忆（MEMORY.md 不存在）。')
    }
    try {
      const topics = fs
        .readdirSync(path.join(root, 'topics'))
        .filter((file) => file.endsWith('.md'))
        .slice(0, 30)
      if (topics.length > 0) lines.push('', '主题：', ...topics.map((topic) => `- ${topic}`))
    } catch {
      // No topics directory.
    }
    return { text: lines.join('\n') }
  }

  private assertMemoryId(id: string): string {
    const trimmed = id.trim()
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(trimmed)) throw new Error(`非法的记忆主题 ID：${id}`)
    return trimmed
  }

  private memoryTopicPath(id: string): string {
    return path.join(this.requireBootstrap().memoryService.memoryRoot, 'topics', `${this.assertMemoryId(id)}.md`)
  }

  private async memoryPanel(): Promise<MemoryPanelView> {
    const service = this.requireBootstrap().memoryService
    await service.initialize(this.requireBootstrap().workspace)
    const status = await service.status()
    return {
      root: service.memoryRoot,
      coreProfile: service.getCoreProfile(),
      status: {
        initialized: status.initialized,
        generation: status.generation,
        topics: status.topics,
        facts: status.facts,
        queue: status.queue,
        worker: status.worker,
        invalidTopics: status.invalidTopics,
        ...(status.error ? { error: status.error } : {}),
      },
      topics: service.listTopics(),
    }
  }

  async memoryPanelView(): Promise<MemoryPanelView> {
    return this.memoryPanel()
  }

  async memoryTopic(id: string): Promise<{ id: string; content: string }> {
    const topicId = this.assertMemoryId(id)
    const file = this.memoryTopicPath(topicId)
    const content = await fs.promises.readFile(file, 'utf-8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(`记忆主题不存在：${topicId}`)
      throw error
    })
    return { id: topicId, content }
  }

  async saveMemoryTopic(id: string, content: string): Promise<MemoryPanelView> {
    if (this.activeTurn) throw new Error('turn-busy')
    if (content.length > 1_000_000) throw new Error('主题内容超过 1MB')
    const topicId = this.assertMemoryId(id)
    const file = this.memoryTopicPath(topicId)
    const tmp = `${file}.tmp`
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await this.requireBootstrap().memoryService.reload(this.loopState ?? undefined)
    this.invalidatePromptCache()
    return this.memoryPanel()
  }

  async deleteMemoryTopic(id: string): Promise<MemoryPanelView> {
    if (this.activeTurn) throw new Error('turn-busy')
    const file = this.memoryTopicPath(id)
    await fs.promises.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await this.requireBootstrap().memoryService.reload(this.loopState ?? undefined)
    this.invalidatePromptCache()
    return this.memoryPanel()
  }

  async reloadMemory(): Promise<MemoryPanelView> {
    await this.requireBootstrap().memoryService.reload(this.loopState ?? undefined)
    this.invalidatePromptCache()
    return this.memoryPanel()
  }

  private commandViews(): CustomCommandView[] {
    return (this.requireBootstrap().commandRegistry?.list() ?? []).map((command) => ({
      name: command.name,
      description: command.description ?? '',
      source: command.source,
      ...(command.pluginId ? { pluginId: command.pluginId } : {}),
    }))
  }

  listCommands(): { commands: CustomCommandView[] } {
    return { commands: this.commandViews() }
  }

  runCommand(name: string, args = ''): { name: string; prompt: string } {
    const command = this.requireBootstrap().commandRegistry?.get(name)
    if (!command) throw new Error(`未知命令：/${name}`)
    return { name: command.name, prompt: expandCommandBody(command, args) }
  }

  commandDetail(name: string): {
    name: string
    description: string
    body: string
    source: 'user' | 'project' | 'plugin'
  } {
    const command = this.requireBootstrap().commandRegistry?.get(name)
    if (!command) throw new Error(`未知命令：/${name}`)
    return {
      name: command.name,
      description: command.description ?? '',
      body: command.body,
      source: command.source,
    }
  }

  private commandFilePath(name: string, scope: 'user' | 'project'): string {
    const trimmed = name.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(trimmed)) {
      throw new Error('命令名称只能包含字母、数字、下划线和连字符，且不超过 64 个字符')
    }
    const dir =
      scope === 'user'
        ? path.join(userXcodeDir(), 'commands')
        : path.join(this.requireBootstrap().workspace, '.x-code', 'commands')
    return path.join(dir, `${trimmed}.md`)
  }

  private async reloadCommands(): Promise<void> {
    const bootstrap = this.requireBootstrap()
    const registry = bootstrap.commandRegistry
    if (!registry) throw new Error('命令注册表不可用')
    const commands = await loadPluginCommands({ extraDirs: bootstrap.commandExtraDirs })
    registry.reload(commands)
    this.invalidatePromptCache()
    this.send({ type: 'commands:changed' })
  }

  async saveCommand(input: {
    name: string
    description: string
    body: string
    scope: 'user' | 'project'
  }): Promise<{ commands: CustomCommandView[] }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const body = input.body.trim()
    if (!body) throw new Error('命令内容不能为空')
    if (body.length > 200_000) throw new Error('命令内容超过 200KB')
    const file = this.commandFilePath(input.name, input.scope)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const description = input.description.trim()
    const frontmatter = description ? `---\ndescription: ${JSON.stringify(description)}\n---\n\n` : ''
    const tmp = `${file}.tmp`
    await fs.promises.writeFile(tmp, `${frontmatter}${body}\n`, { encoding: 'utf-8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await this.reloadCommands()
    return this.listCommands()
  }

  async deleteCommand(name: string, scope: 'user' | 'project'): Promise<{ commands: CustomCommandView[] }> {
    if (this.activeTurn) throw new Error('turn-busy')
    const file = this.commandFilePath(name, scope)
    await fs.promises.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await this.reloadCommands()
    return this.listCommands()
  }

  hooksView(): HooksView {
    const bootstrap = this.requireBootstrap()
    const workspace = path.resolve(bootstrap.workspace)
    const projectTrusted = (loadDesktopSettings().trustedProjectHooks ?? []).includes(workspace)
    const local = loadLocalHookConfigs(bootstrap.workspace, { allowProjectHooks: projectTrusted })
    const configs: { user: Record<string, unknown>; project: Record<string, unknown> } = { user: {}, project: {} }
    for (const source of local.sources) configs[source.scope] = source.config as Record<string, unknown>
    const projectHooksPresent = Object.values(configs.project).some(
      (entries) => Array.isArray(entries) && entries.length > 0,
    )
    return {
      active: bootstrap.hookRegistry.list().map((hook) => ({
        event: hook.event,
        ...(hook.entry.matcher ? { matcher: hook.entry.matcher } : {}),
        command: hook.entry.command,
        ...(hook.entry.description ? { description: hook.entry.description } : {}),
        ...(hook.entry.timeout !== undefined ? { timeout: hook.entry.timeout } : {}),
        ...(hook.entry.failurePolicy ? { failurePolicy: hook.entry.failurePolicy } : {}),
        source: hook.pluginId === 'user' || hook.pluginId === 'project' ? hook.pluginId : 'plugin',
        pluginId: hook.pluginId,
      })),
      configs,
      paths: localHookPaths(bootstrap.workspace),
      errors: local.errors,
      projectTrusted,
      projectHooksPresent,
    }
  }

  async setProjectHooksTrusted(trusted: boolean): Promise<HooksView> {
    if (this.activeTurn) throw new Error('turn-busy')
    const workspace = path.resolve(this.requireBootstrap().workspace)
    const settings = loadDesktopSettings()
    const next = new Set(settings.trustedProjectHooks ?? [])
    if (trusted) next.add(workspace)
    else next.delete(workspace)
    saveDesktopSettings({ trustedProjectHooks: [...next] })
    await this.reloadExtensions(this.modelId)
    return this.hooksView()
  }

  async saveHooks(scope: 'user' | 'project', config: Record<string, unknown>): Promise<HooksView> {
    if (this.activeTurn) throw new Error('turn-busy')
    const file = localHookPaths(this.requireBootstrap().workspace)[scope]
    const parsed = parseHookConfig(config, file)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await this.reloadExtensions(this.modelId)
    return this.hooksView()
  }

  private workspaceRoot(): string {
    return path.resolve(this.requireBootstrap().workspace)
  }

  /** Resolve through symlinks for the deepest existing ancestor, then check
   *  the physical path stays inside the workspace. Prevents `../` and
   *  symlink escapes for both reads and writes. */
  private workspacePhysicalPath(input: string): string {
    const root = this.workspaceRoot()
    const physicalRoot = realpathAllowMissing(root)
    const physical = realpathAllowMissing(path.resolve(root, input))
    if (physical !== physicalRoot && !physical.startsWith(physicalRoot + path.sep)) {
      throw new Error('路径必须在当前工作区内')
    }
    return physical
  }

  private assertNotGitPath(absolute: string): void {
    const relative = path.relative(this.workspaceRoot(), absolute)
    if (relative.split(path.sep).includes('.git')) throw new Error('不允许通过文件编辑器修改 .git')
  }

  async listFiles(relative = '.'): Promise<{ path: string; entries: FileTreeEntryView[] }> {
    const root = this.workspaceRoot()
    const absolute = this.workspacePhysicalPath(relative || '.')
    const stat = await fs.promises.stat(absolute)
    if (!stat.isDirectory()) throw new Error('不是目录')
    const dirents = await fs.promises.readdir(absolute, { withFileTypes: true })
    const entries: FileTreeEntryView[] = []
    for (const dirent of dirents.slice(0, 2000)) {
      if (FILE_TREE_SKIP.has(dirent.name)) continue
      const child = path.join(absolute, dirent.name)
      let type: 'file' | 'directory'
      try {
        if (dirent.isSymbolicLink()) {
          const real = fs.realpathSync.native(child)
          const physicalRoot = realpathAllowMissing(root)
          if (real !== physicalRoot && !real.startsWith(physicalRoot + path.sep)) continue
          type = fs.statSync(real).isDirectory() ? 'directory' : 'file'
        } else if (dirent.isDirectory()) {
          type = 'directory'
        } else if (dirent.isFile()) {
          type = 'file'
        } else {
          continue
        }
        const entryStat = await fs.promises.stat(child)
        entries.push({
          name: dirent.name,
          path: path.relative(root, child),
          type,
          ...(type === 'file' ? { size: entryStat.size } : {}),
        })
      } catch {
        // Broken symlink or vanished entry.
      }
    }
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })
    return { path: path.relative(root, absolute) || '.', entries }
  }

  async readWorkspaceFile(relative: string): Promise<FileReadView> {
    const absolute = this.workspacePhysicalPath(relative)
    const stat = await fs.promises.stat(absolute)
    if (!stat.isFile()) throw new Error('不是文件')
    const truncated = stat.size > MAX_EDITOR_READ_BYTES
    const length = Math.min(stat.size, MAX_EDITOR_READ_BYTES)
    const handle = await fs.promises.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      const binary = buffer.subarray(0, 8192).includes(0)
      return {
        path: path.relative(this.workspaceRoot(), absolute),
        content: binary ? '' : buffer.toString('utf-8'),
        size: stat.size,
        binary,
        truncated,
      }
    } finally {
      await handle.close()
    }
  }

  async writeWorkspaceFile(relative: string, content: string): Promise<{ path: string; size: number }> {
    const absolute = this.workspacePhysicalPath(relative)
    this.assertNotGitPath(absolute)
    const buffer = Buffer.from(content, 'utf-8')
    if (buffer.length > MAX_EDITOR_WRITE_BYTES) throw new Error('文件超过 2MB，编辑器中不支持保存')
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    const tmp = `${absolute}.xcode-tmp`
    await fs.promises.writeFile(tmp, buffer)
    await fs.promises.rename(tmp, absolute)
    return { path: path.relative(this.workspaceRoot(), absolute), size: buffer.length }
  }

  async createWorkspaceFile(relative: string, content = ''): Promise<{ path: string; size: number }> {
    const absolute = this.workspacePhysicalPath(relative)
    this.assertNotGitPath(absolute)
    try {
      await fs.promises.access(absolute)
      throw new Error('文件已存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return this.writeWorkspaceFile(relative, content)
  }

  async doctorReport(): Promise<TextReport> {
    const bootstrap = this.requireBootstrap()
    const mcp = this.mcp ? await this.mcp.list() : []
    const lines = [
      '诊断',
      '',
      `- 工作区：${bootstrap.workspace}`,
      `- 模型：${this.modelId}${this.demo ? '（演示）' : ''}`,
      `- Node：${process.versions.node}`,
      `- Electron：${process.versions.electron ?? '-'}`,
      '',
      'Providers',
    ]
    for (const provider of bootstrap.appState.providers) {
      lines.push(`- ${provider.name}: ${provider.available ? '可用' : '未配置'}（${provider.envKey}）`)
    }
    lines.push('', 'MCP')
    if (mcp.length === 0) lines.push('- 无')
    else {
      for (const server of mcp) {
        const detail =
          server.status.kind === 'connected'
            ? `已连接 · ${server.status.toolCount} 个工具`
            : server.status.kind === 'failed'
              ? `失败：${server.status.error}`
              : server.status.kind
        lines.push(`- ${server.name}: ${detail}`)
      }
    }
    lines.push(
      '',
      `- 插件：${bootstrap.pluginRegistry.listAll().length} 个${bootstrap.pluginErrors.length > 0 ? `（${bootstrap.pluginErrors.length} 个错误）` : ''}`,
      `- 技能：${bootstrap.skillRegistry?.listAll().length ?? 0} 个`,
      `- 子代理：${bootstrap.subAgentRegistry?.list().length ?? 0} 个`,
      `- 内置工具：${Object.keys(toolRegistry).length} 个`,
    )
    return { text: lines.join('\n') }
  }

  /** Export a redacted JSON snapshot for support. Provider keys, MCP env and
   *  headers, and command strings are deliberately excluded. */
  async exportDiagnostics(): Promise<DiagnosticsExportResult> {
    const bootstrap = this.requireBootstrap()
    const workspace = this.workspaceRoot()
    const [mcp, sessions] = await Promise.all([this.mcp ? this.mcp.list() : [], listSessions(workspace)])
    const desktopSettings = loadDesktopSettings()
    const rules = visiblePermissionRules(readPersistedRules(workspace), workspace)
    const version = (() => {
      try {
        return String((createRequire(import.meta.url)('../../package.json') as { version?: string }).version ?? '')
      } catch {
        return ''
      }
    })()
    const snapshot = {
      generatedAt: new Date().toISOString(),
      app: { version, demo: this.demo },
      system: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        memory: process.memoryUsage(),
        uptimeSeconds: Math.round(process.uptime()),
      },
      workspace,
      model: {
        id: this.modelId,
        contextWindow: getContextWindow(this.modelId),
        contextWindowOverride: getModelContextWindowOverride(this.modelId),
      },
      state: {
        taskMode: bootstrap.appState.taskMode,
        permissionMode: bootstrap.appState.permissionMode,
        thinking: bootstrap.appState.thinking,
      },
      providers: bootstrap.appState.providers.map((provider) => ({
        name: provider.name,
        envKey: provider.envKey,
        available: provider.available,
      })),
      mcp: mcp.map((server) => ({
        name: server.name,
        scope: server.scope,
        enabled: server.enabled,
        status: server.status,
      })),
      counts: {
        sessions: sessions.length,
        plugins: bootstrap.pluginRegistry.listAll().length,
        pluginErrors: bootstrap.pluginErrors.length,
        skills: bootstrap.skillRegistry?.listAll().length ?? 0,
        subAgents: bootstrap.subAgentRegistry?.list().length ?? 0,
        tools: Object.keys(toolRegistry).length,
        permissionRules: rules.length,
      },
      tools: {
        profile: bootstrap.baseOptions.toolProfile ?? 'full',
        disabled: [...this.disabledTools].sort(),
        alwaysAllow: [...this.autoAllowedTools].sort(),
      },
      settings: {
        alwaysAllowAll: this.alwaysAllowAll,
        shellSandbox: {
          enabled: desktopSettings.shellSandbox !== false,
          allowNetwork: desktopSettings.shellSandboxNetwork === true,
          extensions: desktopSettings.shellSandboxExtensions === true,
        },
        notifications: desktopSettings.notifications !== false,
        contextWindowOverrides: desktopSettings.contextWindowOverrides ?? {},
      },
    }
    const dir = path.join(userXcodeDir(), 'diagnostics')
    await fs.promises.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `x-code-diagnostics-${stamp}.json`)
    const body = `${JSON.stringify(snapshot, null, 2)}\n`
    await fs.promises.writeFile(file, body, 'utf-8')
    return { path: file, bytes: Buffer.byteLength(body), generatedAt: snapshot.generatedAt }
  }

  async exportBackup(destination: string): Promise<BackupExportView> {
    this.assertIdle()
    const result = await exportUserBackup(userXcodeDir(), destination)
    return { path: result.path, createdAt: result.manifest.createdAt, counts: result.manifest.counts }
  }

  async importBackup(source: string): Promise<BackupImportView> {
    this.assertIdle()
    const result = await importUserBackup(source, userXcodeDir())
    if (result.imported.skills + result.imported.commands + result.imported.agents > 0) {
      await this.reloadExtensions(this.modelId)
    }
    return { path: result.path, imported: result.imported, skipped: result.skipped }
  }

  shellListReport(): TextReport {
    const sessions = this.loopState?.shellSessions.list() ?? []
    if (sessions.length === 0) {
      return { text: '没有后台 shell 会话。终端抽屉里的 PTY 不计入这里。' }
    }
    const lines = ['后台 Shell', '']
    for (const session of sessions) {
      lines.push(`- ${session.shellId} · ${session.status} · ${session.command}（${session.effectiveCwd}）`)
    }
    return { text: lines.join('\n') }
  }

  agentsReport(): TextReport {
    const agents = this.requireBootstrap().subAgentRegistry?.list() ?? []
    if (agents.length === 0) return { text: '没有可用的子代理。' }
    const lines = ['子代理', '']
    for (const agent of agents) {
      const model = (agent as { model?: string }).model
      lines.push(`- ${agent.name}: ${agent.description}${model ? ` · ${model}` : ''}`)
    }
    return { text: lines.join('\n') }
  }

  goalReport(): TextReport {
    const goal = this.loopState?.goal
    if (!goal) return { text: '当前没有 goal。' }
    const lines = ['Goal', '', `- 状态：${goal.status}`, `- 目标：${goal.objective}`, `- 轮次：${goal.turnCount}`]
    if (goal.finalSummary) lines.push(`- 总结：${goal.finalSummary}`)
    return { text: lines.join('\n') }
  }

  respondApproval(
    requestId: string,
    kind: ApprovalKind,
    payload: { decision?: 'yes' | 'always' | 'no'; answer?: string; approved?: boolean },
  ): void {
    const pending = this.approvals.get(requestId)
    if (!pending || pending.kind !== kind) return
    this.approvals.delete(requestId)

    if (kind === 'permission') {
      const decision: PermissionDecision =
        payload.decision === 'yes' || payload.decision === 'always' ? payload.decision : 'no'
      pending.resolve(decision)
      return
    }
    if (kind === 'authority') {
      const approval: AuthorityApproval = {
        decision: payload.decision === 'yes' ? 'allow-once' : 'deny',
        canonicalCallSha256: pending.authority?.canonicalCallSha256 ?? '',
        authorityHash: pending.authority?.authorityHash ?? '',
      }
      pending.resolve(approval)
      return
    }
    if (kind === 'question') {
      pending.resolve(payload.answer ?? '')
      return
    }
    pending.resolve(payload.approved === true)
  }

  cancelAllApprovals(): void {
    for (const [, pending] of this.approvals) {
      if (pending.kind === 'permission') pending.resolve('no')
      else if (pending.kind === 'authority') {
        pending.resolve({
          decision: 'deny',
          canonicalCallSha256: pending.authority?.canonicalCallSha256 ?? '',
          authorityHash: pending.authority?.authorityHash ?? '',
        } satisfies AuthorityApproval)
      } else if (pending.kind === 'question') pending.resolve('')
      else pending.resolve(false)
    }
    this.approvals.clear()
  }

  async getSettings(): Promise<SettingsSnapshot> {
    const bootstrap = this.requireBootstrap()
    const providers: ProviderSettingsView[] = PROVIDERS.map((provider) => {
      const status = providerSecretStatus(provider.name)
      return {
        name: provider.name,
        envKey: provider.envKey,
        keyUrl: provider.keyUrl,
        available: bootstrap.appState.providers.some((entry) => entry.name === provider.name && entry.available),
        source: status.source,
        hint: status.hint,
        baseUrl: status.baseUrl,
      }
    })
    const customStatus = providerSecretStatus('custom')
    providers.push({
      name: 'custom',
      envKey: 'OPENAI_COMPATIBLE_API_KEY',
      keyUrl: '',
      available: bootstrap.appState.providers.some((entry) => entry.name === 'custom' && entry.available),
      source: customStatus.source,
      hint: customStatus.hint,
      baseUrl: customStatus.baseUrl,
      modelId: loadDesktopSettings().customModelId,
    })

    const skills: SkillSettingsView[] = (bootstrap.skillRegistry?.listAll() ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      pluginId: skill.pluginId,
      enabled: !skill.disabled,
      removable: skill.source === 'user' && !skill.pluginId,
      runtime: skillRuntimeView(skill),
    }))
    const tools: ToolSettingsView[] = Object.entries(toolRegistry).map(([name, tool]) => {
      const meta = TOOL_META[name]
      return {
        name,
        label: meta?.label ?? name,
        description: meta?.description ?? (tool as { description?: string }).description ?? '',
        enabled: !this.disabledTools.has(name),
        needsPermission: getPermissionLevel(name, {}) === 'ask',
        alwaysAllow: this.autoAllowedTools.has(name),
      }
    })
    const plugins: PluginSettingsView[] = bootstrap.pluginRegistry.listAll().map((plugin) => {
      const fields = toUserConfigFields(plugin.manifest.userConfig)
      return {
        id: plugin.id,
        name: plugin.manifest.name ?? plugin.id,
        version: plugin.manifest.version ?? '',
        scope: plugin.scope,
        enabled: plugin.enabled,
        marketplace: plugin.marketplace,
        ...(fields.length > 0 ? { userConfig: fields } : {}),
      }
    })
    const mcpServers: McpServerView[] = this.mcp ? await this.mcp.list() : []
    const searchProviders: SearchProviderView[] = WEB_SEARCH_PROVIDERS.filter((provider) => !provider.modelKeyOnly).map(
      (provider) => {
        const status = searchSecretStatus(provider.id)
        return {
          id: provider.id,
          label: provider.label,
          envKey: provider.envKey,
          signup: provider.signup,
          configured: status.source !== 'none',
          source: status.source,
          ...(status.hint ? { hint: status.hint } : {}),
        }
      },
    )

    return {
      workspace: bootstrap.workspace,
      activeModelId: this.modelId,
      contextWindow: getContextWindow(this.modelId),
      ...(getModelContextWindowOverride(this.modelId) !== undefined
        ? { contextWindowOverride: getModelContextWindowOverride(this.modelId) }
        : {}),
      providers,
      skills,
      tools,
      searchProviders,
      searchProvider: loadDesktopSettings().searchProvider ?? '',
      plugins,
      pluginErrors: bootstrap.pluginErrors,
      mcpServers,
      mcpProjectSkipped: this.mcp?.getProjectSkipped() ?? false,
      toolProfile: (bootstrap.baseOptions.toolProfile ?? 'full') as 'full' | 'standard',
      thinking: bootstrap.baseOptions.thinking ?? false,
      alwaysAllowAll: this.alwaysAllowAll,
      browser: {
        enabled: bootstrap.subAgentRegistry?.names().includes('browser') ?? false,
        visualCheck: bootstrap.baseOptions.browserVisualCheckEnabled !== false,
      },
      secretStorage: secretStorageKind(),
      shellSandbox: {
        supported: process.platform === 'darwin',
        enabled: loadDesktopSettings().shellSandbox !== false,
        allowNetwork: loadDesktopSettings().shellSandboxNetwork === true,
        extensions: loadDesktopSettings().shellSandboxExtensions === true,
      },
      notifications: loadDesktopSettings().notifications !== false,
      onboarded: loadDesktopSettings().onboarded === true,
      updateFeed: loadDesktopSettings().updateFeed || DEFAULT_UPDATE_FEED,
    }
  }

  async setApiKey(provider: string, key: string, baseUrl?: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const wasDemo = this.demo
    await saveProviderKey(provider, key, baseUrl)
    await this.reloadExtensions(this.modelId)
    if (wasDemo) {
      const real = this.state?.models.find((model) => !model.demo)
      if (real) {
        this.applyModel(real.id, false)
        this.send({ type: 'app:state', state: this.getState() })
      }
    }
    return this.settingsResult()
  }

  async setCustomModel(modelId: string, key?: string, baseUrl?: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const bare = modelId.trim().replace(/^custom:/, '')
    if (!bare) throw new Error('模型 ID 不能为空')
    const status = providerSecretStatus('custom')
    if (!baseUrl?.trim() && !status.baseUrl) throw new Error('请填写 Base URL')
    if (key?.trim()) {
      await saveProviderKey('custom', key, baseUrl?.trim() || undefined)
    } else {
      if (status.source === 'none') throw new Error('请填写 API Key')
      if (baseUrl?.trim()) await saveCustomBaseUrl(baseUrl.trim())
    }
    saveDesktopSettings({ customModelId: bare })
    saveUserConfig({ model: `custom:${bare}` })
    await this.reloadExtensions(`custom:${bare}`)
    this.send({ type: 'app:state', state: this.getState() })
    void this.emitSettings()
    return this.settingsResult()
  }

  async clearApiKey(provider: string): Promise<SettingsActionResult> {
    this.assertIdle()
    await clearProviderKey(provider)
    await this.reloadExtensions(this.modelId)
    return this.settingsResult()
  }

  async setSearchKey(provider: string, key: string): Promise<SettingsActionResult> {
    this.assertIdle()
    await saveSearchKey(provider, key)
    return this.settingsResult()
  }

  async clearSearchKey(provider: string): Promise<SettingsActionResult> {
    this.assertIdle()
    await clearStoredSearchKey(provider)
    if ((loadDesktopSettings().searchProvider ?? '') === provider) {
      saveDesktopSettings({ searchProvider: undefined })
      applySearchProviderPreference(undefined)
    }
    return this.settingsResult()
  }

  async setSearchProvider(provider: string | null): Promise<SettingsActionResult> {
    this.assertIdle()
    const id = provider?.trim().toLowerCase() || ''
    if (id) {
      const known = WEB_SEARCH_PROVIDERS.some((candidate) => candidate.id === id && !candidate.modelKeyOnly)
      if (!known) throw new Error(`未知的搜索服务: ${id}`)
      if (searchSecretStatus(id).source === 'none') throw new Error('请先配置该搜索服务的 API Key')
    }
    saveDesktopSettings({ searchProvider: id || undefined })
    applySearchProviderPreference(id || undefined)
    return this.settingsResult()
  }

  async testSearchKey(provider: string, key?: string): Promise<SearchTestResult> {
    this.assertIdle()
    return testWebSearchProvider(provider, key)
  }

  async setShellSandboxConfig(update: {
    enabled?: boolean
    allowNetwork?: boolean
    extensions?: boolean
  }): Promise<SettingsActionResult> {
    this.assertIdle()
    const current = loadDesktopSettings()
    const enabled = update.enabled ?? current.shellSandbox !== false
    const allowNetwork = update.allowNetwork ?? current.shellSandboxNetwork === true
    const extensions = update.extensions ?? current.shellSandboxExtensions === true
    saveDesktopSettings({
      shellSandbox: enabled,
      shellSandboxNetwork: allowNetwork,
      shellSandboxExtensions: extensions,
    })
    setShellSandbox({
      enabled: process.platform === 'darwin' && enabled,
      workspace: this.requireBootstrap().workspace,
      allowNetwork,
      includeExtensions: extensions,
    })
    return this.settingsResult()
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<SettingsActionResult> {
    await setSkillDisabled(name, 'user', !enabled)
    const bootstrap = this.requireBootstrap()
    if (bootstrap.skillRegistry) {
      await this.reloadSkillsRegistry(bootstrap.skillRegistry, bootstrap.skillExtraDirs)
    }
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  /** Re-scan skill directories without restarting. Used by the Settings button
   *  and by the background poller when an external installer adds a SKILL.md. */
  async reloadSkills(): Promise<SettingsActionResult> {
    await this.reloadSkillsNow()
    await this.emitSettings()
    return this.settingsResult()
  }

  /** Install a skill's declared dependencies into its isolated runtime dir. */
  async installSkillRuntime(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const registry = this.requireBootstrap().skillRegistry
    if (!registry) throw new Error('skills-unavailable')
    const entry = registry.getEntry(name)
    if (!entry) throw new Error(`skill-not-found: ${name}`)
    await refreshShellEnvironment()
    await installRuntime({ name: entry.name, dir: entry.dir })
    applySkillRuntimeHints(registry)
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async clearSkillRuntime(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const registry = this.requireBootstrap().skillRegistry
    if (!registry) throw new Error('skills-unavailable')
    const entry = registry.getEntry(name)
    if (!entry) throw new Error(`skill-not-found: ${name}`)
    clearRuntime({ name: entry.name, dir: entry.dir })
    applySkillRuntimeHints(registry)
    return this.settingsResult()
  }

  /** Remove legacy dependency folders created inside the skill directory. */
  async clearLegacySkillRuntime(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const registry = this.requireBootstrap().skillRegistry
    if (!registry) throw new Error('skills-unavailable')
    const entry = registry.getEntry(name)
    if (!entry) throw new Error(`skill-not-found: ${name}`)
    const removed = clearLegacyRuntime({ name: entry.name, dir: entry.dir })
    applySkillRuntimeHints(registry)
    if (removed.length > 0) {
      this.send({ type: 'runtime:log', level: 'info', message: `cleaned legacy skill runtime: ${removed.join(', ')}` })
    }
    return this.settingsResult()
  }

  /** Re-read the login shell environment, then rebuild plugins/MCP/skills so
   *  newly exported variables and installed CLIs take effect immediately. */
  async refreshEnvironment(): Promise<EnvironmentRefreshResult> {
    this.assertIdle()
    const environment = await refreshShellEnvironment({ force: true })
    await this.reloadExtensions(this.modelId)
    return { ...(await this.settingsResult()), environment }
  }

  private async reloadSkillsRegistry(
    registry: NonNullable<RuntimeBootstrap['skillRegistry']>,
    extraDirs: RuntimeBootstrap['skillExtraDirs'],
  ): Promise<void> {
    await reloadSkillRegistry(registry, { extraDirs })
    applySkillRuntimeHints(registry)
  }

  private async reloadSkillsNow(): Promise<void> {
    const bootstrap = this.requireBootstrap()
    if (!bootstrap.skillRegistry) return
    await this.reloadSkillsRegistry(bootstrap.skillRegistry, bootstrap.skillExtraDirs)
    this.invalidatePromptCache()
  }

  private startSkillPolling(): void {
    if (this.skillPollTimer) return
    void this.skillSignatureNow().then((signature) => {
      this.skillSignature = signature
    })
    this.skillPollTimer = setInterval(() => {
      void this.pollSkills()
    }, 3_000)
    this.skillPollTimer.unref?.()
  }

  private async pollSkills(): Promise<void> {
    const signature = await this.skillSignatureNow()
    if (signature === this.skillSignature) return
    this.skillSignature = signature
    try {
      await this.reloadSkillsNow()
      await this.emitSettings()
    } catch (error) {
      this.send({
        type: 'runtime:log',
        level: 'warn',
        message: `skill reload failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private async skillSignatureNow(): Promise<string> {
    const bootstrap = this.bootstrap
    if (!bootstrap) return ''
    const dirs = [
      path.join(userXcodeDir(), 'skills'),
      path.join(bootstrap.workspace, '.x-code', 'skills'),
      ...(bootstrap.skillExtraDirs ?? []).map((entry) => entry.dir),
    ]
    const entries: string[] = []
    for (const dir of dirs) await collectSkillSignatures(dir, 0, entries)
    entries.sort()
    return entries.join('\n')
  }

  async setToolEnabled(name: string, enabled: boolean): Promise<SettingsActionResult> {
    if (enabled) this.disabledTools.delete(name)
    else this.disabledTools.add(name)
    saveDesktopSettings({ disabledTools: [...this.disabledTools].sort() })
    this.applyToolFilter()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async setToolProfile(profile: 'full' | 'standard'): Promise<SettingsActionResult> {
    this.requireBootstrap().baseOptions.toolProfile = profile
    saveUserConfig({ experimentalToolProfile: profile })
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async setToolAlwaysAllow(name: string, enabled: boolean): Promise<SettingsActionResult> {
    if (enabled) this.autoAllowedTools.add(name)
    else this.autoAllowedTools.delete(name)
    saveDesktopSettings({ autoAllowedTools: [...this.autoAllowedTools].sort() })
    return this.settingsResult()
  }

  async setAlwaysAllowAll(enabled: boolean): Promise<SettingsActionResult> {
    this.alwaysAllowAll = enabled
    saveDesktopSettings({ alwaysAllowAll: enabled })
    this.requireBootstrap().baseOptions.trustMode = enabled
    return this.settingsResult()
  }

  async setContextWindow(modelId: string, tokens: number | null): Promise<SettingsActionResult> {
    const id = modelId.trim()
    if (!id) throw new Error('模型 ID 不能为空')
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_WINDOW_OVERRIDE)) {
      throw new Error(`上下文上限不能小于 ${MIN_CONTEXT_WINDOW_OVERRIDE} tokens`)
    }
    const overrides = { ...(loadDesktopSettings().contextWindowOverrides ?? {}) }
    if (tokens === null) delete overrides[id]
    else overrides[id] = tokens
    saveDesktopSettings({ contextWindowOverrides: overrides })
    setModelContextWindowOverrides(overrides)
    this.send({ type: 'app:state', state: this.getState() })
    void this.emitSettings()
    return this.settingsResult()
  }

  async setBrowserEnabled(enabled: boolean): Promise<SettingsActionResult> {
    this.assertIdle()
    const browser = loadUserConfig().browser
    saveUserConfig({ browser: { ...browser, enabled } })
    this.requireBootstrap().subAgentRegistry?.setBrowserEnabled(enabled)
    this.invalidatePromptCache()
    await this.shutdownBrowserIfUnused()
    return this.settingsResult()
  }

  async setBrowserVisualCheck(enabled: boolean): Promise<SettingsActionResult> {
    this.assertIdle()
    const browser = loadUserConfig().browser
    saveUserConfig({ browser: { ...browser, visualCheck: enabled } })
    const bootstrap = this.requireBootstrap()
    bootstrap.baseOptions.browserVisualCheckEnabled = enabled
    this.invalidatePromptCache()
    await this.shutdownBrowserIfUnused()
    return this.settingsResult()
  }

  private async shutdownBrowserIfUnused(): Promise<void> {
    const browser = loadUserConfig().browser
    if (browser?.enabled !== true && browser?.visualCheck === false) {
      await shutdownBrowserMcp().catch(() => undefined)
    }
  }

  listPermissionRules(): PermissionRulesResult {
    return { rules: visiblePermissionRules(readPersistedRules(this.workspaceRoot()), this.workspaceRoot()) }
  }

  addPermissionRule(tool: string, type: PermissionRuleType, pattern: string): PermissionRulesResult {
    const workspace = this.workspaceRoot()
    const rule = normalizeNewPermissionRule(tool, type, pattern, workspace)
    persistRule(workspace, rule)
    addSessionAllowRule(rule)
    return this.listPermissionRules()
  }

  removePermissionRule(tool: string, type: PermissionRuleType, pattern: string, cwd?: string): PermissionRulesResult {
    const workspace = this.workspaceRoot()
    const rule: AllowRule = {
      tool: tool.trim(),
      pattern: pattern.trim(),
      type,
      ...(cwd ? { cwd } : {}),
    }
    removePersistedRule(workspace, rule)
    removeSessionAllowRule({
      ...rule,
      ...(rule.tool === 'shell' && !rule.cwd ? { cwd: workspace } : {}),
    })
    return this.listPermissionRules()
  }

  testConnection(provider: string, key?: string, baseUrl?: string): Promise<TestConnectionResult> {
    return testProviderConnection(provider, key, baseUrl)
  }

  async importSkill(sourcePath: string): Promise<SkillImportResult> {
    this.assertIdle()
    const bootstrap = this.requireBootstrap()
    const registry = bootstrap.skillRegistry
    const before = new Set(registry?.listAll().map((skill) => skill.name) ?? [])
    const { dir, sourceName } = await importSkillIntoUserDir(sourcePath)
    if (registry) await this.reloadSkillsRegistry(registry, bootstrap.skillExtraDirs)
    if (!registry?.getEntry(sourceName)) {
      await fs.promises.rm(dir, { recursive: true, force: true })
      throw new Error('未能加载技能，请检查 SKILL.md 的 frontmatter（至少需要 name 和 description）')
    }
    const added = registry
      .listAll()
      .filter((skill) => !before.has(skill.name))
      .map((skill) => skill.name)
    this.invalidatePromptCache()
    const settings = await this.getSettings()
    return { added: added.length > 0 ? added : [sourceName], settings }
  }

  async installPluginPath(path: string): Promise<PluginInstallResult> {
    return this.installPluginFromTarget(path)
  }

  async installSkillCommand(command: string): Promise<SkillImportResult> {
    this.assertIdle()
    const bootstrap = this.requireBootstrap()
    const before = new Set(bootstrap.skillRegistry?.listAll().map((skill) => skill.name) ?? [])

    if (isPluginInstallCommand(command)) {
      const info = await installPluginTarget(command)
      await this.reloadExtensions(this.modelId)
      const registry = this.requireBootstrap().skillRegistry
      const added = (registry?.listAll() ?? []).filter((skill) => !before.has(skill.name)).map((skill) => skill.name)
      return { added, settings: await this.getSettings(), plugin: info }
    }

    const copied = await installSkillsFromCommand(command)
    return this.finishSkillInstall(copied, before)
  }

  async searchSkillMarket(provider: SkillMarketProvider, query: string, limit = 20): Promise<SkillMarketListView> {
    this.assertIdle()
    const registry = this.requireBootstrap().skillRegistry
    const installed = new Set((registry?.listAll() ?? []).map((skill) => skill.name.toLowerCase()))
    return searchSkillMarket(provider, query, limit, installed)
  }

  async installSkillMarket(
    provider: SkillMarketProvider,
    id: string,
    version?: string,
    sourceUrl?: string,
  ): Promise<SkillImportResult> {
    this.assertIdle()
    const before = new Set(
      this.requireBootstrap()
        .skillRegistry?.listAll()
        .map((skill) => skill.name) ?? [],
    )
    let copied: CopiedSkill[]
    if (provider === 'skillhub') {
      copied = [await installSkillHubSkill(id, version)]
    } else if (provider === 'skillsmp') {
      if (!sourceUrl) throw new Error('缺少技能来源地址')
      copied = await installSkillsFromCommand(assertGitHubSkillUrl(sourceUrl))
    } else {
      throw new Error('未知的技能市场')
    }
    return this.finishSkillInstall(copied, before)
  }

  private async finishSkillInstall(copied: CopiedSkill[], before: Set<string>): Promise<SkillImportResult> {
    const bootstrap = this.requireBootstrap()
    const registry = bootstrap.skillRegistry
    if (registry) await this.reloadSkillsRegistry(registry, bootstrap.skillExtraDirs)

    const loaded = copied.filter((item) => registry?.getEntry(item.sourceName))
    for (const item of copied) {
      if (!loaded.includes(item)) await fs.promises.rm(item.dir, { recursive: true, force: true })
    }
    if (loaded.length === 0) {
      throw new Error('未能加载技能，请检查 SKILL.md 的 frontmatter（至少需要 name 和 description）')
    }

    const added = (registry?.listAll() ?? []).filter((skill) => !before.has(skill.name)).map((skill) => skill.name)
    this.invalidatePromptCache()
    return {
      added: added.length > 0 ? added : loaded.map((item) => item.sourceName),
      settings: await this.getSettings(),
    }
  }

  async installPluginCommand(command: string, userConfig?: UserConfigValues): Promise<PluginInstallResult> {
    return this.installPluginFromTarget(command, userConfig)
  }

  private async installPluginFromTarget(target: string, userConfig?: UserConfigValues): Promise<PluginInstallResult> {
    this.assertIdle()
    const info = await installPluginTarget(target, userConfig)
    await this.reloadExtensions(this.modelId)
    return { ...info, settings: await this.getSettings() }
  }

  listMarketplace(query = '', refresh = false): Promise<MarketplaceListView> {
    return listMarketplacePlugins(query, refresh)
  }

  async installMarketplace(id: string): Promise<PluginInstallResult> {
    this.assertIdle()
    const info = await installMarketplacePluginInfo(id)
    await this.reloadExtensions(this.modelId)
    return { ...info, settings: await this.getSettings() }
  }

  addMarketplaceEntry(name: string, source: string): Promise<MarketplaceListView> {
    return addMarketplace(name, source)
  }

  async previewPlugin(target: PluginInstallTarget): Promise<PluginConsentPreviewView> {
    const preview = await previewPluginInstall(target)
    const source =
      preview.source.kind === 'local'
        ? { kind: 'local' as const, label: preview.source.path }
        : preview.source.kind === 'github'
          ? {
              kind: 'github' as const,
              label: `${preview.source.owner}/${preview.source.repo}${preview.source.ref ? `#${preview.source.ref}` : ''}`,
            }
          : { kind: 'git' as const, label: preview.source.url }

    return {
      pluginId: preview.pluginId,
      version: preview.version,
      description: preview.description,
      marketplace: preview.marketplace,
      verified: preview.verified,
      fromReservedMarketplace: preview.fromReservedMarketplace,
      source,
      hookEvents: preview.hookEvents,
      inlineMcpServerNames: preview.inlineMcpServerNames,
      hasPathMcpServers: preview.hasPathMcpServers,
      hasPathHooks: preview.hasPathHooks,
      hasSkillsDir: preview.hasSkillsDir,
      hasAgentsDir: preview.hasAgentsDir,
      hasCommandsDir: preview.hasCommandsDir,
      author: preview.author,
      license: preview.license,
      homepage: preview.homepage,
      ...(preview.userConfig && preview.userConfig.length > 0
        ? { userConfig: toUserConfigFields(preview.userConfig) }
        : {}),
    }
  }

  async installPluginConfirmed(
    target: PluginInstallTarget,
    userConfig?: UserConfigValues,
  ): Promise<PluginInstallResult> {
    this.assertIdle()
    const info = await installPluginWithConsent(target, userConfig)
    await this.reloadExtensions(this.modelId)
    return { ...info, settings: await this.getSettings() }
  }

  async pluginUserConfig(
    id: string,
  ): Promise<{ fields: UserConfigFieldView[]; values: UserConfigValues; setKeys: string[] }> {
    const plugin = this.requireBootstrap()
      .pluginRegistry.listAll()
      .find((entry) => entry.id === id)
    if (!plugin) throw new Error(`plugin-not-found: ${id}`)
    const fields = toUserConfigFields(plugin.manifest.userConfig)
    const stored = await getPluginUserConfig(id)
    const values: UserConfigValues = {}
    for (const field of fields) {
      if (field.sensitive) continue
      if (Object.hasOwn(stored, field.key)) values[field.key] = stored[field.key]!
    }
    return { fields, values, setKeys: Object.keys(stored) }
  }

  async savePluginUserConfig(id: string, values: UserConfigValues): Promise<SettingsActionResult> {
    this.assertIdle()
    const plugin = this.requireBootstrap()
      .pluginRegistry.listAll()
      .find((entry) => entry.id === id)
    if (!plugin) throw new Error(`plugin-not-found: ${id}`)
    const next: Record<string, string | number | boolean> = {}
    for (const field of plugin.manifest.userConfig ?? []) {
      if (!Object.hasOwn(values, field.key)) continue
      const raw = values[field.key]!
      // An empty sensitive field means "keep the stored value unchanged".
      if (field.sensitive === true && raw === '') continue
      next[field.key] = coerceUserConfigValue(field.type, raw)
    }
    await setPluginUserConfig(id, next)
    await this.reloadExtensions(this.modelId)
    return this.settingsResult()
  }

  async uninstallPluginById(id: string): Promise<SettingsActionResult> {
    this.assertIdle()
    await uninstallPlugin(id)
    await clearPluginUserConfig(id)
    const workspace = this.requireBootstrap().workspace
    for (const scope of ['user', 'project'] as const) {
      await clearPluginEntry(id, scope, workspace).catch(() => undefined)
    }
    await this.reloadExtensions(this.modelId)
    return this.settingsResult()
  }

  async removeSkill(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    const bootstrap = this.requireBootstrap()
    const entry = bootstrap.skillRegistry?.getEntry(name)
    if (!entry) throw new Error(`skill-not-found: ${name}`)
    if (entry.source !== 'user' || entry.pluginId) {
      throw new Error('只能删除用户目录中直接安装的技能')
    }
    const root = path.join(userXcodeDir(), 'skills')
    const resolved = path.resolve(entry.dir)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('拒绝删除用户技能目录之外的路径')
    }
    await fs.promises.rm(resolved, { recursive: true, force: true })
    if (bootstrap.skillRegistry) {
      await this.reloadSkillsRegistry(bootstrap.skillRegistry, bootstrap.skillExtraDirs)
    }
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async trustProjectMcp(): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.trustWorkspaceProject()
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async authenticateMcp(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.authenticate(name)
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<SettingsActionResult> {
    this.assertIdle()
    const bootstrap = this.requireBootstrap()
    const entry = bootstrap.pluginRegistry.getEntry(id)
    if (!entry) throw new Error(`plugin-not-found: ${id}`)
    await setPluginEnabled(id, entry.scope, enabled, bootstrap.workspace)
    await this.reloadExtensions(this.modelId)
    return this.settingsResult()
  }

  async saveMcpServer(name: string, config: Record<string, unknown>): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.saveServer(name, config)
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async removeMcpServer(name: string): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.removeServer(name)
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async registerSkillsMpMcp(): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.registerSkillsMp()
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async reloadMcp(): Promise<SettingsActionResult> {
    this.assertIdle()
    if (!this.mcp) throw new Error('mcp-not-ready')
    await this.mcp.reload()
    this.rewireMcp()
    this.invalidatePromptCache()
    return this.settingsResult()
  }

  async reloadAll(): Promise<SettingsActionResult> {
    if (this.activeTurn) {
      // A turn owns the current tool surface; apply the persisted preferences
      // that can change safely, then let the renderer refresh its settings UI.
      const desktopSettings = loadDesktopSettings()
      this.disabledTools = new Set(desktopSettings.disabledTools ?? [])
      this.autoAllowedTools = new Set(desktopSettings.autoAllowedTools ?? [])
      this.alwaysAllowAll = desktopSettings.alwaysAllowAll === true
      applySearchProviderPreference(desktopSettings.searchProvider)
      this.requireBootstrap().baseOptions.trustMode = this.alwaysAllowAll
      this.applyToolFilter()
      this.send({ type: 'app:state', state: this.getState() })
    } else {
      // Several windows can announce changes at once; serialize the reload so
      // two bootstrap passes never replace MCP/memory state concurrently.
      while (this.reloadingSettings) {
        try {
          await this.reloadingSettings
        } catch {
          // The previous reload failed; this one still gets its turn.
        }
      }
      const reload = this.reloadExtensions(this.modelId)
      this.reloadingSettings = reload
      try {
        await reload
      } finally {
        if (this.reloadingSettings === reload) this.reloadingSettings = null
      }
    }
    void this.emitSettings()
    return this.settingsResult()
  }

  private async reloadExtensions(preserveModelId?: string): Promise<void> {
    this.assertIdle()
    this.cancelAllApprovals()
    this.fileIndex = null
    await this.mcp?.shutdown()
    const previousBootstrap = this.bootstrap
    const next = await bootstrapRuntime(this.workspaceOverride)
    this.bootstrap = next
    const previousMemory = previousBootstrap?.memoryService
    if (previousMemory) {
      void previousMemory.shutdown(previousMemory.getConfig().drainTimeoutMs).catch(() => undefined)
    }
    this.state = { ...next.appState }
    const desktopSettings = loadDesktopSettings()
    this.disabledTools = new Set(desktopSettings.disabledTools ?? [])
    this.autoAllowedTools = new Set(desktopSettings.autoAllowedTools ?? [])
    this.alwaysAllowAll = desktopSettings.alwaysAllowAll === true
    next.baseOptions.trustMode = this.alwaysAllowAll
    this.applyToolFilter()

    const previous = preserveModelId ?? this.modelId
    this.model = next.model
    this.modelId = next.modelId
    this.demo = next.demo
    const desired = next.appState.models.some((model) => model.id === previous) ? previous : next.modelId
    try {
      this.applyModel(desired, false)
    } catch {
      this.applyModel(next.modelId, false)
    }

    this.mcp = new McpService(
      next.workspace,
      next.mcpExtraServers,
      () => {
        this.invalidatePromptCache()
        void this.emitSettings()
      },
      (server, url) => this.send({ type: 'mcp:auth-url', server, url }),
    )
    try {
      await this.mcp.load()
    } catch (error) {
      this.send({
        type: 'runtime:log',
        level: 'warn',
        message: `mcp load failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    this.rewireMcp()
    this.invalidatePromptCache()
    this.applyProjectOverrides()
    this.send({ type: 'app:state', state: this.getState() })
  }

  private settingsResult(): Promise<SettingsActionResult> {
    return this.getSettings().then((settings) => ({ state: this.getState(), settings }))
  }

  private async emitSettings(): Promise<void> {
    try {
      this.send({ type: 'settings:changed', settings: await this.getSettings() })
    } catch {
      // Best-effort; the next explicit request retries.
    }
  }

  private rewireMcp(): void {
    if (!this.mcp) return
    const bootstrap = this.requireBootstrap()
    bootstrap.baseOptions.mcpRegistry = this.mcp.getRegistry()
    bootstrap.baseOptions.mcpPermissionStore = this.mcp.getPermissionStore()
  }

  private invalidatePromptCache(): void {
    if (!this.loopState) return
    this.loopState.systemPromptCache = null
    this.loopState.systemPromptBlocks = undefined
    this.loopState.deferredCatalog = undefined
  }

  /** An empty deny list must stay `undefined`: any toolFilter disables the
   *  root deferred-tool surface, so only install one when tools are actually
   *  disabled. */
  private applyToolFilter(): void {
    this.requireBootstrap().baseOptions.toolFilter =
      this.disabledTools.size > 0 ? { deny: [...this.disabledTools] } : undefined
  }

  private assertIdle(): void {
    if (this.activeTurn) throw new Error('turn-busy')
  }

  async shutdown(): Promise<void> {
    this.abort()
    if (this.skillPollTimer) {
      clearInterval(this.skillPollTimer)
      this.skillPollTimer = null
    }
    this.shellUnsubscribe?.()
    this.shellUnsubscribe = null
    await this.mcp?.shutdown()
    const memory = this.bootstrap?.memoryService
    if (memory) await memory.shutdown(memory.getConfig().drainTimeoutMs).catch(() => undefined)
    if (!this.loopState || this.loopState.messages.length === 0) return
    const model = this.demo ? createDemoModel() : this.model
    if (!model) return
    try {
      await saveSession(this.loopState, model)
    } catch {
      // Best-effort flush on quit.
    }
  }

  private buildCallbacks(turnId: string, turn: ActiveTurn): AgentCallbacks {
    const send = this.send
    return {
      onTextDelta: (delta) => {
        if (!delta) return
        turn.text += delta
        send({ type: 'agent:text-delta', turnId, delta })
      },
      onToolCall: (toolCallId, toolName, input) => {
        send({ type: 'agent:tool-call', turnId, toolCallId, toolName, input })
      },
      onToolProgress: (toolCallId, message) => {
        send({ type: 'agent:tool-progress', turnId, toolCallId, message })
      },
      onToolResult: (toolCallId, result, isError) => {
        send({ type: 'agent:tool-result', turnId, toolCallId, result, isError: isError === true })
      },
      onFileEdit: (toolCallId, payload) => {
        this.editHistory.set(toolCallId, {
          filePath: payload.filePath,
          ...(payload.beforeContent !== undefined ? { beforeContent: payload.beforeContent } : {}),
          ...(payload.afterContent !== undefined ? { afterContent: payload.afterContent } : {}),
          isCreate: payload.isCreate,
        })
        while (this.editHistory.size > 100) {
          const oldest = this.editHistory.keys().next().value
          if (oldest === undefined) break
          this.editHistory.delete(oldest)
        }
        send({ type: 'agent:file-edit', turnId, toolCallId, payload: toFileEditView(payload) })
      },
      onAskPermission: async (toolCall) => {
        if (this.alwaysAllowAll || this.autoAllowedTools.has(toolCall.toolName)) return 'yes'
        const decision = await this.requestApproval({
          kind: 'permission',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
        return decision as PermissionDecision
      },
      onAskAuthority: async (request) => {
        const decision = await this.requestApproval({
          kind: 'authority',
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
          preview: {
            summary: request.preview.summary,
            paths: request.preview.paths,
            destination: request.preview.destination,
            complete: request.preview.complete,
            approvable: request.preview.approvable,
            reason: request.preview.reason,
          },
          authority: {
            canonicalCallSha256: request.preview.canonicalCallSha256,
            authorityHash: request.preview.authorityHash,
          },
        })
        return decision as AuthorityApproval
      },
      onAskUser: async (question, options) => {
        const answer = await this.requestApproval({ kind: 'question', question, options })
        return typeof answer === 'string' ? answer : ''
      },
      onPlanApprovalRequest: async (planText) => {
        const approved = await this.requestApproval({ kind: 'plan', planText })
        return approved === true
      },
      onPlanModeChange: (mode) => {
        send({ type: 'agent:permission-mode', mode })
      },
      onTodosUpdate: (todos) => {
        send({ type: 'agent:todos', todos: toTodoViews(todos) })
      },
      onShellOutput: () => {},
      onUsageUpdate: (usage) => {
        send({ type: 'agent:usage', usage: toUsageView(usage, this.modelId) })
      },
      onContextCompressed: (summary) => {
        send({ type: 'agent:context-compressed', summary })
      },
      onCompressionProgress: (description) => {
        send({ type: 'agent:compression-progress', description })
      },
      onStreamRetry: (event: StreamRetryEvent | null) => {
        if (event) {
          send({
            type: 'agent:stream-retry',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
          })
        }
      },
      onSubAgentEvent: (event) => {
        switch (event.kind) {
          case 'start':
            send({
              type: 'agent:subagent',
              toolCallId: event.toolCallId,
              phase: 'start',
              agentName: event.agentName,
              description: event.description,
            })
            break
          case 'text-delta':
            send({ type: 'agent:subagent', toolCallId: event.toolCallId, phase: 'text', text: event.delta })
            break
          case 'tool-call': {
            let input = ''
            try {
              input = JSON.stringify(event.subInput)
            } catch {
              input = String(event.subInput)
            }
            send({
              type: 'agent:subagent',
              toolCallId: event.toolCallId,
              phase: 'tool',
              subToolName: event.subToolName,
              text: input.slice(0, 300),
            })
            break
          }
          case 'tool-result':
            send({
              type: 'agent:subagent',
              toolCallId: event.toolCallId,
              phase: 'tool-result',
              subToolName: event.subToolName,
              text: event.resultPreview,
              isError: event.isError,
              durationMs: event.durationMs,
            })
            break
          case 'end':
            send({
              type: 'agent:subagent',
              toolCallId: event.toolCallId,
              phase: 'end',
              text: event.finalText.slice(0, 2000),
              turnCount: event.turnCount,
              durationMs: event.durationMs,
              aborted: event.aborted,
            })
            break
        }
      },
      onError: (error) => {
        send({ type: 'agent:error', turnId, message: error.message })
      },
    }
  }

  private requestApproval(
    request: Omit<ApprovalRequestEvent, 'requestId'> & {
      authority?: { canonicalCallSha256: string; authorityHash: string }
    },
  ): Promise<unknown> {
    const requestId = `approval-${++this.approvalSeq}`
    return new Promise((resolve) => {
      this.approvals.set(requestId, {
        kind: request.kind,
        resolve,
        authority: request.authority,
      })
      this.send({
        type: 'approval:request',
        requestId,
        kind: request.kind,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input,
        question: request.question,
        options: request.options,
        planText: request.planText,
        preview: request.preview,
      })
      const title =
        request.kind === 'question' ? '需要你的选择' : request.kind === 'plan' ? '计划待确认' : '需要你的确认'
      this.notify(title, request.question ?? request.toolName ?? '有一项操作等待你的批准', this.loopState?.sessionId)
    })
  }

  private emitSessionSaved(state: LoopState): void {
    if (!state.sessionFilePath) return
    const firstUser = state.messages.find((message) => message.role === 'user')
    const firstPrompt = firstUser ? extractText(firstUser.content).slice(0, 120) : ''
    this.send({
      type: 'session:saved',
      item: {
        filePath: state.sessionFilePath,
        sessionId: state.sessionId,
        firstPrompt,
        startedAt: state.startedAt,
        modelId: this.modelId,
        mtime: Date.now(),
      },
    })
  }

  private requireBootstrap(): RuntimeBootstrap {
    if (!this.bootstrap) throw new Error('runtime-not-initialized')
    return this.bootstrap
  }
}
