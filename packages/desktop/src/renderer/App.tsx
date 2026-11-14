import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AppState,
  ApprovalRequestEvent,
  BranchInfoView,
  BranchListView,
  CaptureScreenView,
  CompactResult,
  CustomCommandView,
  DocumentDiffView,
  DocumentPageView,
  DocumentRecentItem,
  DocumentView,
  GitStatusView,
  GoalView,
  LoadedSessionView,
  ModelOption,
  ProjectCheckResultView,
  ProjectCheckView,
  RewindResultView,
  RuntimeEvent,
  SessionListItem,
  SessionSearchResult,
  SettingsActionResult,
  SettingsSnapshot,
  SmokeReport,
  SubAgentView,
  TempDeliverableMoveResult,
  TextReport,
  TodoView,
  UsageView,
  WorkspaceFileItem,
  WorkspaceInsightsView,
  WorkspaceList,
  WorkspaceListItem,
  WorkspaceSessionsView,
} from '../shared/protocol.js'
import { ApprovalCard } from './ApprovalCard.js'
import { BackgroundPanel } from './BackgroundPanel.js'
import { ChecksPanel } from './ChecksPanel.js'
import { CommandPalette } from './CommandPalette.js'
import { ComposerBox } from './ComposerBox.js'
import type { MarkdownFormat } from './ComposerChrome.js'
import {
  AttachmentsStrip,
  BackgroundWait,
  EditBadge,
  MentionPalette,
  QueuedList,
  RecordingBar,
  SlashPalette,
  TurnActivityBar,
} from './ComposerChrome.js'
import type { ComposerEditorHandle } from './ComposerEditor.js'
import { ContextSearchPanel } from './ContextSearchPanel.js'
import { DocumentPanel } from './DocumentPanel.js'
import { GitPanel } from './GitPanel.js'
import { GoalPanel } from './GoalPanel.js'
import { Inspector } from './Inspector.js'
import type { InspectorTab } from './Inspector.js'
import { NextSteps } from './NextSteps.js'
import { OutlinePanel } from './OutlinePanel.js'
import { PromptRail } from './PromptRail.js'
import { RewindPanel } from './RewindPanel.js'
import type { RewindMode } from './RewindPanel.js'
import { ChatSkeleton, SettingsSkeleton } from './Skeleton.js'
import { TranscriptEntry, TranscriptEntryProvider } from './TranscriptEntry.js'
import { UsageChecklist } from './UsageChecklist.js'
import { UsageFooter } from './UsageFooter.js'
import { WorkspaceTree } from './WorkspaceTree.js'
import { TOOL_MENU_ACTION_IDS, createAppActions } from './actions.js'
import {
  BranchIcon,
  ChevronIcon,
  GoalIcon,
  HelpIcon,
  MoreIcon,
  OutlineIcon,
  SettingsIcon,
  SidebarIcon,
  TerminalIcon,
} from './icons.js'
import { isImeEnter, isImeEvent } from './ime.js'
import { base64FromBuffer } from './media.js'
import { detectMention } from './mention.js'
import { buildNextSteps } from './next-steps.js'
import {
  USAGE_DISMISSED_KEY,
  draftStorageKey,
  forgetLastDocument,
  readLastDocument,
  readUsage,
  rememberLastDocument,
  writeUsage,
} from './preferences.js'
import type { UsageKey } from './preferences.js'
import { providerDisplayName } from './provider-labels.js'
import { createSlashCommands } from './slash-commands.js'
import type { SlashCommand } from './slash-commands.js'
import { applyTheme, storedTheme, watchSystemTheme } from './theme.js'
import type { ThemeSetting } from './theme.js'
import {
  STATUS_LABEL,
  TASK_MODES,
  TASK_MODE_DESCRIPTION,
  TASK_MODE_LABEL,
  TASK_MODE_TEMPLATE,
  TOOL_DISPLAY_HINT,
  TOOL_DISPLAY_LABEL,
  TOOL_DISPLAY_MODES,
  buildTurnItems,
  formatContextTokens,
  normalizeTaskMode,
  normalizeToolDisplayMode,
  sessionTime,
  sessionTitle,
  taskBranchName,
} from './transcript-model.js'
import type { Entry, TaskMode, ToolDisplayMode, TurnRenderItem } from './transcript-model.js'
import { forcedOnboarding, isUiSmoke, runUiSmoke } from './ui-smoke.js'
import { useComposerKeyDown } from './use-composer-keydown.js'
import { encodeWav } from './wav.js'
import { detectExternalWorkspacePaths } from './workspace-guard.js'

const SettingsPanel = lazy(() => import('./SettingsPanel.js').then((module) => ({ default: module.SettingsPanel })))
const FilePanel = lazy(() => import('./FilePanel.js').then((module) => ({ default: module.FilePanel })))
const TerminalPanel = lazy(() => import('./TerminalPanel.js').then((module) => ({ default: module.TerminalPanel })))
const Onboarding = lazy(() => import('./Onboarding.js').then((module) => ({ default: module.Onboarding })))
const ManualPanel = lazy(() => import('./ManualPanel.js').then((module) => ({ default: module.ManualPanel })))

if (isUiSmoke) {
  try {
    // Smoke 运行与真实应用共享 Electron 的 localStorage；把它们的
    // 清单状态放到独立的 key 下。
    localStorage.removeItem('xcode.smoke.usage.v1')
    localStorage.removeItem('xcode.smoke.usage.dismissed')
  } catch {
    // 仅 Smoke 使用的重置。
  }
}
const wantsSettings = new URLSearchParams(window.location.search).has('settings')
const wantsSlashDemo = new URLSearchParams(window.location.search).has('slash')

const SIDEBAR_WIDTH_KEY = 'xcode.sidebar.width.v1'
const EXPANDED_WORKSPACES_KEY = 'xcode.workspaces.expanded.v1'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 440

function storedSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= SIDEBAR_MIN_WIDTH && raw <= SIDEBAR_MAX_WIDTH) return Math.round(raw)
  } catch {
    // 忽略存储异常，回落到默认宽度。
  }
  return 280
}

function storedExpandedWorkspaces(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_WORKSPACES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'))
    }
  } catch {
    // 忽略损坏的持久化数据。
  }
  return new Set()
}

type TurnActivityKind = 'model' | 'reasoning' | 'streaming' | 'tool' | 'tool-input' | 'approval' | 'retry'

interface TurnActivity {
  kind: TurnActivityKind
  detail?: string
  startedAt: number
}

/** 每个会话独立的 transcript 缓冲；同窗口切标签时整块换入/换出。 */
interface SessionBuffer {
  sessionId: string
  entries: Entry[]
  usage: UsageView | null
  todos: TodoView[]
  activeTurnId: string | null
  textEntryId: string | null
}

export function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => storedTheme())
  const language = i18n.language === 'en' ? 'en' : 'zh'

  useEffect(() => {
    applyTheme(themeSetting)
  }, [themeSetting])

  useEffect(() => {
    if (themeSetting !== 'system') return
    return watchSystemTheme(() => applyTheme('system'))
  }, [themeSetting])

  // 其他窗口共享 localStorage；跟随那里发生的主题/语言变更。
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === 'xcode.theme') setThemeSetting(storedTheme())
      else if (event.key === 'xcode.language') void i18n.changeLanguage(event.newValue === 'en' ? 'en' : 'zh')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [i18n])

  const cycleTheme = (): void => {
    setThemeSetting((prev) => (prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light'))
  }
  const toggleLanguage = (): void => {
    void i18n.changeLanguage(language === 'zh' ? 'en' : 'zh')
  }

  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [mention, setMention] = useState<{ atIdx: number; query: string; tokenEnd: number } | null>(null)
  const [mentionItems, setMentionItems] = useState<WorkspaceFileItem[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [turnActivity, setTurnActivity] = useState<TurnActivity | null>(null)
  const turnActivityRef = useRef<TurnActivity | null>(null)
  const lastAgentEventAtRef = useRef(0)
  // 每秒更新一次，驱动“已等待”计时；渲染时只读这个值，避免在渲染中读时钟。
  const [turnNow, setTurnNow] = useState(0)
  const [status, setStatus] = useState<'starting' | 'ready' | 'offline'>('starting')
  const [report, setReport] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(() =>
    new URLSearchParams(window.location.search).has('terminal') ? 'terminal' : null,
  )
  const openInspector = (tab: InspectorTab): void => setInspectorTab(tab)
  const closeInspector = (): void => setInspectorTab(null)
  const toggleInspector = (tab: InspectorTab): void => setInspectorTab((current) => (current === tab ? null : tab))
  const terminalOpen = inspectorTab === 'terminal'
  // 由工具卡片触发的“在终端执行”：TerminalPanel 消费后回调清空，避免下次
  // 打开终端时重复执行旧命令。
  const [terminalCommand, setTerminalCommand] = useState<{ text: string; token: number } | null>(null)
  const runInTerminal = (command: string): void => {
    setTerminalCommand({ text: command, token: Date.now() })
    openInspector('terminal')
  }
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [backgroundActive, setBackgroundActive] = useState(0)
  const [switchingProject, setSwitchingProject] = useState<string | null>(null)
  const [workspaceGuard, setWorkspaceGuard] = useState<{
    prompt: string
    files: string[]
    external: string[]
  } | null>(null)
  const [workspaceGuardOff, setWorkspaceGuardOff] = useState(false)
  const workspaceGuardBypassRef = useRef(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [rewindInitialMode, setRewindInitialMode] = useState<RewindMode>('both')
  const [goalOpen, setGoalOpen] = useState(false)
  const [contextSearchOpen, setContextSearchOpen] = useState(false)
  const [goal, setGoal] = useState<GoalView | null>(null)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const [usageProgress, setUsageProgress] = useState<Record<UsageKey, boolean>>(() => readUsage())
  const [usageDismissed, setUsageDismissed] = useState(() => {
    try {
      return localStorage.getItem(USAGE_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [usageOpen, setUsageOpen] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [workspaceSessionsLoaded, setWorkspaceSessionsLoaded] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchView, setBranchView] = useState<BranchListView | null>(null)
  const [branchQuery, setBranchQuery] = useState('')
  const [branchBusy, setBranchBusy] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchBusy, setNewBranchBusy] = useState(false)
  const [newBranchParent, setNewBranchParent] = useState('')
  const [newTaskPrompt, setNewTaskPrompt] = useState('')
  const [imageLightbox, setImageLightbox] = useState<{ src: string; name: string } | null>(null)
  const [removeWorktree, setRemoveWorktree] = useState<{ path: string; branch: string } | null>(null)
  const [removeWorktreeBusy, setRemoveWorktreeBusy] = useState(false)
  const [removeWorktreeError, setRemoveWorktreeError] = useState<string | null>(null)
  const [pruneBusy, setPruneBusy] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [fileInitialPath, setFileInitialPath] = useState<string | null>(null)
  const sessionSearchRef = useRef<HTMLInputElement | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([])
  const [workspaceSessions, setWorkspaceSessions] = useState<WorkspaceSessionsView[]>([])
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(storedExpandedWorkspaces)
  const [runningOther, setRunningOther] = useState<Record<string, string[]>>({})
  const [workspaceInsights, setWorkspaceInsights] = useState<WorkspaceInsightsView | null>(null)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  // 同一窗口多个会话并行：运行中的标签各自保留一份 transcript 缓冲。
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set())
  const runningSessionIdsRef = useRef<Set<string>>(new Set())
  const turnSessionRef = useRef<Map<string, string>>(new Map())
  const hostSessionIdRef = useRef<string | null>(null)
  const sessionBuffersRef = useRef<Map<string, SessionBuffer>>(new Map())
  const [toolDisplayMode, setToolDisplayMode] = useState<ToolDisplayMode>(() =>
    normalizeToolDisplayMode(localStorage.getItem('xcode.toolDisplay')),
  )
  // 记录用户对某一轮工具组的显式展开/收起，优先级高于模式默认值。
  const [turnToolOverrides, setTurnToolOverrides] = useState<Map<string, boolean>>(new Map())
  const [turnWindow, setTurnWindow] = useState(40)
  const turnWindowAnchorRef = useRef<{ height: number; top: number } | null>(null)

  // 展开更早轮次时保持当前阅读位置，避免内容突然向下跳。
  useLayoutEffect(() => {
    const anchor = turnWindowAnchorRef.current
    const node = scrollRef.current
    if (!anchor || !node) return
    turnWindowAnchorRef.current = null
    node.scrollTop = node.scrollHeight - anchor.height + anchor.top
  }, [turnWindow])
  const [tabs, setTabs] = useState<string[]>([])
  const [tabTitles, setTabTitles] = useState<Record<string, string>>({})
  const [pendingSession, setPendingSession] = useState<{ sessionId: string; at: number } | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([])
  const [searchingSessions, setSearchingSessions] = useState(false)
  const [renaming, setRenaming] = useState<{ filePath: string; value: string } | null>(null)
  const [deletingSession, setDeletingSession] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{ filePath: string; x: number; y: number } | null>(null)
  const [salvageTarget, setSalvageTarget] = useState<SessionListItem | null>(null)
  const [salvageBusy, setSalvageBusy] = useState(false)
  const [documentView, setDocumentView] = useState<DocumentView | null>(null)
  const [documentLoading, setDocumentLoading] = useState(false)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [documentRecent, setDocumentRecent] = useState<DocumentRecentItem[]>([])
  const [documentLoadingMore, setDocumentLoadingMore] = useState(false)
  const [documentFocusPage, setDocumentFocusPage] = useState<number | null>(null)
  const [gitStatusView, setGitStatusView] = useState<GitStatusView | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitSelected, setGitSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [gitDiffText, setGitDiffText] = useState<string | null>(null)
  const [gitDiffTruncated, setGitDiffTruncated] = useState(false)

  const [projectChecks, setProjectChecks] = useState<ProjectCheckView[]>([])
  const [checkResults, setCheckResults] = useState<ProjectCheckResultView[]>([])
  const [checkAuto, setCheckAuto] = useState(false)
  const [checkAutoFix, setCheckAutoFix] = useState(false)
  const [checksLoading, setChecksLoading] = useState(false)
  const [checksError, setChecksError] = useState<string | null>(null)
  const documentViewsRef = useRef<Record<string, DocumentView>>({})
  const [settingsOpen, setSettingsOpen] = useState(wantsSettings)
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [customCommands, setCustomCommands] = useState<CustomCommandView[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [taskModeMenuOpen, setTaskModeMenuOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [customModelInput, setCustomModelInput] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [modelKeyIndex, setModelKeyIndex] = useState(-1)
  const [modelScan, setModelScan] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  // 多个工作区同时打开时，保持窗口标题可区分。
  useEffect(() => {
    const name = appState?.workspace?.split(/[\\/]/).filter(Boolean).pop()
    document.title = name ? `X-Code · ${name}` : 'X-Code'
  }, [appState?.workspace])
  const [approvals, setApprovals] = useState<ApprovalRequestEvent[]>([])
  const approval = approvals[0] ?? null
  const [questionDraft, setQuestionDraft] = useState('')
  useEffect(() => {
    setQuestionDraft('')
  }, [approval?.requestId])
  const [todos, setTodos] = useState<TodoView[]>([])
  // 清单在全部完成后会被核心清空；短暂保留再淡出，避免很短的任务让面板
  // 出现后立刻消失，看起来一直在闪。
  const [shownTodos, setShownTodos] = useState<TodoView[]>([])
  const [todosLeaving, setTodosLeaving] = useState(false)
  const todosShownRef = useRef<TodoView[]>([])
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [movingTempEntry, setMovingTempEntry] = useState<string | null>(null)
  const [queued, setQueued] = useState(0)
  const [nextStepsHidden, setNextStepsHidden] = useState(false)
  const [queuedItems, setQueuedItems] = useState<Array<{ prompt: string; attachments: string[] }>>([])
  const [editArmed, setEditArmed] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [captureMenuOpen, setCaptureMenuOpen] = useState(false)
  const [captureScreens, setCaptureScreens] = useState<CaptureScreenView[]>([])
  const [paletteIndex, setPaletteIndex] = useState(0)
  const activeTextEntryId = useRef<string | null>(null)
  const pendingTextRef = useRef<Map<string, { entryId: string; text: string }>>(new Map())
  const streamFrameRef = useRef<number | null>(null)
  const lastTextFlushRef = useRef(0)
  const busyRef = useRef(false)
  const queueRef = useRef<Array<{ prompt: string; attachments: string[] }>>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nearBottomRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [unseenEntries, setUnseenEntries] = useState(0)
  const seenEntryCountRef = useRef(0)
  const uiSmokeRan = useRef(false)
  const promptAutoSubmitRef = useRef(false)
  const submitRef = useRef<
    (prompt: string, alreadyShown?: boolean, attachments?: string[], displayText?: string) => void
  >(() => {})
  const composerRef = useRef<ComposerEditorHandle | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioChunksRef = useRef<Float32Array[]>([])
  const audioSampleRateRef = useRef(48_000)
  const recordStartedAtRef = useRef(0)
  const lastLevelAtRef = useRef(0)
  const dismissedMentionRef = useRef<{ atIdx: number; query: string } | null>(null)
  const pendingSessionRef = useRef<string | null>(null)
  const settingsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emptyTabsRef = useRef<Set<string>>(new Set())
  const renameCancelRef = useRef(false)
  const skipDraftSaveRef = useRef<string | null>(null)
  const restoredSessionRef = useRef(false)
  const restoredWindowSessionRef = useRef(false)
  const newWindowSessionRef = useRef(false)
  const draftKey = draftStorageKey(activeSessionId)

  const bufferKey = (): string => activeSessionIdRef.current ?? hostSessionIdRef.current ?? ''

  const createBuffer = (sessionId: string): SessionBuffer => ({
    sessionId,
    entries: [],
    usage: null,
    todos: [],
    activeTurnId: null,
    textEntryId: null,
  })

  const bufferFor = (sessionId: string): SessionBuffer => {
    let buffer = sessionBuffersRef.current.get(sessionId)
    if (!buffer) {
      buffer = createBuffer(sessionId)
      sessionBuffersRef.current.set(sessionId, buffer)
    }
    return buffer
  }

  const isVisibleSession = (sessionId: string): boolean => sessionId === activeSessionIdRef.current

  /** 事件只会写进它所属会话的缓冲，只有可见会话才同步到 React 状态。 */
  const commitEntries = (sessionId: string, updater: (previous: Entry[]) => Entry[]): void => {
    const buffer = bufferFor(sessionId)
    buffer.entries = updater(buffer.entries)
    if (isVisibleSession(sessionId)) {
      activeTextEntryId.current = buffer.textEntryId
      setEntries(buffer.entries)
    }
  }

  const appendTo = (sessionId: string, entry: Omit<Entry, 'id'> & { id?: string }): void => {
    const next = { id: entry.id ?? crypto.randomUUID(), ...entry }
    commitEntries(sessionId, (previous) => [...previous, next])
  }

  const replaceEntries = (sessionId: string, entries: Entry[]): void => {
    const buffer = bufferFor(sessionId)
    buffer.entries = entries
    buffer.textEntryId = null
    if (isVisibleSession(sessionId)) {
      activeTextEntryId.current = null
      setEntries(entries)
    }
  }

  const setUsageFor = (sessionId: string, usage: UsageView | null): void => {
    const buffer = bufferFor(sessionId)
    buffer.usage = usage
    if (isVisibleSession(sessionId)) setUsage(usage)
  }

  const setTodosFor = (sessionId: string, todos: TodoView[]): void => {
    const buffer = bufferFor(sessionId)
    buffer.todos = todos
    if (isVisibleSession(sessionId)) setTodos(todos)
  }

  /** 把会话缓冲整块换到界面上（切标签时使用）。 */
  const showSessionBuffer = (sessionId: string): void => {
    const buffer = bufferFor(sessionId)
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setTurnWindow(40)
    activeTextEntryId.current = buffer.textEntryId
    setEntries(buffer.entries)
    setUsage(buffer.usage)
    setTodos(buffer.todos)
    const running = buffer.activeTurnId !== null
    busyRef.current = running
    setBusy(running)
    if (!running) clearTurnActivity()
  }

  /** 当活动会话还没绑定 sessionId（全新窗口）时，把临时缓冲迁移到真实会话。 */
  const adoptSession = (sessionId: string): void => {
    const previousKey = activeSessionIdRef.current ?? hostSessionIdRef.current ?? ''
    if (previousKey !== sessionId) {
      const source = sessionBuffersRef.current.get(previousKey)
      if (source && source.entries.length > 0 && !sessionBuffersRef.current.has(sessionId)) {
        sessionBuffersRef.current.delete(previousKey)
        source.sessionId = sessionId
        sessionBuffersRef.current.set(sessionId, source)
      }
    }
    if (activeSessionIdRef.current === null) {
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
    }
  }

  const append = (entry: Omit<Entry, 'id'> & { id?: string }): void => {
    appendTo(bufferKey(), entry)
  }

  const markSessionRunning = (sessionId: string, running: boolean): void => {
    const next = new Set(runningSessionIdsRef.current)
    if (running) next.add(sessionId)
    else next.delete(sessionId)
    runningSessionIdsRef.current = next
    setRunningSessionIds(next)
  }

  /** busy 只代表当前可见会话是否在运行，避免切标签或后台结束时卡在“停止”状态。 */
  const syncBusyFromRunning = (): void => {
    const active = activeSessionIdRef.current
    const running = active !== null && runningSessionIdsRef.current.has(active)
    busyRef.current = running
    setBusy(running)
    if (!running) clearTurnActivity()
  }

  /** 事件属于哪个会话：优先显式 sessionId，其次按 turnId 反查。 */
  const sessionOf = (event: RuntimeEvent): string => {
    if ('sessionId' in event && typeof event.sessionId === 'string' && event.sessionId) return event.sessionId
    if ('turnId' in event && typeof event.turnId === 'string') {
      const mapped = turnSessionRef.current.get(event.turnId)
      if (mapped) return mapped
    }
    return bufferKey()
  }

  /** 记录当前轮次正在做什么；相同阶段不重置起始时间，只刷新最后活动时间。 */
  const markTurnActivity = (kind: TurnActivityKind, detail?: string): void => {
    const now = Date.now()
    lastAgentEventAtRef.current = now
    setTurnNow(now)
    const current = turnActivityRef.current
    if (current?.kind === kind && current.detail === detail) return
    // 同一阶段内 detail 可能持续变化（例如工具参数已生成的字符数），
    // 保留阶段开始时间，避免“已等待”被每次进度更新重置。
    const next: TurnActivity = current?.kind === kind ? { ...current, detail } : { kind, detail, startedAt: now }
    turnActivityRef.current = next
    setTurnActivity(next)
  }

  const clearTurnActivity = (): void => {
    turnActivityRef.current = null
    lastAgentEventAtRef.current = 0
    setTurnActivity(null)
  }

  const addTab = (sessionId: string): void => {
    setTabs((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]))
  }

  const openSessionFileKey = tabs
    .map((sessionId) => sessions.find((item) => item.sessionId === sessionId)?.filePath)
    .filter((value): value is string => Boolean(value))
    .join('\n')

  // 告诉主进程这个窗口拥有哪些会话文件，避免另一个窗口
  // 加载同一份记录并并发写入。
  useEffect(() => {
    const filePaths = openSessionFileKey ? openSessionFileKey.split('\n') : []
    void window.xcode
      .request({
        id: crypto.randomUUID(),
        method: 'app:set-window-sessions',
        params: { filePaths },
      })
      .catch(() => undefined)
  }, [openSessionFileKey])

  /** 显示一个尚未写入磁盘的会话标签页（还没有发送任何消息）。 */
  const activateEmptyTab = (sessionId: string): void => {
    sessionBuffersRef.current.set(sessionId, createBuffer(sessionId))
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setEntries([])
    setUsage(null)
    setTodos([])
    busyRef.current = false
    setBusy(false)
    clearTurnActivity()
    setQueued(0)
    queueRef.current = []
    setQueuedItems([])
    setAttachments([])
    setReport(null)
    pendingSessionRef.current = sessionId
    setPendingSession({ sessionId, at: Date.now() })
  }

  const refreshSessions = async (): Promise<void> => {
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:list',
        params: {},
      })
      if (response.ok) setSessions(response.result as SessionListItem[])
    } finally {
      setSessionsLoaded(true)
    }
  }

  const refreshWorkspaces = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'workspace:list',
      params: {},
    })
    if (response.ok) setWorkspaces((response.result as WorkspaceList).projects)
  }

  const refreshWorkspaceSessions = async (): Promise<void> => {
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:list-all',
        params: {},
      })
      if (response.ok) setWorkspaceSessions(response.result as WorkspaceSessionsView[])
    } finally {
      setWorkspaceSessionsLoaded(true)
    }
  }

  const refreshWorkspaceInsights = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'workspace:insights',
      params: {},
    })
    if (response.ok) setWorkspaceInsights(response.result as WorkspaceInsightsView)
  }

  const markUsage = (key: UsageKey): void => {
    setUsageProgress((current) => {
      if (current[key]) return current
      const next = { ...current, [key]: true }
      writeUsage(next)
      return next
    })
  }

  useEffect(() => {
    if (paletteOpen) markUsage('palette')
  }, [paletteOpen])

  const updateMention = (value: string, caret: number): void => {
    if (value.startsWith('/')) {
      if (mention !== null) setMention(null)
      return
    }
    const trigger = detectMention(value, caret)
    if (!trigger) {
      if (mention !== null) {
        setMention(null)
        setMentionItems([])
      }
      dismissedMentionRef.current = null
      return
    }
    const dismissed = dismissedMentionRef.current
    if (dismissed && dismissed.atIdx === trigger.atIdx && dismissed.query === trigger.query) return
    dismissedMentionRef.current = null
    // 只有当 token 本身变化时才重置高亮。keyup 在每次方向键按下后
    // 也会触发；在那里重置会把选中项弹回第一项。
    if (
      mention &&
      mention.atIdx === trigger.atIdx &&
      mention.query === trigger.query &&
      mention.tokenEnd === trigger.tokenEnd
    ) {
      return
    }
    setMention(trigger)
    setMentionIndex(0)
  }

  const pickMention = (file: WorkspaceFileItem): void => {
    if (!mention) return
    const target = file.isDirectory ? `${file.path}/` : file.path
    const quoted = /\s|["\\]/.test(target)
    const token = quoted ? `@"${target.replace(/"/g, '\\"')}"` : `@${target}`
    // 只替换当前 @-token；光标落在结束引号前时目录会继续展开子项。
    composerRef.current?.replaceBeforeCaret(mention.tokenEnd - mention.atIdx, token, quoted ? 1 : 0)
    setMention(null)
    setMentionItems([])
  }

  const applyMarkdown = (kind: MarkdownFormat): void => {
    composerRef.current?.toggleFormat(kind)
  }

  useEffect(() => {
    if (!mention) {
      setMentionItems([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.xcode
        .request({
          id: crypto.randomUUID(),
          method: 'workspace:files',
          params: { query: mention.query, limit: 20 },
        })
        .then((response) => {
          if (cancelled) return
          setMentionItems(response.ok ? (response.result as { files: WorkspaceFileItem[] }).files : [])
          setMentionIndex(0)
        })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mention])

  useEffect(() => {
    document.querySelector('[data-testid="mention-palette"] .slash-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex, mentionItems])

  const refreshState = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:state',
      params: {},
    })
    if (response.ok) setAppState(response.result as AppState)
  }

  const refreshSettings = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:get',
      params: {},
    })
    if (response.ok) setSettings(response.result as SettingsSnapshot)
  }

  const refreshCommands = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:list',
      params: {},
    })
    if (response.ok) setCustomCommands((response.result as { commands: CustomCommandView[] }).commands)
  }

  useEffect(() => {
    void refreshState()
    void refreshSessions()
    void refreshWorkspaces()
    void refreshCommands()
    // 首次启动时，onboarding 遮罩需要设置快照。
    void refreshSettings()
    void refreshWorkspaceInsights()
  }, [])

  useEffect(() => {
    if (appState?.workspace) void refreshWorkspaceInsights()
  }, [appState?.workspace])

  useEffect(() => {
    void refreshWorkspaceSessions()
  }, [])

  useEffect(() => {
    if (activeSessionId) void refreshWorkspaceSessions()
  }, [activeSessionId])

  useEffect(() => {
    const current = appState?.workspace ?? settings?.workspace
    if (!current) return
    setExpandedWorkspaces((prev) => (prev.has(current) ? prev : new Set(prev).add(current)))
  }, [appState?.workspace, settings?.workspace])

  // 当前窗口的执行状态上报给主进程，让其它窗口的目录树也能看到运行标记。
  useEffect(() => {
    const workspace = appState?.workspace ?? settings?.workspace
    if (!workspace) return
    window.xcode.reportRunningSessions(workspace, [...runningSessionIds])
  }, [runningSessionIds, appState?.workspace, settings?.workspace])

  useEffect(() => {
    return window.xcode.onRunningSessions((entries) => {
      const map: Record<string, string[]> = {}
      for (const entry of entries) map[entry.workspace] = entry.sessionIds
      setRunningOther(map)
    })
  }, [])

  useEffect(() => {
    const onOpenFile = (event: Event): void => {
      const path = (event as CustomEvent<string>).detail
      if (typeof path === 'string' && path.trim()) {
        setFileInitialPath(path)
        openInspector('file')
      }
    }
    window.addEventListener('xcode:open-file', onOpenFile)
    return () => window.removeEventListener('xcode:open-file', onOpenFile)
  }, [])

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem('xcode.zoom'))
      if (Number.isFinite(stored) && stored >= 0.7 && stored <= 1.6) {
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:set-zoom',
          params: { factor: stored },
        })
      }
    } catch {
      // 缩放只是外观偏好。
    }
  }, [])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => {
      setRecordingSeconds(Math.max(0, Math.floor((Date.now() - recordStartedAtRef.current) / 1000)))
    }, 250)
    return () => clearInterval(timer)
  }, [recording])

  useEffect(
    () => () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      void audioContextRef.current?.close().catch(() => undefined)
    },
    [],
  )

  const changeZoom = (delta: number, reset = false): void => {
    let current = 1
    try {
      const stored = Number(localStorage.getItem('xcode.zoom'))
      if (Number.isFinite(stored) && stored >= 0.7 && stored <= 1.6) current = stored
    } catch {
      // 默认为 1。
    }
    const next = reset ? 1 : Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 10) / 10))
    try {
      localStorage.setItem('xcode.zoom', String(next))
    } catch {
      // 本次会话仍然生效。
    }
    void window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:set-zoom',
      params: { factor: next },
    })
  }

  // 每个会话的草稿在切换会话和应用重启后仍然保留。
  useEffect(() => {
    skipDraftSaveRef.current = draftKey
    try {
      const raw = localStorage.getItem(draftKey)
      const parsed = raw ? (JSON.parse(raw) as { text?: unknown; attachments?: unknown }) : null
      setInput(typeof parsed?.text === 'string' ? parsed.text : '')
      setAttachments(
        Array.isArray(parsed?.attachments)
          ? parsed.attachments.filter((entry): entry is string => typeof entry === 'string')
          : [],
      )
    } catch {
      setInput('')
      setAttachments([])
    }
  }, [draftKey])

  useEffect(() => {
    if (skipDraftSaveRef.current === draftKey) {
      skipDraftSaveRef.current = null
      return
    }
    try {
      localStorage.setItem(draftKey, JSON.stringify({ text: input, attachments }))
    } catch {
      // 草稿是尽力而为。
    }
  }, [draftKey, input, attachments])

  useEffect(() => {
    const query = sessionQuery.trim()
    if (query.length < 2) {
      setSearchResults([])
      setSearchingSessions(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearchingSessions(true)
      void window.xcode
        .request({
          id: crypto.randomUUID(),
          method: 'session:search',
          params: { query, limit: 20 },
        })
        .then((response) => {
          if (cancelled) return
          setSearchingSessions(false)
          if (response.ok) {
            setSearchResults((response.result as { results: SessionSearchResult[] }).results)
          }
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionQuery])

  useEffect(() => {
    // 流式增量每秒到达多次；按会话合并成每帧一次渲染，避免长对话对每个
    // token 重新解析 Markdown。
    const flushPendingText = (): void => {
      if (streamFrameRef.current !== null) {
        cancelAnimationFrame(streamFrameRef.current)
        streamFrameRef.current = null
      }
      lastTextFlushRef.current = performance.now()
      if (pendingTextRef.current.size === 0) return
      const pending = [...pendingTextRef.current.entries()]
      pendingTextRef.current.clear()
      for (const [sessionId, item] of pending) {
        commitEntries(sessionId, (prev) =>
          prev.map((entry) => (entry.id === item.entryId ? { ...entry, text: entry.text + item.text } : entry)),
        )
      }
    }

    const scheduleTextFlush = (): void => {
      if (streamFrameRef.current !== null) return
      streamFrameRef.current = requestAnimationFrame(() => {
        streamFrameRef.current = null
        // 对一个不断增长的答案以 60fps 渲染 Markdown 大多是浪费；
        // ~30fps 让流保持流畅，同时不必每帧重新解析。
        if (performance.now() - lastTextFlushRef.current < 32 && pendingTextRef.current.size > 0) {
          scheduleTextFlush()
          return
        }
        flushPendingText()
      })
    }

    const off = window.xcode.onEvent((event: RuntimeEvent) => {
      const sessionId = sessionOf(event)
      const visible = isVisibleSession(sessionId)
      if (visible) {
        lastAgentEventAtRef.current = Date.now()
      }
      if (
        event.type !== 'agent:text-delta' &&
        event.type !== 'agent:usage' &&
        event.type !== 'agent:tool-progress' &&
        event.type !== 'agent:tool-input-progress' &&
        event.type !== 'agent:reasoning-progress'
      ) {
        flushPendingText()
      }
      switch (event.type) {
        case 'runtime:ready':
          setStatus('ready')
          appendTo(bufferKey(), {
            role: 'system',
            text: i18n.t('运行时已连接 · Node {{node}} · Electron {{electron}}', {
              node: event.versions.node ?? '?',
              electron: event.versions.electron ?? '?',
            }),
          })
          break
        case 'runtime:exit':
          setStatus('offline')
          appendTo(bufferKey(), {
            role: 'error',
            text: i18n.t('运行时已退出（code {{code}}）。下次发送消息时会自动重启。', { code: event.code }),
          })
          break
        case 'goal:update':
          // goal 属于会话；后台会话的目标不能覆盖当前可见会话的面板。
          if (visible) setGoal(event.goal)
          break
        case 'app:state':
          setAppState(event.state)
          break
        case 'approval:request':
          // 审批可能来自后台会话；始终弹出，避免并行会话卡死。
          setApprovals((prev) => (prev.some((item) => item.requestId === event.requestId) ? prev : [...prev, event]))
          if (visible) markTurnActivity('approval', event.toolName)
          break
        case 'agent:turn-start': {
          const onActive = activeSessionIdRef.current === null || activeSessionIdRef.current === sessionId
          // 先迁移临时缓冲，再取目标会话缓冲，避免丢掉用户刚发出的一条消息。
          if (onActive) adoptSession(sessionId)
          const buffer = bufferFor(sessionId)
          turnSessionRef.current.set(event.turnId, sessionId)
          markSessionRunning(sessionId, true)
          addTab(sessionId)
          buffer.activeTurnId = event.turnId
          buffer.textEntryId = null
          pendingTextRef.current.delete(sessionId)
          if (onActive) {
            busyRef.current = true
            setBusy(true)
            hostSessionIdRef.current = sessionId
            activeTextEntryId.current = null
            markTurnActivity('model')
            setActiveSessionId(sessionId)
          }
          setNotice(null)
          break
        }
        case 'agent:text-delta': {
          const buffer = bufferFor(sessionId)
          if (visible) markTurnActivity('streaming')
          const textEntryId = buffer.textEntryId
          if (!textEntryId) {
            const id = crypto.randomUUID()
            buffer.textEntryId = id
            if (visible) activeTextEntryId.current = id
            appendTo(sessionId, { id, role: 'assistant', text: event.delta, turnId: buffer.activeTurnId ?? undefined })
          } else {
            const pending = pendingTextRef.current.get(sessionId)
            pendingTextRef.current.set(sessionId, {
              entryId: textEntryId,
              text: (pending?.entryId === textEntryId ? pending.text : '') + event.delta,
            })
            if (streamFrameRef.current === null) scheduleTextFlush()
          }
          break
        }
        case 'agent:tool-call': {
          // toolSearch 是内部的延迟工具加载器；CLI 会隐藏它，桌面记录也应该隐藏。
          if (event.toolName === 'toolSearch') break
          const buffer = bufferFor(sessionId)
          if (visible) markTurnActivity('tool', event.toolName)
          // 工具之后的文本属于这张卡片之后，而不是工具运行前创建的那个更早的助手气泡。
          buffer.textEntryId = null
          if (visible) activeTextEntryId.current = null
          appendTo(sessionId, {
            id: event.toolCallId,
            role: 'tool',
            text: '',
            turnId: buffer.activeTurnId ?? undefined,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolInput: event.input,
            toolStatus: 'running',
            toolStartedAt: Date.now(),
          })
          break
        }
        case 'agent:reasoning-progress':
          if (visible) markTurnActivity('reasoning', `${event.chars.toLocaleString()} ${t('字符')}`)
          break
        case 'agent:tool-input-progress':
          if (visible) {
            markTurnActivity(
              'tool-input',
              `${event.toolName || t('工具')} · ${event.chars.toLocaleString()} ${t('字符')}`,
            )
          }
          break
        case 'agent:tool-progress':
          commitEntries(sessionId, (prev) =>
            prev.map((entry) =>
              entry.toolCallId === event.toolCallId ? { ...entry, toolProgress: event.message } : entry,
            ),
          )
          break
        case 'agent:tool-result':
          if (visible) markTurnActivity('model')
          commitEntries(sessionId, (prev) =>
            prev.map((entry) =>
              entry.toolCallId === event.toolCallId
                ? {
                    ...entry,
                    toolStatus: event.isError ? ('error' as const) : ('completed' as const),
                    toolOutput: event.result,
                    toolProgress: undefined,
                  }
                : entry,
            ),
          )
          break
        case 'agent:file-edit':
          commitEntries(sessionId, (prev) =>
            prev.map((entry) => (entry.toolCallId === event.toolCallId ? { ...entry, diff: event.payload } : entry)),
          )
          break
        case 'agent:background-task':
          if (event.phase === 'end') {
            appendTo(sessionId, {
              role: event.task.status === 'completed' ? 'system' : 'error',
              text: t('后台任务结束：{{agent}} — {{description}}（{{status}}）', {
                agent: event.task.agentName,
                description: event.task.description,
                status: event.task.status,
              }),
            })
          }
          break
        case 'agent:subagent':
          commitEntries(sessionId, (prev) =>
            prev.map((entry) => {
              if (entry.toolCallId !== event.toolCallId) return entry
              const current: SubAgentView = entry.subagent ?? {
                agentName: event.agentName ?? i18n.t('子代理'),
                description: event.description ?? '',
                status: 'running',
                log: [],
              }
              if (event.phase === 'start') {
                return {
                  ...entry,
                  subagent: {
                    ...current,
                    agentName: event.agentName ?? current.agentName,
                    description: event.description ?? current.description,
                    status: 'running',
                  },
                }
              }
              if (event.phase === 'text') {
                if (!event.text) return entry
                const log = [...current.log]
                const last = log[log.length - 1]
                if (last?.kind === 'text') log[log.length - 1] = { kind: 'text', text: last.text + event.text }
                else log.push({ kind: 'text', text: event.text })
                return { ...entry, subagent: { ...current, log } }
              }
              if (event.phase === 'tool') {
                return {
                  ...entry,
                  subagent: {
                    ...current,
                    log: [
                      ...current.log,
                      { kind: 'tool', text: `→ ${event.subToolName ?? 'tool'} ${event.text ?? ''}`.trim() },
                    ],
                  },
                }
              }
              if (event.phase === 'tool-result') {
                return {
                  ...entry,
                  subagent: {
                    ...current,
                    log: [
                      ...current.log,
                      {
                        kind: 'result',
                        text: `← ${event.subToolName ?? 'tool'}${event.isError ? i18n.t('（失败）') : ''} ${event.text ?? ''}`.trim(),
                      },
                    ],
                  },
                }
              }
              return {
                ...entry,
                subagent: {
                  ...current,
                  status: event.aborted ? 'aborted' : 'completed',
                  ...(event.text ? { finalText: event.text } : {}),
                  ...(event.turnCount !== undefined ? { turnCount: event.turnCount } : {}),
                  ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
                },
              }
            }),
          )
          break
        case 'agent:todos':
          setTodosFor(sessionId, event.todos)
          break
        case 'agent:usage':
          setUsageFor(sessionId, event.usage)
          break
        case 'agent:permission-mode':
          if (visible) setNotice(event.mode === 'plan' ? i18n.t('计划模式') : null)
          break
        case 'agent:context-compressed': {
          const buffer = bufferFor(sessionId)
          buffer.textEntryId = null
          if (visible) activeTextEntryId.current = null
          appendTo(sessionId, {
            role: 'system',
            text: i18n.t('上下文已压缩：{{summary}}', { summary: event.summary.slice(0, 160) }),
            turnId: buffer.activeTurnId ?? undefined,
          })
          if (visible) setNotice(null)
          break
        }
        case 'agent:compression-progress':
          if (visible) setNotice(event.description)
          break
        case 'agent:ingest-progress':
          if (visible) setNotice(event.description)
          break
        case 'agent:attachments':
          if (visible) {
            setNotice(
              i18n.t('附件已读取：{{files}} 个文件，{{chars}} 字符', {
                files: event.files.length,
                chars: event.textBytes,
              }),
            )
          }
          break
        case 'agent:stream-retry':
          if (visible) {
            markTurnActivity('retry', `${event.attempt}/${event.maxAttempts}`)
            setNotice(
              i18n.t('连接波动，重试 {{attempt}}/{{max}}…', {
                attempt: event.attempt,
                max: event.maxAttempts,
              }),
            )
          }
          break
        case 'agent:model-fallback': {
          const buffer = bufferFor(sessionId)
          appendTo(sessionId, {
            role: 'system',
            text: i18n.t('主模型不可用，已切换到 {{model}}', { model: event.toModelId }),
            turnId: buffer.activeTurnId ?? undefined,
          })
          if (visible) setNotice(null)
          break
        }
        case 'agent:turn-end': {
          const buffer = bufferFor(sessionId)
          commitEntries(sessionId, (prev) => {
            const next: Entry[] = prev.map((entry) =>
              entry.subagent?.status === 'running'
                ? {
                    ...entry,
                    subagent: { ...entry.subagent, status: event.reason === 'completed' ? 'completed' : 'aborted' },
                  }
                : entry,
            )
            // 有些模型在工具结果之后直接结束这一轮，界面上会像“无缘无故停了”。
            // 补一条说明，提示用户可以继续或重新生成。
            const last = next[next.length - 1]
            if (event.reason === 'completed' && last?.role === 'tool') {
              next.push({
                id: crypto.randomUUID(),
                role: 'system',
                text: i18n.t('工具已执行，但模型没有继续回复。可以继续提问，或重新生成。'),
                turnId: event.turnId,
              })
            }
            return next
          })
          buffer.activeTurnId = null
          buffer.textEntryId = null
          turnSessionRef.current.delete(event.turnId)
          markSessionRunning(sessionId, false)
          syncBusyFromRunning()
          if (visible) {
            activeTextEntryId.current = null
            setNotice(null)
            setQueued(queueRef.current.length)
            if (queueRef.current.length > 0) {
              const next = queueRef.current.shift()
              setQueued(queueRef.current.length)
              setQueuedItems([...queueRef.current])
              if (next) setTimeout(() => submitRef.current(next.prompt, true, next.attachments), 0)
            }
          }
          void refreshSessions()
          break
        }
        case 'agent:error': {
          if (visible) {
            const buffer = bufferFor(sessionId)
            buffer.textEntryId = null
            activeTextEntryId.current = null
            appendTo(sessionId, { role: 'error', text: event.message, turnId: buffer.activeTurnId ?? undefined })
          }
          markSessionRunning(sessionId, false)
          syncBusyFromRunning()
          break
        }
        case 'session:saved':
          setSessions((prev) => [event.item, ...prev.filter((item) => item.sessionId !== event.item.sessionId)])
          if (activeSessionIdRef.current === null) setActiveSessionId(event.item.sessionId)
          setTabTitles((prev) => {
            const title = (event.item.name || event.item.title || event.item.firstPrompt || '').trim()
            return title ? { ...prev, [event.item.sessionId]: title.slice(0, 80) } : prev
          })
          emptyTabsRef.current.delete(event.item.sessionId)
          if (pendingSessionRef.current === event.item.sessionId) {
            pendingSessionRef.current = null
            setPendingSession(null)
          }
          break
        case 'session:title':
          setSessions((prev) =>
            prev.map((item) => (item.sessionId === event.sessionId ? { ...item, title: event.title } : item)),
          )
          setTabTitles((prev) => ({ ...prev, [event.sessionId]: event.title }))
          break
        case 'checks:finished': {
          setCheckResults(event.results)
          const failed = event.results.filter(
            (result) => result.status === 'failed' || result.status === 'timeout',
          ).length
          if (event.auto) {
            appendTo(bufferKey(), {
              role: 'system',
              text:
                failed > 0 ? i18n.t('自动项目检查失败：{{count}} 项', { count: failed }) : i18n.t('自动项目检查通过'),
            })
            setNotice(failed > 0 ? i18n.t('自动项目检查失败，可在“检查”面板查看') : i18n.t('自动项目检查通过'))
          }
          break
        }
        case 'checks:auto-fix': {
          const text =
            event.status === 'started'
              ? i18n.t('自动修复：第 {{round}}/{{max}} 轮', { round: event.round, max: event.maxRounds })
              : event.status === 'passed'
                ? i18n.t('自动修复后项目检查通过')
                : event.status === 'exhausted'
                  ? i18n.t('自动修复已用尽 {{max}} 轮，项目检查仍未通过', { max: event.maxRounds })
                  : i18n.t('自动修复中止：{{message}}', { message: event.message ?? '' })
          appendTo(bufferKey(), {
            role: event.status === 'failed' || event.status === 'exhausted' ? 'error' : 'system',
            text,
          })
          setNotice(text)
          break
        }
        case 'settings:changed':
          setSettings(event.settings)
          break
        case 'app:settings-changed':
          // 另一个窗口修改了共享偏好。合并突发变更，然后
          // 重新加载本窗口的运行时，使密钥/工具/插件保持同步。
          if (settingsSyncTimerRef.current) clearTimeout(settingsSyncTimerRef.current)
          settingsSyncTimerRef.current = setTimeout(() => {
            settingsSyncTimerRef.current = null
            void (async () => {
              const response = await window.xcode.request({
                id: crypto.randomUUID(),
                method: 'settings:reload',
                params: {},
              })
              if (!response.ok) return
              const result = response.result as SettingsActionResult
              setAppState(result.state)
              setSettings(result.settings)
              void refreshCommands()
            })().catch(() => undefined)
          }, 200)
          break
        case 'commands:changed':
          void refreshCommands()
          break
        case 'audio:progress':
          setNotice(event.message)
          break
        case 'app:open-session':
          void openSessionById(event.sessionId)
          break
        case 'app:new-session':
          void newSession()
          break
        case 'smoke:result':
          setReport(JSON.stringify(event.report, null, 2))
          break
        default:
          break
      }
    })
    return () => {
      off()
      if (streamFrameRef.current !== null) {
        cancelAnimationFrame(streamFrameRef.current)
        streamFrameRef.current = null
      }
      pendingTextRef.current.clear()
      if (settingsSyncTimerRef.current) {
        clearTimeout(settingsSyncTimerRef.current)
        settingsSyncTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_WORKSPACES_KEY, JSON.stringify([...expandedWorkspaces]))
    } catch {
      // 忽略存储异常。
    }
  }, [expandedWorkspaces])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // 忽略存储异常。
    }
  }, [sidebarWidth])

  useEffect(() => {
    const previous = seenEntryCountRef.current
    seenEntryCountRef.current = entries.length
    if (nearBottomRef.current) {
      setUnseenEntries((count) => (count === 0 ? count : 0))
      return
    }
    if (entries.length > previous) setUnseenEntries((count) => count + (entries.length - previous))
  }, [entries])

  // 键盘或点击切到被滚出视野的标签后，把激活标签带回可见区域。
  useEffect(() => {
    document
      .querySelector<HTMLElement>('[data-testid="session-tab"].active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeSessionId])

  useEffect(() => {
    if (!nearBottomRef.current) return
    // 推迟到下一帧，让流式 markdown/code 先完成布局再固定记录；
    // 在提交中途写 scrollTop 会导致代码生成时用户可见的跳动。
    const frame = requestAnimationFrame(() => {
      const node = scrollRef.current
      if (node && nearBottomRef.current) node.scrollTop = node.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [entries])

  // 切换标签时必须回到新会话的底部。浏览器会保留上一个会话的 scrollTop，
  // 当新会话内容更短时就会停在中间。重置跟随状态，并在布局完成后滚到底；
  // 双帧是为了等 Markdown / 代码块替换完高度。
  useEffect(() => {
    nearBottomRef.current = true
    setShowScrollBottom(false)
    setUnseenEntries(0)
    seenEntryCountRef.current = 0
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [activeSessionId])

  const handleChatScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    nearBottomRef.current = near
    setShowScrollBottom(!near)
    if (near) setUnseenEntries(0)
  }

  const jumpToEntry = (entryId: string): void => {
    // 停止自动跟随流，否则下一次增量会在跳转后立即弹回底部。
    nearBottomRef.current = false
    setShowScrollBottom(true)
    requestAnimationFrame(() => {
      document.getElementById(`entry-${entryId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  useEffect(() => {
    if (promptAutoSubmitRef.current) return
    const params = new URLSearchParams(window.location.search)
    const prompt = params.get('prompt')
    if (!prompt) return
    const displayPrompt = params.get('displayPrompt') ?? undefined
    const requestedSession = params.get('session')
    if (requestedSession && !sessions.some((session) => session.filePath === requestedSession)) return
    const timer = setTimeout(() => {
      promptAutoSubmitRef.current = true
      submitRef.current(prompt, false, [], displayPrompt)
    }, 600)
    return () => clearTimeout(timer)
  }, [sessions])

  useEffect(() => {
    if (!wantsSlashDemo) return
    const timer = setTimeout(() => setInput('/'), 800)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!terminalOpen && !settingsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isImeEvent(event)) return
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (terminalOpen) closeInspector()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [terminalOpen, settingsOpen])

  useEffect(() => {
    if (!approval) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isImeEvent(event)) return
      if (event.key === 'Escape') {
        void respondApproval(approval, approval.kind === 'question' ? '' : 'no')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [approval])

  // 回复运行期间每秒刷新一次，让耗时和“无新输出”提示持续走动。
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setTurnNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    if (todos.length > 0) {
      todosShownRef.current = todos
      setShownTodos(todos)
      setTodosLeaving(false)
      return
    }
    if (todosShownRef.current.length === 0) return
    setTodosLeaving(true)
    const timer = setTimeout(() => {
      todosShownRef.current = []
      setShownTodos([])
      setTodosLeaving(false)
    }, 1_200)
    return () => clearTimeout(timer)
  }, [todos])

  // 切换显示模式等同于重置默认值：之前手动展开/收起的轮次重新按模式摆放。
  useEffect(() => {
    setTurnToolOverrides(new Map())
  }, [toolDisplayMode])

  const changeToolDisplayMode = (mode: ToolDisplayMode): void => {
    setToolDisplayMode(mode)
    try {
      localStorage.setItem('xcode.toolDisplay', mode)
    } catch {
      // 本地偏好保存失败不影响本次使用。
    }
  }

  useEffect(() => {
    if (!isUiSmoke || uiSmokeRan.current) return
    uiSmokeRan.current = true
    void runUiSmoke({ setInput, setAttachments, openDocument, closeInspector, activeSessionId })
  }, [])

  useEffect(() => {
    if (!busy) return
    // 会话文件在轮次仍在运行时就会刷新（尤其是长时间工具退到
    // 后台时），所以在轮次进行中刷新侧栏，而不是等 turn-end。
    const timer = setInterval(() => {
      void refreshSessions()
    }, 3_000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    let cancelled = false
    const refreshBackgroundCount = async (): Promise<void> => {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'background:list',
        params: {},
      })
      if (cancelled || !response.ok) return
      const result = response.result as {
        sessions: Array<{ shellId?: string; status?: string }>
        tasks?: Array<{ id?: string; status?: string }>
      }
      const localIds = new Set<string>()
      let active = 0
      for (const session of result.sessions) {
        if (session.shellId) localIds.add(session.shellId)
        if (['starting', 'running', 'terminating', 'finalizing'].includes(session.status ?? '')) active += 1
      }
      for (const task of result.tasks ?? []) {
        if (task.id) localIds.add(task.id)
        if (task.status === 'running') active += 1
      }
      const sharedResponse = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'background:shared',
        params: {},
      })
      if (sharedResponse.ok) {
        const items = (sharedResponse.result as { items?: Array<{ id?: string; status?: string }> }).items ?? []
        for (const item of items) {
          if (item.id && localIds.has(item.id)) continue
          if (item.status === 'running') active += 1
        }
      }
      if (!cancelled) setBackgroundActive(active)
    }
    void refreshBackgroundCount()
    const timer = setInterval(() => void refreshBackgroundCount(), 3_000)
    const off = window.xcode.onEvent((event) => {
      if (event.type === 'background:changed') void refreshBackgroundCount()
    })
    return () => {
      cancelled = true
      clearInterval(timer)
      off()
    }
  }, [])

  const submit = async (
    promptText: string,
    alreadyShown = false,
    files: string[] = attachments,
    displayText?: string,
  ): Promise<void> => {
    const prompt = promptText.trim() || (files.length > 0 ? t('请阅读并分析这些附件。') : '')
    if (!prompt) return
    const display = displayText?.trim() || prompt
    if (!alreadyShown && !busyRef.current && !workspaceGuardOff && !workspaceGuardBypassRef.current) {
      const external = detectExternalWorkspacePaths(prompt, appState?.workspace ?? settings?.workspace ?? '')
      if (external.length > 0) {
        setWorkspaceGuard({ prompt, files, external })
        setInput(prompt)
        setAttachments(files)
        return
      }
    }
    workspaceGuardBypassRef.current = false
    if (activeSessionId) {
      // 立即给全新标签页一个有用的标题，而不是等会话文件被列出
      // （后者可能落后于一个长轮次）。
      setTabTitles((prev) =>
        prev[activeSessionId] ? prev : { ...prev, [activeSessionId]: display.replace(/\s+/g, ' ').slice(0, 80) },
      )
    }
    // 之前浏览了别的标签：发送前把主机活动 runtime 切回当前会话。
    if (!alreadyShown && activeSessionIdRef.current && hostSessionIdRef.current !== activeSessionIdRef.current) {
      const sid = activeSessionIdRef.current
      const activation = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:activate',
        params: { sessionId: sid },
      })
      const activated = activation.ok && (activation.result as { activated: boolean }).activated === true
      if (!activated) {
        const target = sessions.find((session) => session.sessionId === sid)
        if (!target) {
          setReport(t('该标签还没有可发送的会话，请新建会话。'))
          return
        }
        const loaded = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:load',
          params: { filePath: target.filePath },
        })
        if (!loaded.ok) {
          setReport(t('恢复会话失败：{{message}}', { message: loaded.error.message }))
          return
        }
      }
      hostSessionIdRef.current = sid
    }
    if (editArmed && !alreadyShown && !busyRef.current) {
      const rewound = await rewindConversation()
      setEditArmed(false)
      if (!rewound) return
    }
    setReport(null)
    if (!alreadyShown) {
      append({ role: 'user', text: display, attachments: files, at: Date.now() })
    }
    if (busyRef.current) {
      queueRef.current.push({ prompt, attachments: files })
      setQueued(queueRef.current.length)
      setQueuedItems([...queueRef.current])
      setAttachments([])
      return
    }
    busyRef.current = true
    setBusy(true)
    setAttachments([])
    setMention(null)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt, attachments: files },
    })
    if (!response.ok) {
      append({ role: 'error', text: `${response.error.code}: ${response.error.message}` })
      busyRef.current = false
      setBusy(false)
    }
  }
  submitRef.current = (prompt, alreadyShown, files, displayText) =>
    void submit(prompt, alreadyShown, files, displayText)

  const continueInCurrentWorkspace = (): void => {
    const guard = workspaceGuard
    if (!guard) return
    setWorkspaceGuard(null)
    workspaceGuardBypassRef.current = true
    setInput('')
    setAttachments([])
    void submit(guard.prompt, false, guard.files)
  }

  const cancelWorkspaceGuard = (): void => {
    setWorkspaceGuard(null)
  }

  const abort = async (sessionId?: string): Promise<void> => {
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:abort',
      params: sessionId ? { sessionId } : {},
    })
  }

  const runDiagnostics = async (): Promise<void> => {
    setReport(t('正在诊断…'))
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'smoke:run',
      params: {},
    })
    setReport(JSON.stringify(response.ok ? (response.result as SmokeReport) : response.error, null, 2))
  }

  const chooseTaskMode = async (mode: TaskMode): Promise<void> => {
    setTaskModeMenuOpen(false)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-task-mode',
      params: { mode },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setAppState(response.result as AppState)
  }

  const chooseModel = async (model: ModelOption): Promise<void> => {
    setModelMenuOpen(false)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'models:set',
      params: { modelId: model.id },
    })
    if (response.ok) {
      setAppState(response.result as AppState)
    }
  }

  const scanLocalModels = async (): Promise<void> => {
    setModelScan(t('扫描中…'))
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'models:discover',
      params: {},
    })
    if (!response.ok) {
      setModelScan(t('扫描失败：{{message}}', { message: response.error.message }))
      return
    }
    const state = response.result as AppState
    setAppState(state)
    const count = state.models.filter(
      (model) => model.id.startsWith('ollama:') || model.id.startsWith('lmstudio:'),
    ).length
    setModelScan(
      count > 0
        ? t('发现 {{count}} 个本地模型', { count })
        : t('未检测到本地模型（请确认 Ollama 或 LM Studio 已启动）'),
    )
  }

  const activateCustomModel = async (): Promise<void> => {
    const modelId = customModelInput.trim()
    if (!modelId) return
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'models:set',
      params: { modelId },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setAppState(response.result as AppState)
    setModelMenuOpen(false)
    setCustomModelInput('')
    setReport(t('已切换到 {{model}}', { model: modelId }))
  }

  const openSidebar = async (): Promise<void> => {
    setModelMenuOpen(false)
    setSettingsOpen(false)
    setSidebarOpen(true)
    await Promise.all([refreshSessions(), refreshWorkspaces()])
  }

  const toggleSidebar = async (): Promise<void> => {
    if (!sidebarOpen) {
      await openSidebar()
      return
    }
    setSidebarOpen(false)
  }

  const openWorkspaceWindow = async (workspacePath: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: { workspacePath },
    })
    if (!response.ok) {
      setNotice(t('打开新窗口失败：{{message}}', { message: response.error.message }))
      return
    }
    const outcome = response.result as { created: boolean; focused: boolean }
    setNotice(outcome.focused ? t('该工作区已在另一个窗口打开') : t('已在新窗口打开该工作区'))
    setTimeout(() => setNotice(null), 2_400)
  }

  const newWorkspaceSession = async (workspacePath: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: { workspacePath, newSession: true },
    })
    if (!response.ok) {
      setNotice(t('在该工作区新建会话失败：{{message}}', { message: response.error.message }))
      return
    }
    const outcome = response.result as { created: boolean; focused: boolean }
    setNotice(outcome.created ? t('已在新窗口为该工作区新建会话') : t('已在已打开的工作区窗口中新建会话'))
    setTimeout(() => setNotice(null), 2_400)
  }

  const openWorkspaceSession = async (workspacePath: string, filePath: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: { workspacePath, sessionFilePath: filePath },
    })
    if (!response.ok) {
      setNotice(t('打开会话失败：{{message}}', { message: response.error.message }))
      return
    }
    setNotice(t('已在新窗口打开该会话'))
    setTimeout(() => setNotice(null), 2_400)
  }

  const toggleWorkspace = (workspacePath: string): void => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(workspacePath)) next.delete(workspacePath)
      else next.add(workspacePath)
      return next
    })
  }

  const startSidebarResize = (event: { clientX: number; preventDefault: () => void }): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    const onMove = (move: PointerEvent): void => {
      setSidebarWidth(
        Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(startWidth + move.clientX - startX))),
      )
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const switchProject = async (nextPath: string): Promise<void> => {
    if (switchingProject) return
    if (nextPath === (appState?.workspace ?? settings?.workspace)) return
    // 本窗口还有回复在跑时不能原地换工作区：那样会拆掉正在用的 loopState
    // 和后台任务。改为在新窗口打开目标工作区，两边各自跑，互不打断。
    if (busyRef.current || runningSessionIdsRef.current.size > 0) {
      setSwitchingProject(nextPath)
      try {
        const opened = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:new-window',
          params: { workspacePath: nextPath },
        })
        if (!opened.ok) {
          setNotice(t('打开新窗口失败：{{message}}', { message: opened.error.message }))
          return
        }
        const outcome = opened.result as { created: boolean; focused: boolean }
        setNotice(
          outcome.focused
            ? t('该工作区已在另一个窗口打开，本窗口继续运行')
            : t('本窗口继续运行，目标工作区已在新窗口打开'),
        )
        setTimeout(() => setNotice(null), 2_400)
        void refreshWorkspaces()
      } catch (error) {
        setNotice(t('打开新窗口失败：{{message}}', { message: String(error) }))
      } finally {
        setSwitchingProject(null)
      }
      return
    }
    setSwitchingProject(nextPath)
    setNotice(t('正在切换工作区…'))
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'workspace:switch',
        params: { path: nextPath },
      })
      if (!response.ok) {
        append({ role: 'error', text: t('切换项目失败：{{message}}', { message: response.error.message }) })
        setNotice(null)
        return
      }
      const result = response.result as SettingsActionResult
      setAppState(result.state)
      setSettings(result.settings)
      sessionBuffersRef.current.clear()
      runningSessionIdsRef.current = new Set()
      setRunningSessionIds(new Set())
      setEntries([])
      setTodos([])
      setUsage(null)
      setBusy(false)
      busyRef.current = false
      setReport(null)
      setQueued(0)
      queueRef.current = []
      setQueuedItems([])
      setAttachments([])
      setActiveSessionId(null)
      setTabs([])
      setSessions([])
      emptyTabsRef.current.clear()
      pendingSessionRef.current = null
      setPendingSession(null)
      setSessionQuery('')
      setRenaming(null)
      setDeletingSession(null)
      closeInspector()
      setNotice(t('工作区已切换'))
      setTimeout(() => setNotice(null), 1_600)
      // 会话列表和最近工作区可以稍后刷新；切换本身已经完成，先把界面交还用户。
      void Promise.all([refreshSessions(), refreshWorkspaces()])
    } catch (error) {
      append({ role: 'error', text: t('切换项目失败：{{message}}', { message: String(error) }) })
      setNotice(null)
    } finally {
      setSwitchingProject(null)
    }
  }

  const pickProject = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:pick-path',
      params: { kind: 'project' },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    const selected = (response.result as { path: string | null }).path
    if (selected) await switchProject(selected)
  }

  const pickDocument = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:pick-path',
      params: { kind: 'document' },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    const result = response.result as { path: string | null; paths?: string[] }
    const selected = result.paths ?? (result.path ? [result.path] : [])
    if (selected.length === 0) return
    setAttachments((current) => [...new Set([...current, ...selected])])
    markUsage('attach')
  }

  const refreshDocumentList = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:list',
      params: {},
    })
    if (response.ok) setDocumentRecent((response.result as { documents: DocumentRecentItem[] }).documents)
  }

  const applyDocumentView = (view: DocumentView): void => {
    documentViewsRef.current[view.path] = view
    setDocumentView(view)
  }

  const openDocument = async (filePath: string, page?: number): Promise<void> => {
    markUsage('document')
    openInspector('document')
    setDocumentLoading(true)
    setDocumentError(null)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:open',
      params: { path: filePath },
    })
    setDocumentLoading(false)
    if (!response.ok) {
      setDocumentView(null)
      setDocumentError(response.error.message)
      forgetLastDocument(appState?.workspace ?? settings?.workspace ?? '', filePath)
      return
    }
    let view = response.result as DocumentView
    // 引用可能指向第一批之后；滚动前持续加载批次直到该页
    // 渲染出来（有上限）。
    if (page && view.totalPages) {
      let attempts = 0
      while (view.hasMore && (view.pages?.at(-1)?.page ?? 0) < page && attempts < 5) {
        const start = (view.pages?.at(-1)?.page ?? 0) + 1
        const more = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'document:pages',
          params: { path: view.path, start, count: 20 },
        })
        if (!more.ok) break
        const result = more.result as { pages: DocumentPageView[]; hasMore: boolean }
        view = { ...view, pages: [...(view.pages ?? []), ...result.pages], hasMore: result.hasMore }
        attempts++
      }
    }
    setDocumentFocusPage(page ?? null)
    applyDocumentView(view)
    rememberLastDocument(appState?.workspace ?? settings?.workspace ?? '', view.path)
    void refreshDocumentList()
  }

  const ocrDocumentPage = async (page: number): Promise<string> => {
    if (!documentView) return ''
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:ocr-page',
      params: { path: documentView.path, page },
    })
    if (!response.ok) {
      setDocumentError(response.error.message)
      return ''
    }
    const { text } = response.result as { text: string }
    if (documentView?.pages) {
      applyDocumentView({
        ...documentView,
        pages: documentView.pages.map((entry) =>
          entry.page === page ? { ...entry, text, ocr: entry.text === '' || entry.ocr === true } : entry,
        ),
        ocrPages: [...new Set([...(documentView.ocrPages ?? []), page])].sort((a, b) => a - b),
      })
    }
    return text
  }

  const switchDocument = async (filePath: string): Promise<void> => {
    const cached = documentViewsRef.current[filePath]
    if (cached) {
      setDocumentView(cached)
      openInspector('document')
      return
    }
    await openDocument(filePath)
  }

  const loadMoreDocumentPages = async (): Promise<void> => {
    if (!documentView?.hasMore || documentLoadingMore) return
    setDocumentLoadingMore(true)
    const start = (documentView.pages?.at(-1)?.page ?? 0) + 1
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:pages',
      params: { path: documentView.path, start, count: 20 },
    })
    setDocumentLoadingMore(false)
    if (!response.ok) {
      setDocumentError(response.error.message)
      return
    }
    const result = response.result as { pages: DocumentPageView[]; hasMore: boolean }
    applyDocumentView({
      ...documentView,
      pages: [...(documentView.pages ?? []), ...result.pages],
      hasMore: result.hasMore,
    })
  }

  const forgetDocumentOcr = async (): Promise<void> => {
    if (!documentView) return
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:forget-ocr',
      params: { path: documentView.path },
    })
    if (!response.ok) {
      setDocumentError(response.error.message)
      return
    }
    const cleared = new Set(documentView.ocrPages ?? [])
    applyDocumentView({
      ...documentView,
      pages: (documentView.pages ?? []).map((page) =>
        page.ocr || cleared.has(page.page) ? { ...page, text: '', ocr: false } : page,
      ),
      ocrPages: [],
    })
  }

  const fetchDocumentDiff = async (): Promise<DocumentDiffView | null> => {
    if (!documentView) return null
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:diff',
      params: { path: documentView.path },
    })
    if (!response.ok) {
      setDocumentError(response.error.message)
      return null
    }
    return (response.result as { diff: DocumentDiffView | null }).diff
  }

  const applyReviewedHunks = async (accepted: number[], hash: string): Promise<boolean> => {
    if (!documentView) return false
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:apply-hunks',
      params: { path: documentView.path, accepted, hash },
    })
    if (!response.ok) {
      setDocumentError(response.error.message)
      return false
    }
    setDocumentError(null)
    await openDocument(documentView.path)
    return true
  }

  const saveDocumentBaseline = async (): Promise<void> => {
    if (!documentView) return
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'document:save-baseline',
      params: { path: documentView.path },
    })
    if (!response.ok) {
      setDocumentError(response.error.message)
      return
    }
    setDocumentError(null)
    await openDocument(documentView.path)
  }

  const refreshChecks = async (): Promise<void> => {
    setChecksLoading(true)
    const [detectResponse, statusResponse] = await Promise.all([
      window.xcode.request({ id: crypto.randomUUID(), method: 'checks:detect', params: {} }),
      window.xcode.request({ id: crypto.randomUUID(), method: 'checks:status', params: {} }),
    ])
    setChecksLoading(false)
    if (!detectResponse.ok) {
      setChecksError(detectResponse.error.message)
      return
    }
    setChecksError(null)
    setProjectChecks((detectResponse.result as { checks: ProjectCheckView[] }).checks)
    if (statusResponse.ok) {
      const status = statusResponse.result as {
        autoChecks: boolean
        autoFixChecks: boolean
        lastResults?: ProjectCheckResultView[]
      }
      setCheckAuto(status.autoChecks)
      setCheckAutoFix(status.autoFixChecks)
      if (status.lastResults) setCheckResults(status.lastResults)
    }
  }

  const openChecksPanel = async (): Promise<void> => {
    openInspector('checks')
    setSettingsOpen(false)
    await refreshChecks()
  }

  const runChecksNow = async (): Promise<void> => {
    setChecksLoading(true)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'checks:run',
      params: { stopOnFailure: true },
    })
    setChecksLoading(false)
    if (!response.ok) {
      setChecksError(response.error.message)
      return
    }
    setChecksError(null)
    setCheckResults((response.result as { results: ProjectCheckResultView[] }).results)
  }

  const toggleAutoChecks = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'checks:set-auto',
      params: { enabled: !checkAuto },
    })
    if (!response.ok) {
      setChecksError(response.error.message)
      return
    }
    setCheckAuto((response.result as { enabled: boolean }).enabled)
    if (!(response.result as { enabled: boolean }).enabled) setCheckAutoFix(false)
  }

  const toggleAutoFixChecks = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'checks:set-auto-fix',
      params: { enabled: !checkAutoFix },
    })
    if (!response.ok) {
      setChecksError(response.error.message)
      return
    }
    setCheckAutoFix((response.result as { enabled: boolean }).enabled)
  }

  const fixFromChecks = (): void => {
    const failures = checkResults.filter((result) => result.status === 'failed' || result.status === 'timeout')
    if (failures.length === 0) return
    const detail = failures
      .map(
        (result) =>
          `### ${result.label} — ${result.commandLine} (${result.status})\n\n\`\`\`\n${result.output.slice(-4000)}\n\`\`\``,
      )
      .join('\n\n')
    void submit(`${t('项目检查未通过，请修复以下问题：')}\n\n${detail}`)
    closeInspector()
  }

  const refreshGit = async (): Promise<void> => {
    setGitLoading(true)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'git:status',
        params: {},
      })
      if (!response.ok) {
        setGitError(response.error.message)
        return
      }
      setGitError(null)
      setGitStatusView(response.result as GitStatusView)
    } catch (error) {
      // 传输层失败也要结束“加载中”，否则面板会永远停在加载状态。
      setGitError(error instanceof Error ? error.message : String(error))
    } finally {
      setGitLoading(false)
    }
  }

  // 点击 Inspector 的 Git 标签不会经过 openGitPanel，这里统一兜底加载。
  useEffect(() => {
    if (inspectorTab !== 'git') return
    void refreshGit()
  }, [inspectorTab])

  const openGitPanel = async (): Promise<void> => {
    setSettingsOpen(false)
    openInspector('git')
  }

  const selectGitFile = async (filePath: string, staged: boolean): Promise<void> => {
    setGitSelected({ path: filePath, staged })
    setGitDiffText(null)
    setGitDiffTruncated(false)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'git:diff',
      params: { path: filePath, staged },
    })
    if (!response.ok) {
      setGitError(response.error.message)
      return
    }
    const result = response.result as { diff: string; truncated: boolean }
    setGitDiffText(result.diff)
    setGitDiffTruncated(result.truncated)
  }

  // 用户可见的“回退本轮”统一走 RewindPanel；Git 面板直接预选“仅代码”。
  const openRewind = (mode: RewindMode = 'both'): void => {
    setRewindInitialMode(mode)
    setRewindOpen(true)
  }

  useEffect(() => {
    if (!rewindOpen) setRewindInitialMode('both')
  }, [rewindOpen])

  const openDocumentPanel = async (): Promise<void> => {
    markUsage('document')
    if (documentView) {
      openInspector('document')
      void refreshDocumentList()
      return
    }
    const workspace = appState?.workspace ?? settings?.workspace ?? ''
    const last = readLastDocument(workspace)
    if (last) {
      await openDocument(last)
      return
    }
    // 这个工作区没有之前的文档：在面板里显示最近列表，
    // 而不是强制弹出文件对话框。
    openInspector('document')
    await refreshDocumentList()
  }

  const pickDocumentToPreview = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:pick-path',
      params: { kind: 'document' },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    const selected = (response.result as { path: string | null }).path
    if (selected) await openDocument(selected)
  }

  const openSettings = async (tab?: string): Promise<void> => {
    setModelMenuOpen(false)
    setTaskModeMenuOpen(false)
    setToolsMenuOpen(false)
    closeInspector()
    setSettingsTab(tab ?? null)
    setSettingsOpen(true)
    await refreshSettings()
  }

  const allowSandboxNetwork = async (): Promise<void> => {
    // 运行时在轮次之间应用沙箱变更；打开设置比在回复仍在运行时
    // 报告「仅空闲时可用」的错误更清晰。
    if (busy) {
      await openSettings('tools')
      return
    }
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-shell-sandbox',
      params: { allowNetwork: true },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    const result = response.result as { settings?: SettingsSnapshot }
    if (result.settings) setSettings(result.settings)
  }

  const refreshAgentEnvironment = async (): Promise<void> => {
    if (busy) {
      await openSettings('skills')
      return
    }
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:refresh-environment',
      params: {},
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    const result = response.result as {
      settings?: SettingsSnapshot
      environment?: { refreshed: boolean; shell: string; error?: string }
    }
    if (result.settings) setSettings(result.settings)
    const environment = result.environment
    append({
      role: 'system',
      text: environment?.refreshed
        ? t('已刷新 {{shell}} 环境，重新运行命令即可。', { shell: environment.shell })
        : t('刷新环境失败：{{error}}', { error: environment?.error ?? t('未知错误') }),
    })
  }

  const moveTempDeliverables = async (entryId: string, paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    setMovingTempEntry(entryId)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'workspace:move-temp-files',
        params: { paths },
      })
      if (!response.ok) {
        append({ role: 'error', text: response.error.message })
        return
      }
      const result = response.result as TempDeliverableMoveResult
      if (result.moved.length > 0) {
        commitEntries(bufferKey(), (prev) =>
          prev.map((entry) => {
            if (entry.id !== entryId) return entry
            let output = entry.toolOutput
            for (const item of result.moved) output = output?.split(item.from).join(item.to)
            return {
              ...entry,
              toolOutput: output,
              movedDeliverables: [...(entry.movedDeliverables ?? []), ...result.moved.map((item) => item.to)],
            }
          }),
        )
        append({
          role: 'system',
          text: t('已移动到工作区：\n{{paths}}', { paths: result.moved.map((item) => item.to).join('\n') }),
        })
      }
      for (const failure of result.errors) {
        append({
          role: 'error',
          text: t('移动失败：{{path}} — {{error}}', { path: failure.path, error: failure.error }),
        })
      }
    } finally {
      setMovingTempEntry(null)
    }
  }

  const loadSession = async (item: SessionListItem): Promise<void> => {
    setSessionLoading(true)
    try {
      // 运行中的会话不读盘：切回它在主机里的 runtime 和实时缓冲。
      if (runningSessionIdsRef.current.has(item.sessionId)) {
        const activation = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:activate',
          params: { sessionId: item.sessionId },
        })
        if (activation.ok && (activation.result as { activated: boolean }).activated) {
          hostSessionIdRef.current = item.sessionId
          emptyTabsRef.current.delete(item.sessionId)
          addTab(item.sessionId)
          showSessionBuffer(item.sessionId)
          return
        }
      }
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:load',
        params: { filePath: item.filePath },
      })
      if (!response.ok) {
        if (response.error.message.includes('完整性')) {
          setSalvageTarget(item)
          return
        }
        append({ role: 'error', text: t('恢复会话失败：{{message}}', { message: response.error.message }) })
        return
      }
      const view = response.result as {
        sessionId: string
        modelId: string
        messages: Entry[]
        usage: UsageView
      }
      hostSessionIdRef.current = view.sessionId
      emptyTabsRef.current.delete(item.sessionId)
      addTab(item.sessionId)
      activeSessionIdRef.current = item.sessionId
      replaceEntries(
        item.sessionId,
        view.messages.map((message) => ({ ...message })),
      )
      setUsageFor(item.sessionId, view.usage)
      setTodosFor(item.sessionId, [])
      setActiveSessionId(item.sessionId)
      setQueued(0)
      queueRef.current = []
      setQueuedItems([])
      setAttachments([])
      pendingSessionRef.current = null
      setPendingSession(null)
      busyRef.current = false
      setBusy(false)
      clearTurnActivity()
      try {
        localStorage.setItem('xcode.lastSession', item.filePath)
      } catch {
        // 恢复上次会话是尽力而为。
      }
      await refreshState()
    } finally {
      setSessionLoading(false)
    }
  }

  useEffect(() => {
    if (restoredWindowSessionRef.current || sessions.length === 0) return
    const requested = new URLSearchParams(window.location.search).get('session')
    if (!requested) return
    restoredWindowSessionRef.current = true
    const item = sessions.find((session) => session.filePath === requested)
    if (item) void loadSession(item)
  }, [sessions, loadSession])

  useEffect(() => {
    if (restoredSessionRef.current || activeSessionId || sessions.length === 0) return
    // 次窗口从它请求的会话（或空）开始，而不是
    // 上一个窗口的最后会话。
    const windowParams = new URLSearchParams(window.location.search)
    if (windowParams.get('session') || windowParams.get('fresh')) return

    // 先恢复上次的标签组（仅限同一工作区），再回退到 lastSession。
    let savedTabs: { workspace?: unknown; tabs?: unknown; active?: unknown } | null = null
    try {
      const raw = localStorage.getItem('xcode.tabs')
      if (raw) savedTabs = JSON.parse(raw) as { workspace?: unknown; tabs?: unknown; active?: unknown }
    } catch {
      savedTabs = null
    }
    if (savedTabs && savedTabs.workspace === appState?.workspace && Array.isArray(savedTabs.tabs)) {
      const known = new Set(sessions.map((session) => session.sessionId))
      const restoredTabs = savedTabs.tabs.filter((id): id is string => typeof id === 'string' && known.has(id))
      if (restoredTabs.length > 0) {
        restoredSessionRef.current = true
        setTabs(restoredTabs)
        const active =
          typeof savedTabs.active === 'string' && restoredTabs.includes(savedTabs.active)
            ? savedTabs.active
            : restoredTabs[0]!
        const item = sessions.find((session) => session.sessionId === active)
        if (item) void loadSession(item)
        return
      }
    }

    let lastPath: string | null = null
    try {
      lastPath = localStorage.getItem('xcode.lastSession')
    } catch {
      lastPath = null
    }
    if (!lastPath) return
    const item = sessions.find((session) => session.filePath === lastPath)
    if (!item) return
    restoredSessionRef.current = true
    void loadSession(item)
  }, [sessions, activeSessionId, loadSession, appState?.workspace])

  useEffect(() => {
    if (!appState?.workspace) return
    try {
      localStorage.setItem(
        'xcode.tabs',
        JSON.stringify({ workspace: appState.workspace, tabs, active: activeSessionId }),
      )
    } catch {
      // localStorage 不可用时静默降级；标签恢复是尽力而为。
    }
  }, [tabs, activeSessionId, appState?.workspace])

  useEffect(() => {
    if (!activeSessionId) {
      setGoal(null)
      return
    }
    let cancelled = false
    void (async () => {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'goal:state',
        params: {},
      })
      if (cancelled) return
      if (response.ok) setGoal(response.result as GoalView | null)
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, appState?.workspace])

  const openSessionById = async (sessionId: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:list',
      params: {},
    })
    if (!response.ok) return
    const items = response.result as SessionListItem[]
    setSessions(items)
    const item = items.find((session) => session.sessionId === sessionId)
    if (item) await loadSession(item)
  }

  const newSession = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:new',
      params: {},
    })
    if (response.ok) {
      const { sessionId } = response.result as { sessionId: string }
      hostSessionIdRef.current = sessionId
      sessionBuffersRef.current.set(sessionId, createBuffer(sessionId))
      emptyTabsRef.current.add(sessionId)
      addTab(sessionId)
      activateEmptyTab(sessionId)
      await refreshSessions()
    }
  }

  useEffect(() => {
    if (newWindowSessionRef.current) return
    if (appState === null) return
    if (!new URLSearchParams(window.location.search).has('new')) return
    newWindowSessionRef.current = true
    void newSession()
  }, [appState, newSession])

  const activateTab = async (sessionId: string): Promise<void> => {
    if (sessionId === activeSessionId) return
    if (runningSessionIdsRef.current.has(sessionId)) {
      const activation = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:activate',
        params: { sessionId },
      })
      if (activation.ok && (activation.result as { activated: boolean }).activated) {
        hostSessionIdRef.current = sessionId
        showSessionBuffer(sessionId)
        addTab(sessionId)
        markTurnActivity('model')
        return
      }
    }
    const item = sessions.find((session) => session.sessionId === sessionId)
    if (item) {
      emptyTabsRef.current.delete(sessionId)
      await loadSession(item)
      return
    }
    if (emptyTabsRef.current.has(sessionId)) {
      const activation = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:activate',
        params: { sessionId },
      })
      if (activation.ok && (activation.result as { activated: boolean }).activated) {
        hostSessionIdRef.current = sessionId
      }
      activateEmptyTab(sessionId)
      return
    }
    setTabs((prev) => prev.filter((id) => id !== sessionId))
    setReport(t('该标签页的会话已不存在。'))
  }

  const switchTabByOffset = (offset: number): void => {
    if (tabs.length < 2) return
    const current = activeSessionId ? tabs.indexOf(activeSessionId) : -1
    const next = tabs[(current + offset + tabs.length) % tabs.length]
    if (next) void activateTab(next)
  }

  const copyLastReply = (): void => {
    const reply = [...entries].reverse().find((entry) => entry.role === 'assistant' && entry.text.trim())
    if (!reply) {
      setNotice(t('当前会话还没有可复制的回复'))
      setTimeout(() => setNotice(null), 1_800)
      return
    }
    window.xcode.copyText(reply.text)
    setNotice(t('已复制上一条回复'))
    setTimeout(() => setNotice(null), 1_800)
  }

  const closeTab = async (sessionId: string): Promise<void> => {
    if (runningSessionIdsRef.current.has(sessionId)) {
      setReport(t('该标签的回复仍在运行，请先停止后再关闭。'))
      return
    }
    const remaining = tabs.filter((id) => id !== sessionId)
    emptyTabsRef.current.delete(sessionId)
    sessionBuffersRef.current.delete(sessionId)
    void window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:close',
      params: { sessionId },
    })
    setTabs(remaining)
    if (sessionId !== activeSessionId) return
    let next: SessionListItem | undefined
    for (let index = remaining.length - 1; index >= 0; index--) {
      const found = sessions.find((session) => session.sessionId === remaining[index])
      if (found) {
        next = found
        break
      }
    }
    if (next) await loadSession(next)
    else await newSession()
  }

  const sameWorkspacePath = (left?: string, right?: string): boolean => {
    const normalize = (value?: string): string => (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    return normalize(left) !== '' && normalize(left) === normalize(right)
  }

  const loadBranches = async (): Promise<void> => {
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'git:branches',
        params: {},
      })
      if (response.ok) {
        setBranchView(response.result as BranchListView)
        setBranchError(null)
      } else {
        setBranchError(t('读取分支失败：{{message}}', { message: response.error.message }))
      }
    } catch (error) {
      setBranchError(t('读取分支失败：{{message}}', { message: String(error) }))
    }
  }

  const openBranchPicker = async (): Promise<void> => {
    setBranchOpen(true)
    setBranchView(null)
    setBranchQuery('')
    setBranchError(null)
    setNewBranchName('')
    setNewBranchParent('')
    setNewTaskPrompt('')
    setRemoveWorktree(null)
    setRemoveWorktreeError(null)
    await loadBranches()
  }

  const openBranchInWindow = async (branch: BranchInfoView): Promise<void> => {
    if (branchBusy) return
    setBranchBusy(branch.name)
    setBranchError(null)
    try {
      const opened = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:open',
        params: branch.remote
          ? { branch: branch.localName ?? branch.name, remoteRef: branch.name }
          : { branch: branch.name },
      })
      if (!opened.ok) {
        setBranchError(t('创建 worktree 失败：{{message}}', { message: opened.error.message }))
        return
      }
      const { workspacePath, created } = opened.result as { workspacePath: string; created: boolean }
      if (sameWorkspacePath(workspacePath, appState?.workspace)) {
        setBranchError(t('该分支已在当前窗口打开。'))
        return
      }
      const windowResult = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:new-window',
        params: { workspacePath },
      })
      if (!windowResult.ok) {
        setBranchError(t('打开新窗口失败：{{message}}', { message: windowResult.error.message }))
        return
      }
      const outcome = windowResult.result as { created: boolean; focused: boolean }
      setBranchOpen(false)
      setNotice(
        outcome.focused
          ? t('该分支的工作区已在已有窗口打开')
          : t(created ? '已在新窗口打开分支 {{branch}}（新建 worktree）' : '已在新窗口打开分支 {{branch}}', {
              branch: branch.name,
            }),
      )
    } catch (error) {
      setBranchError(t('创建 worktree 失败：{{message}}', { message: String(error) }))
    } finally {
      setBranchBusy(null)
    }
  }

  const chooseBranchParent = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:pick-path',
      params: { kind: 'folder' },
    })
    if (response.ok) {
      const selected = (response.result as { path: string | null }).path
      if (selected) setNewBranchParent(selected)
    }
  }

  const createBranchInWindow = async (taskPrompt?: string): Promise<void> => {
    const task = taskPrompt?.trim() ?? ''
    const branch = task ? taskBranchName(task) : newBranchName.trim()
    if (!branch || newBranchBusy || branchBusy) return
    setNewBranchBusy(true)
    setBranchError(null)
    try {
      const created = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:create',
        params: { branch, ...(newBranchParent.trim() ? { parentDir: newBranchParent.trim() } : {}) },
      })
      if (!created.ok) {
        setBranchError(t('创建分支失败：{{message}}', { message: created.error.message }))
        return
      }
      const { workspacePath, created: createdBranch } = created.result as {
        workspacePath: string
        created: boolean
      }
      if (sameWorkspacePath(workspacePath, appState?.workspace)) {
        setBranchError(t('该分支已在当前窗口打开。'))
        return
      }
      const windowResult = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:new-window',
        params: {
          workspacePath,
          ...(task ? { prompt: task, displayPrompt: task } : {}),
        },
      })
      if (!windowResult.ok) {
        setBranchError(t('打开新窗口失败：{{message}}', { message: windowResult.error.message }))
        return
      }
      setBranchOpen(false)
      setNewBranchName('')
      setNewBranchParent('')
      setNewTaskPrompt('')
      setNotice(
        task
          ? t('已在新 worktree 中开始任务（{{branch}}）', { branch })
          : t(createdBranch ? '已在新窗口打开新分支 {{branch}}' : '已在新窗口打开分支 {{branch}}', { branch }),
      )
    } catch (error) {
      setBranchError(t('创建分支失败：{{message}}', { message: String(error) }))
    } finally {
      setNewBranchBusy(false)
    }
  }

  const removeWorktreeNow = async (force: boolean): Promise<void> => {
    const target = removeWorktree
    if (!target || removeWorktreeBusy) return
    setRemoveWorktreeBusy(true)
    setRemoveWorktreeError(null)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:remove',
        params: { path: target.path, force },
      })
      if (!response.ok) {
        setRemoveWorktreeError(t('移除 worktree 失败：{{message}}', { message: response.error.message }))
        return
      }
      setRemoveWorktree(null)
      setNotice(t('已移除 worktree'))
      await loadBranches()
    } catch (error) {
      setRemoveWorktreeError(t('移除 worktree 失败：{{message}}', { message: String(error) }))
    } finally {
      setRemoveWorktreeBusy(false)
    }
  }

  const pruneWorktreeRecords = async (): Promise<void> => {
    if (pruneBusy) return
    setPruneBusy(true)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:prune',
        params: {},
      })
      if (!response.ok) {
        setBranchError(t('清理失效 worktree 失败：{{message}}', { message: response.error.message }))
        return
      }
      setNotice(t('已清理失效的 worktree 记录'))
      await loadBranches()
    } catch (error) {
      setBranchError(t('清理失效 worktree 失败：{{message}}', { message: String(error) }))
    } finally {
      setPruneBusy(false)
    }
  }

  const openInNewWindow = async (withCurrent = true): Promise<void> => {
    const item = withCurrent ? sessions.find((session) => session.sessionId === activeSessionId) : undefined
    if (withCurrent) {
      if (busyRef.current) {
        setReport(t('请先停止当前回复，再移动会话到新窗口。'))
        return
      }
      if (!item?.filePath) {
        setReport(t('当前标签页还没有已保存的会话，无法移动到新窗口。'))
        return
      }
    }
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: {
        ...(item?.filePath ? { sessionFilePath: item.filePath } : {}),
        ...(withCurrent && appState?.workspace ? { workspacePath: appState.workspace } : {}),
      },
    })
    if (!response.ok) {
      setReport(t('打开新窗口失败：{{message}}', { message: response.error.message }))
      return
    }
    if (!withCurrent) return
    const outcome = response.result as { created: boolean; focused: boolean }
    if (outcome.created && item) {
      await closeTab(item.sessionId)
      setNotice(t('会话已移动到新窗口'))
    } else {
      setReport(t('该工作区已在另一个窗口打开。'))
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 组词中的 Esc 是撤销候选，不应关闭面板或触发其它全局动作。
      if (isImeEvent(event)) return
      const mod = event.metaKey || event.ctrlKey
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (mod && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const target = tabs[Number(event.key) - 1]
        if (target) {
          event.preventDefault()
          void activateTab(target)
        }
        return
      }
      if (mod && event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        switchTabByOffset(event.key === '[' ? -1 : 1)
        return
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        copyLastReply()
        return
      }
      if (mod && event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault()
        void openInNewWindow(false)
        return
      }
      if (mod && event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault()
        void newSession()
        return
      }
      if (mod && event.key.toLowerCase() === 't' && !event.shiftKey) {
        event.preventDefault()
        void newSession()
        return
      }
      if (mod && event.key === ',') {
        event.preventDefault()
        void openSettings()
        return
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSidebarOpen(true)
        setTimeout(() => sessionSearchRef.current?.focus(), 30)
        return
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        void openDocumentPanel()
        return
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
        return
      }
      if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        changeZoom(0.1)
        return
      }
      if (mod && event.key === '-') {
        event.preventDefault()
        changeZoom(-0.1)
        return
      }
      if (mod && event.key === '0') {
        event.preventDefault()
        changeZoom(0, true)
        return
      }
      if (!typing && event.key === '?') {
        event.preventDefault()
        setShortcutSheetOpen(true)
        return
      }
      if (event.key === 'Escape') {
        if (imageLightbox) setImageLightbox(null)
        else if (salvageTarget) setSalvageTarget(null)
        else if (goalOpen) setGoalOpen(false)
        else if (contextSearchOpen) setContextSearchOpen(false)
        else if (paletteOpen) setPaletteOpen(false)
        else if (inspectorTab) setInspectorTab(null)
        else if (branchOpen) {
          if (removeWorktree) {
            setRemoveWorktree(null)
            setRemoveWorktreeError(null)
          } else {
            setBranchOpen(false)
          }
        } else if (shortcutSheetOpen) setShortcutSheetOpen(false)
        else if (findOpen) setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    imageLightbox,
    salvageTarget,
    goalOpen,
    contextSearchOpen,
    paletteOpen,
    inspectorTab,
    branchOpen,
    removeWorktree,
    shortcutSheetOpen,
    findOpen,
    newSession,
    openSettings,
    openDocumentPanel,
    changeZoom,
    openInNewWindow,
    tabs,
    activeSessionId,
    activateTab,
    switchTabByOffset,
    copyLastReply,
  ])

  const applySessionView = (view: LoadedSessionView): void => {
    hostSessionIdRef.current = view.sessionId
    activeSessionIdRef.current = view.sessionId
    setTurnWindow(40)
    replaceEntries(
      view.sessionId,
      view.messages.map((message) => ({ ...message })),
    )
    setUsageFor(view.sessionId, view.usage)
    setTodosFor(view.sessionId, [])
    setQueued(0)
    queueRef.current = []
    setQueuedItems([])
    setAttachments([])
    setActiveSessionId(view.sessionId)
    emptyTabsRef.current.delete(view.sessionId)
    addTab(view.sessionId)
    pendingSessionRef.current = null
    setPendingSession(null)
  }

  const lastUserEntry = (): Entry | undefined => [...entries].reverse().find((entry) => entry.role === 'user')

  /** 把对话截断到最近一次用户轮次之前。
   *  文件保持不动；这支撑「编辑并重发」与「重新生成」。 */
  const rewindConversation = async (): Promise<boolean> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:checkpoints',
      params: {},
    })
    if (!response.ok) {
      setReport(t('读取检查点失败：{{message}}', { message: response.error.message }))
      return false
    }
    const checkpoints = (response.result as { checkpoints: Array<{ ckptId: string }> }).checkpoints
    const latest = checkpoints[checkpoints.length - 1]
    if (!latest) {
      setReport(t('还没有可以重写的轮次。'))
      return false
    }
    const rewound = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:rewind',
      params: { ckptId: latest.ckptId, mode: 'conversation' },
    })
    if (!rewound.ok) {
      setReport(t('回退失败：{{message}}', { message: rewound.error.message }))
      return false
    }
    applySessionView((rewound.result as RewindResultView).view)
    return true
  }

  const regenerateLast = async (): Promise<void> => {
    if (busyRef.current) return
    const lastUser = lastUserEntry()
    if (!lastUser?.text.trim()) {
      setReport(t('没有可以重新生成的上一轮。'))
      return
    }
    if (lastUser.attachments?.length) {
      setReport(t('上一轮包含附件，暂不支持重新生成；可以编辑为文本后重发。'))
      return
    }
    if (!(await rewindConversation())) return
    await submit(lastUser.text, false)
  }

  const beginEditLast = (): void => {
    if (busyRef.current) return
    const lastUser = lastUserEntry()
    if (!lastUser) return
    setInput(lastUser.text)
    setAttachments(lastUser.attachments ?? [])
    setEditArmed(true)
    composerRef.current?.focus()
  }

  const recoverDamagedSession = async (): Promise<void> => {
    const target = salvageTarget
    if (!target || salvageBusy) return
    setSalvageBusy(true)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:salvage',
        params: { filePath: target.filePath },
      })
      if (!response.ok) {
        setReport(t('恢复会话失败：{{message}}', { message: response.error.message }))
        return
      }
      const result = response.result as { messageCount: number; view: LoadedSessionView }
      applySessionView(result.view)
      setSalvageTarget(null)
      setNotice(t('已恢复 {{count}} 条消息到新会话', { count: result.messageCount }))
      await refreshSessions()
    } catch (error) {
      setReport(
        t('恢复会话失败：{{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setSalvageBusy(false)
    }
  }

  const forkCurrentSession = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:fork',
      params: {},
    })
    if (!response.ok) {
      setReport(t('派生会话失败：{{message}}', { message: response.error.message }))
      return
    }
    const result = response.result as { sessionId: string; filePath: string; view: LoadedSessionView }
    applySessionView(result.view)
    setReport(t('已派生新会话，原会话保持不变。'))
    await refreshSessions()
    await refreshState()
  }

  /** 剪贴板图片没有文件系统路径，因此交给运行时，
   *  由它写到用户数据目录下。 */
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element) || !event.target.closest('.composer')) return
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    void (async () => {
      const saved: string[] = []
      for (const file of files) {
        try {
          const data = base64FromBuffer(await file.arrayBuffer())
          const response = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'app:save-pasted-image',
            params: { data, mime: file.type },
          })
          if (response.ok) saved.push((response.result as { path: string }).path)
          else setReport(t('粘贴图片失败：{{message}}', { message: response.error.message }))
        } catch (error) {
          setReport(
            t('粘贴图片失败：{{message}}', {
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      }
      if (saved.length > 0) setAttachments((current) => [...new Set([...current, ...saved])])
      composerRef.current?.focus()
    })()
  }

  const revertEdit = async (toolCallId: string, entryId: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'edit:revert',
      params: { toolCallId },
    })
    if (!response.ok) {
      append({ role: 'error', text: t('回退编辑失败：{{message}}', { message: response.error.message }) })
      return
    }
    const result = response.result as { message: string; filePath: string }
    commitEntries(bufferKey(), (prev) =>
      prev.map((entry) => (entry.id === entryId ? { ...entry, reverted: true } : entry)),
    )
    setReport(t('{{message}}：{{path}}', { message: result.message, path: result.filePath }))
  }

  const openInEditor = (filePath: string, line?: number, column?: number): void => {
    const workspace = appState?.workspace ?? settings?.workspace ?? ''
    const absolute = /^([A-Za-z]:[\\/]|\/)/.test(filePath)
      ? filePath
      : `${workspace.replace(/[\\/]$/, '')}/${filePath.replace(/^\.?[\\/]/, '')}`
    void window.xcode
      .request({
        id: crypto.randomUUID(),
        method: 'app:open-in-editor',
        params: { filePath: absolute, ...(line !== undefined ? { line, ...(column ? { column } : {}) } : {}) },
      })
      .then((response) => {
        if (!response.ok) {
          setReport(t('无法打开编辑器：{{message}}', { message: response.error.message }))
          return
        }
        const result = response.result as { opened: boolean; editor?: string; error?: string }
        if (!result.opened) setReport(result.error ?? t('未找到可用的编辑器'))
      })
  }

  const attachImageData = async (dataUrl: string): Promise<void> => {
    const data = dataUrl.split(',')[1] ?? ''
    if (!data) {
      setReport(t('截屏失败：返回了空图像'))
      return
    }
    const saved = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:save-pasted-image',
      params: { data, mime: 'image/png' },
    })
    if (!saved.ok) {
      setReport(t('保存截图失败：{{message}}', { message: saved.error.message }))
      return
    }
    const path = (saved.result as { path: string }).path
    setAttachments((current) => [...new Set([...current, path])])
  }

  const loadCaptureScreens = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:list-screens',
      params: {},
    })
    if (response.ok) setCaptureScreens((response.result as { screens: CaptureScreenView[] }).screens)
  }

  const toggleCaptureMenu = (): void => {
    setCaptureMenuOpen((open) => {
      const next = !open
      if (next) void loadCaptureScreens()
      return next
    })
  }

  const captureScreen = async (displayId?: number): Promise<void> => {
    setCaptureMenuOpen(false)
    setNotice(t('正在截屏…'))
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:capture-screen',
        params: displayId === undefined ? {} : { displayId },
      })
      if (!response.ok) {
        setReport(t('截屏失败：{{message}}', { message: response.error.message }))
        return
      }
      await attachImageData((response.result as { dataUrl: string }).dataUrl)
      markUsage('screenshot')
    } catch (error) {
      setReport(
        t('截屏失败：{{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setNotice(null)
    }
  }

  const captureRegion = async (): Promise<void> => {
    setCaptureMenuOpen(false)
    setNotice(t('正在框选截图…'))
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:capture-region',
        params: {},
      })
      if (!response.ok) {
        setReport(t('区域截图失败：{{message}}', { message: response.error.message }))
        return
      }
      const result = response.result as { dataUrl: string; cancelled: boolean }
      if (result.cancelled) return
      await attachImageData(result.dataUrl)
      markUsage('screenshot')
    } catch (error) {
      setReport(
        t('区域截图失败：{{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    } finally {
      setNotice(null)
    }
  }

  const startRecording = async (): Promise<void> => {
    const permission = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:microphone-access',
      params: {},
    })
    if (!permission.ok || (permission.result as { granted: boolean }).granted !== true) {
      setReport(t('麦克风权限被拒绝。请在系统设置中允许 X-Code 使用麦克风。'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const context = new AudioContext()
      await context.resume().catch(() => undefined)
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      audioChunksRef.current = []
      recordStartedAtRef.current = Date.now()
      lastLevelAtRef.current = 0
      setRecordingSeconds(0)
      setAudioLevel(0)
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0)
        audioChunksRef.current.push(new Float32Array(samples))
        const now = performance.now()
        if (now - lastLevelAtRef.current > 100) {
          lastLevelAtRef.current = now
          let sum = 0
          let count = 0
          for (let index = 0; index < samples.length; index += 4) {
            sum += samples[index] * samples[index]
            count++
          }
          const rms = count > 0 ? Math.sqrt(sum / count) : 0
          setAudioLevel(Math.min(1, rms * 6))
        }
      }
      source.connect(processor)
      processor.connect(context.destination)
      mediaStreamRef.current = stream
      audioContextRef.current = context
      audioProcessorRef.current = processor
      audioSampleRateRef.current = context.sampleRate
      setRecording(true)
      setNotice(t('录音中：在上方录音条完成或取消'))
    } catch (error) {
      setReport(
        t('无法开始录音：{{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  const stopRecording = async (transcribe = true): Promise<void> => {
    const processor = audioProcessorRef.current
    const context = audioContextRef.current
    const stream = mediaStreamRef.current
    audioProcessorRef.current = null
    audioContextRef.current = null
    mediaStreamRef.current = null
    processor?.disconnect()
    void context?.close().catch(() => undefined)
    stream?.getTracks().forEach((track) => track.stop())
    setRecording(false)
    setAudioLevel(0)
    setRecordingSeconds(0)
    setNotice(null)

    const chunks = audioChunksRef.current
    audioChunksRef.current = []
    if (!transcribe) return
    if (chunks.length === 0) return
    const wav = encodeWav(chunks, audioSampleRateRef.current)
    if (wav.byteLength < 2_000) {
      setReport(t('录音太短，请再试一次。'))
      return
    }
    setVoiceBusy(true)
    setNotice(t('正在转写…'))
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'audio:transcribe',
        params: {
          data: base64FromBuffer(wav),
          mime: 'audio/wav',
          language: i18n.language === 'en' ? 'en' : 'zh',
        },
      })
      if (!response.ok) {
        setReport(t('语音转写失败：{{message}}', { message: response.error.message }))
        return
      }
      const text = (response.result as { text: string }).text
      if (!text) {
        setReport(t('没有识别到语音内容。'))
        return
      }
      setInput((previous) => (previous ? `${previous} ${text}` : text))
      composerRef.current?.focus()
    } finally {
      setVoiceBusy(false)
      setNotice(null)
    }
  }

  const toggleRecording = (): void => {
    if (recording) void stopRecording(true)
    else void startRecording()
  }

  const commitRename = async (): Promise<void> => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false
      setRenaming(null)
      return
    }
    if (!renaming) return
    const { filePath } = renaming
    const name = renaming.value.trim()
    setRenaming(null)
    if (!name) return
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:rename',
      params: { filePath, name },
    })
    if (!response.ok) {
      append({ role: 'error', text: t('重命名失败：{{message}}', { message: response.error.message }) })
      return
    }
    await refreshSessions()
  }

  const confirmDeleteSession = async (item: SessionListItem): Promise<void> => {
    setDeletingSession(null)
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:delete',
      params: { filePath: item.filePath },
    })
    if (!response.ok) {
      append({ role: 'error', text: t('删除失败：{{message}}', { message: response.error.message }) })
      return
    }
    const { resetActive } = response.result as { resetActive: boolean }
    setTabs((prev) => prev.filter((sessionId) => sessionId !== item.sessionId))
    emptyTabsRef.current.delete(item.sessionId)
    sessionBuffersRef.current.delete(item.sessionId)
    if (resetActive) {
      setEntries([])
      setUsage(null)
      setTodos([])
      busyRef.current = false
      setBusy(false)
      clearTurnActivity()
      setQueued(0)
      queueRef.current = []
      setQueuedItems([])
      await newSession()
    }
    await refreshSessions()
  }

  const toggleSessionPinned = async (item: SessionListItem): Promise<void> => {
    const pinned = !item.pinned
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:set-pinned',
      params: { filePath: item.filePath, pinned },
    })
    if (response.ok) {
      setSessions((prev) => prev.map((entry) => (entry.filePath === item.filePath ? { ...entry, pinned } : entry)))
    }
  }

  const toggleSessionArchived = async (item: SessionListItem): Promise<void> => {
    const archived = !item.archived
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:set-archived',
      params: { filePath: item.filePath, archived },
    })
    if (response.ok) {
      setSessions((prev) => prev.map((entry) => (entry.filePath === item.filePath ? { ...entry, archived } : entry)))
    }
  }

  const exportCurrentSession = async (format: 'markdown' | 'json' | 'html' | 'pdf'): Promise<void> => {
    const item = sessions.find((session) => session.sessionId === activeSessionId)
    if (!item) {
      setReport(t('没有可导出的当前会话（先发送一条消息）。'))
      return
    }
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:export',
      params: { filePath: item.filePath, format },
    })
    if (!response.ok) {
      setReport(t('导出失败：{{message}}', { message: response.error.message }))
      return
    }
    const result = response.result as { path: string }
    setReport(t('已导出到 {{path}}', { path: result.path }))
    void window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:reveal-path',
      params: { path: result.path },
    })
  }

  const respondApproval = async (
    request: ApprovalRequestEvent,
    decision: 'yes' | 'always' | 'no' | boolean | string,
  ): Promise<void> => {
    setApprovals((prev) => prev.filter((item) => item.requestId !== request.requestId))
    markTurnActivity(request.toolName ? 'tool' : 'model', request.toolName)
    const payload: {
      requestId: string
      kind: ApprovalRequestEvent['kind']
      decision?: 'yes' | 'always' | 'no'
      answer?: string
      approved?: boolean
    } = { requestId: request.requestId, kind: request.kind }
    if (request.kind === 'permission' || request.kind === 'authority') {
      payload.decision =
        typeof decision === 'boolean' ? (decision ? 'yes' : 'no') : (decision as 'yes' | 'always' | 'no')
    } else if (request.kind === 'plan') {
      payload.approved = decision === true
    } else {
      payload.answer = typeof decision === 'string' ? decision : ''
    }
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'approval:respond',
      params: payload,
    })
  }

  const requestTextReport = async (method: string, params: Record<string, unknown> = {}): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method,
      params,
    } as unknown as Parameters<typeof window.xcode.request>[0])
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setReport((response.result as TextReport).text)
  }

  const runCompact = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:compact',
      params: {},
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setReport((response.result as CompactResult).message)
  }

  const toggleThinking = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-thinking',
      params: { enabled: !(appState?.thinking ?? false) },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setReport(
      t('思考模式：{{state}}', {
        state: (response.result as { thinking: boolean }).thinking ? t('开') : t('关'),
      }),
    )
  }

  const togglePlan = async (): Promise<void> => {
    const mode = appState?.permissionMode === 'plan' ? 'default' : 'plan'
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-permission-mode',
      params: { mode },
    })
    if (!response.ok) {
      append({ role: 'error', text: response.error.message })
      return
    }
    setReport(mode === 'plan' ? t('已进入计划模式（只读；提交计划后需要批准）。') : t('已退出计划模式。'))
  }

  const slashCommands = createSlashCommands({
    t,
    setSettingsOpen,
    closeInspector,
    setModelMenuOpen,
    openSettings,
    openDocumentPanel,
    openInspector,
    openGitPanel,
    openChecksPanel,
    openSidebar,
    toggleInspector,
    runDiagnostics,
    runCompact,
    requestTextReport,
    exportCurrentSession,
    setBackgroundOpen,
    toggleThinking,
    togglePlan,
    setReport,
    newSession,
    abort,
    submit,
    forkCurrentSession,
    setRewindOpen,
    setGoalOpen,
    setContextSearchOpen,
    setManualOpen,
    append,
  })
  const runCustomCommand = async (name: string, args: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:run',
      params: { name, args },
    })
    if (!response.ok) {
      append({ role: 'error', text: t('命令执行失败：{{message}}', { message: response.error.message }) })
      return
    }
    const result = response.result as { name: string; prompt: string }
    append({ role: 'system', text: `/${result.name}${args ? ` ${args}` : ''}` })
    await submit(result.prompt, true)
  }

  const customSlashCommands: SlashCommand[] = customCommands
    .filter((command) => !slashCommands.some((builtin) => builtin.name === `/${command.name}`))
    .map((command) => ({
      name: `/${command.name}`,
      description: command.description || (command.source === 'plugin' ? t('插件命令') : t('自定义命令')),
      run: () => void runCustomCommand(command.name, ''),
    }))

  const allSlashCommands = [...slashCommands, ...customSlashCommands]
  const helpText = [
    t('命令'),
    '',
    ...allSlashCommands.map((command) => `${command.name.padEnd(20)} ${command.description}`),
    `${'/help'.padEnd(20)} 显示所有命令`,
  ].join('\n')
  const commandsWithHelp: SlashCommand[] = [
    { name: '/help', description: t('显示所有命令'), run: () => setReport(helpText) },
    ...allSlashCommands,
  ]

  const openFilesPanel = (path: string | null = null): void => {
    setFileInitialPath(path)
    openInspector('file')
  }

  const paletteActions = createAppActions({
    t,
    appState,
    terminalOpen,
    recording,
    newSession,
    openInNewWindow,
    openBranchPicker,
    openSettings,
    openFilesPanel,
    openInEditor,
    openDocumentPanel,
    openGitPanel,
    openChecksPanel,
    toggleInspector,
    setSettingsOpen,
    setBackgroundOpen,
    setRewindOpen,
    setGoalOpen,
    setContextSearchOpen,
    setSidebarOpen,
    setShortcutSheetOpen,
    setManualOpen,
    setReport,
    forkCurrentSession,
    scanLocalModels,
    runCompact,
    exportCurrentSession,
    cycleTheme,
    toggleLanguage,
    runDiagnostics,
    pickDocument,
    captureRegion,
    captureScreen,
    toggleRecording,
  })
  // “更多工具”菜单不再维护独立按钮列表：从同一份 Action Registry 取条目。
  const toolMenuActions = TOOL_MENU_ACTION_IDS.flatMap((id) => {
    const action = paletteActions.find((entry) => entry.id === id)
    return action ? [action] : []
  })
  const slashQuery = input.startsWith('/') ? input.slice(1).toLowerCase() : null
  const paletteCommands =
    slashQuery === null ? [] : commandsWithHelp.filter((command) => command.name.slice(1).startsWith(slashQuery))
  const slashPaletteRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (paletteCommands.length === 0) return
    slashPaletteRef.current?.querySelector<HTMLElement>('.slash-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [paletteIndex, input, paletteCommands.length])

  const runSlashCommand = (command: SlashCommand): void => {
    setInput('')
    setPaletteIndex(0)
    void command.run()
  }

  useEffect(() => {
    setPaletteIndex(0)
  }, [input])

  const taskMode = normalizeTaskMode(appState?.taskMode)
  const starterSuggestions = ((): string[] => {
    const insights = workspaceInsights
    const fallback = TASK_MODE_TEMPLATE[taskMode].suggestions.map((suggestion) => t(suggestion))
    if (!insights) return fallback
    const items: string[] = []
    if (insights.git.changeCount > 0) items.push(t('Review 当前改动并给出修复建议'))
    if (insights.checks.some((check) => /test|测试/i.test(check.label))) {
      items.push(t('运行项目检查并修复失败项'))
    } else if (insights.checks.length > 0) {
      items.push(t('运行项目检查'))
    }
    if (insights.recentDocument) {
      items.push(t('总结最近打开的文档：{{name}}', { name: insights.recentDocument.name }))
    }
    if (insights.hasSpreadsheet) items.push(t('汇总表格中的关键数据'))
    else if (insights.hasDocuments) items.push(t('总结当前目录中的文档'))
    if (insights.hasTex || insights.hasBib) items.push(t('整理参考资料并列出可用文献'))
    if (insights.hasPackageJson) items.push(t('分析这个项目的结构并给出改进建议'))
    if (insights.hasReadme) items.push(t('根据 README 介绍这个项目'))
    return items.length > 0 ? [...new Set(items)].slice(0, 4) : fallback
  })()
  const starterHint = ((): string => {
    const insights = workspaceInsights
    if (insights && insights.git.changeCount > 0) {
      return t('当前有 {{count}} 个未提交改动，可以从这里开始。', { count: insights.git.changeCount })
    }
    if (insights && insights.checks.length > 0) {
      return t('检测到 {{count}} 项项目检查，可以从这里开始。', { count: insights.checks.length })
    }
    if (insights?.recentDocument) return t('最近的文档：{{name}}', { name: insights.recentDocument.name })
    if (insights?.hasPackageJson) return t('这是一个 Node 项目；也可以直接描述你想做的事。')
    return t(TASK_MODE_TEMPLATE[taskMode].hint)
  })()
  const usageDone = Object.values(usageProgress).filter(Boolean).length
  const activeModel = appState?.models.find((model) => model.id === appState?.activeModelId)
  const currentTitle = activeModel?.label ?? t('模型')
  const modelNeedle = modelQuery.trim().toLowerCase()
  const filteredModels = (appState?.models ?? []).filter(
    (model) =>
      !modelNeedle ||
      [model.label, model.id, model.provider, model.description].some((value) =>
        value.toLowerCase().includes(modelNeedle),
      ),
  )
  const isLocalModel = (model: ModelOption): boolean =>
    model.id.startsWith('ollama:') || model.id.startsWith('lmstudio:')
  // 当前模型固定置顶；其余模型按 provider 分组，避免模型多时翻很久。
  const visibleModels = filteredModels.filter((model) => model.id !== appState?.activeModelId)
  const localModelOptions = visibleModels.filter(isLocalModel)
  const remoteModelOptions = visibleModels.filter((model) => !isLocalModel(model))
  const providerGroups: Array<{ provider: string; models: ModelOption[] }> = []
  for (const model of remoteModelOptions) {
    const group = providerGroups.find((entry) => entry.provider === model.provider)
    if (group) group.models.push(model)
    else providerGroups.push({ provider: model.provider, models: [model] })
  }
  const keyboardModels = [...localModelOptions, ...remoteModelOptions]
  useEffect(() => {
    if (modelKeyIndex < 0) return
    document.querySelector<HTMLElement>('.model-list .model-item.is-keyboard')?.scrollIntoView({ block: 'nearest' })
  }, [modelKeyIndex])
  const renderModelItem = (model: ModelOption, showProvider = false): React.JSX.Element => {
    const keyboardIndex = keyboardModels.findIndex((item) => item.id === model.id)
    return (
      <button
        key={model.id}
        className={`model-item ${model.id === appState?.activeModelId ? 'active' : ''} ${
          keyboardIndex >= 0 && keyboardIndex === modelKeyIndex ? 'is-keyboard' : ''
        }`}
        onClick={() => void chooseModel(model)}
      >
        <span className="model-item-label">{model.label}</span>
        <span className="model-item-meta">
          {showProvider ? <span>{providerDisplayName(model.provider)}</span> : null}
          {model.contextWindow ? (
            <span
              className="model-item-context"
              title={t('上下文上限 {{tokens}} tokens', {
                tokens: model.contextWindow.toLocaleString(),
              })}
            >
              {formatContextTokens(model.contextWindow)} {t('上下文')}
            </span>
          ) : null}
        </span>
        <span className="model-item-desc">{model.description}</span>
      </button>
    )
  }
  const canSend = !busy && (input.trim().length > 0 || attachments.length > 0)
  useEffect(() => {
    setNextStepsHidden(false)
  }, [activeSessionId])

  const busyForActive = busy && activeSessionId !== null && runningSessionIds.has(activeSessionId)
  const backgroundRunning = runningSessionIds.size > (busyForActive ? 1 : 0)

  const nextSteps = busy ? [] : buildNextSteps({ entries, todos, goal })

  // 侧栏目录树：当前工作区在前，其余来自 session:list-all 的最近会话。
  const currentWorkspacePath = appState?.workspace ?? settings?.workspace ?? ''
  const autoExpandedWorkspaceRef = useRef<string | null>(null)

  useEffect(() => {
    if (!currentWorkspacePath) return
    if (autoExpandedWorkspaceRef.current === currentWorkspacePath) return
    autoExpandedWorkspaceRef.current = currentWorkspacePath
    setExpandedWorkspaces((previous) => {
      if (previous.has(currentWorkspacePath)) return previous
      const next = new Set(previous)
      next.add(currentWorkspacePath)
      return next
    })
  }, [currentWorkspacePath])
  const sidebarTreeGroups: Array<{
    path: string
    name: string
    current: boolean
    sessions: SessionListItem[]
  }> = []
  if (currentWorkspacePath) {
    const currentName =
      workspaces.find((project) => project.current)?.name ??
      currentWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ??
      currentWorkspacePath
    sidebarTreeGroups.push({ path: currentWorkspacePath, name: currentName, current: true, sessions: [] })
  }
  for (const project of workspaces) {
    if (project.current || project.path === currentWorkspacePath) continue
    const known = workspaceSessions.find((entry) => entry.path === project.path)
    sidebarTreeGroups.push({
      path: project.path,
      name: project.name,
      current: false,
      sessions: known?.sessions ?? [],
    })
  }
  const expandAllWorkspaces = (): void => {
    setExpandedWorkspaces(new Set(sidebarTreeGroups.map((group) => group.path)))
  }

  const collapseAllWorkspaces = (): void => {
    setExpandedWorkspaces(new Set())
  }

  const backgroundSessionId = [...runningSessionIds].find((sessionId) => sessionId !== activeSessionId)
  const runningIndicatorId =
    activeSessionId && runningSessionIds.has(activeSessionId) ? activeSessionId : ([...runningSessionIds][0] ?? '')
  const backgroundTitle =
    backgroundRunning && backgroundSessionId
      ? tabTitles[backgroundSessionId] ||
        sessions.find((item) => item.sessionId === backgroundSessionId)?.firstPrompt?.slice(0, 40) ||
        t('另一个会话')
      : ''
  // composer 的键盘逻辑与输入框解耦，供 ComposerBox 复用。
  const handleComposerKeyDown = useComposerKeyDown({
    mention,
    mentionItems,
    mentionIndex,
    setMention,
    setMentionIndex,
    dismissedMentionRef,
    pickMention,
    paletteCommands,
    paletteIndex,
    setPaletteIndex,
    setInput,
    runSlashCommand,
    applyMarkdown,
    input,
    exportCurrentSession,
    customCommands,
    runCustomCommand,
    append,
    attachments,
    submit,
  })
  const contextWindow = appState?.contextWindow ?? usage?.contextWindow ?? null
  const usedContextTokens = usage?.currentContextTokens ?? 0
  const contextPercent =
    contextWindow && contextWindow > 0 ? Math.min(100, Math.round((usedContextTokens / contextWindow) * 100)) : null
  const findNeedle = findQuery.trim().toLowerCase()
  const findMatchIds = findNeedle
    ? entries
        .filter(
          (entry) =>
            (entry.role === 'user' || entry.role === 'assistant') && entry.text.toLowerCase().includes(findNeedle),
        )
        .map((entry) => entry.id)
    : []
  const findActiveIndex = findMatchIds.length > 0 ? findIndex % findMatchIds.length : 0
  const findActiveId = findMatchIds[findActiveIndex]
  const goFind = (delta: number): void => {
    if (findMatchIds.length === 0) return
    const next = (findActiveIndex + delta + findMatchIds.length) % findMatchIds.length
    setFindIndex(next)
    document.getElementById(`entry-${findMatchIds[next]}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const sessionFilter = sessionQuery.trim().toLowerCase()
  const visibleSessions = sessions
    .filter((item) => showArchived || !item.archived)
    .filter(
      (item) =>
        !sessionFilter ||
        sessionTitle(item).toLowerCase().includes(sessionFilter) ||
        item.firstPrompt.toLowerCase().includes(sessionFilter) ||
        item.sessionId.toLowerCase().includes(sessionFilter),
    )
    .slice()
    .sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true) || right.mtime - left.mtime)
  const sessionMenuItem = sessionMenu ? (sessions.find((item) => item.filePath === sessionMenu.filePath) ?? null) : null
  const extraSearchResults =
    sessionQuery.trim().length >= 2
      ? searchResults.filter((result) => !visibleSessions.some((item) => item.filePath === result.filePath))
      : []
  const branchNeedle = branchQuery.trim().toLowerCase()
  const visibleBranches = (branchView?.branches ?? []).filter(
    (branch) => !branchNeedle || branch.name.toLowerCase().includes(branchNeedle),
  )
  const turnBuild = buildTurnItems(entries, {
    sessionKey: activeSessionId ?? 'current',
    toolDisplayMode,
    toolOverrides: turnToolOverrides,
    ...(findOpen ? {} : { maxTurns: turnWindow }),
  })
  const turnItems: TurnRenderItem[] = turnBuild.items
  const toggleTurnTools = (key: string): void => {
    setTurnToolOverrides((previous) => {
      const current = previous.get(key) ?? toolDisplayMode !== 'minimal'
      const next = new Map(previous)
      next.set(key, !current)
      return next
    })
  }
  const showPendingSession =
    pendingSession !== null && !sessions.some((item) => item.sessionId === pendingSession.sessionId)
  const lastUserId = [...entries].reverse().find((entry) => entry.role === 'user')?.id ?? null
  const lastAssistantId =
    [...entries].reverse().find((entry) => entry.role === 'assistant' && entry.text.trim())?.id ?? null
  const removeQueued = (index: number): void => {
    queueRef.current.splice(index, 1)
    setQueued(queueRef.current.length)
    setQueuedItems([...queueRef.current])
  }

  const moveQueued = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= queueRef.current.length) return
    const [item] = queueRef.current.splice(index, 1)
    if (!item) return
    queueRef.current.splice(target, 0, item)
    setQueuedItems([...queueRef.current])
  }

  const clearQueued = (): void => {
    queueRef.current = []
    setQueued(0)
    setQueuedItems([])
  }

  const openQueuedInNewWindow = async (index: number): Promise<void> => {
    const item = queueRef.current[index]
    if (!item) return
    const forked = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:fork-background',
      params: {},
    })
    if (!forked.ok) {
      append({ role: 'error', text: forked.error.message })
      return
    }
    const fork = forked.result as { sessionId: string; filePath: string; snapshot?: string }
    const snapshot = fork.snapshot?.trim()
    const prompt = snapshot ? `${snapshot}\n\n[User question]\n${item.prompt}` : item.prompt
    const opened = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: {
        sessionFilePath: fork.filePath,
        workspacePath: appState?.workspace ?? settings?.workspace,
        prompt,
        displayPrompt: item.prompt,
      },
    })
    if (!opened.ok) {
      append({ role: 'error', text: opened.error.message })
      return
    }
    const currentIndex = queueRef.current.indexOf(item)
    if (currentIndex >= 0) removeQueued(currentIndex)
    setNotice(t('已在新窗口另开任务；当前回复不受影响'))
  }

  return (
    <div
      className="app"
      data-running-session={runningIndicatorId}
      onPaste={handlePaste}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragActive(true)
        }
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget === null) setDragActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        const dropped = Array.from(event.dataTransfer.files)
          .map((file) => window.xcode.pathForFile(file))
          .filter((filePath): filePath is string => Boolean(filePath))
        if (dropped.length > 0) setAttachments((current) => [...new Set([...current, ...dropped])])
      }}
    >
      {dragActive ? <div className="drop-overlay">{t('松开以添加附件')}</div> : null}
      {sidebarOpen ? (
        <aside className="sidebar" data-testid="sidebar" style={{ width: sidebarWidth }}>
          <div className="sidebar-section">
            <div className="sidebar-head">
              <span className="sidebar-title">{t('工作区与会话')}</span>
              <span className="sidebar-count" title={t('当前工作区 {{count}} 个会话', { count: sessions.length })}>
                {sessions.length}
              </span>
              <button
                className="sidebar-add"
                title={t('展开全部工作区')}
                aria-label={t('展开全部工作区')}
                onClick={expandAllWorkspaces}
              >
                ⊞
              </button>
              <button
                className="sidebar-add"
                title={t('收起全部工作区')}
                aria-label={t('收起全部工作区')}
                onClick={collapseAllWorkspaces}
              >
                ⊟
              </button>
              <button
                className="sidebar-add"
                data-testid="branch-window-button"
                title={t('在新窗口打开分支')}
                aria-label={t('在新窗口打开分支')}
                onClick={() => void openBranchPicker()}
              >
                <BranchIcon />
              </button>
              <button
                className="sidebar-add"
                data-testid="scratch-workspace"
                title={t('快速提问（默认工作区）')}
                aria-label={t('快速提问（默认工作区）')}
                disabled={switchingProject !== null || !settings?.defaultWorkspace}
                onClick={() => {
                  const target = settings?.defaultWorkspace
                  if (target) void switchProject(target)
                }}
              >
                ⚡
              </button>
              <button
                className="sidebar-add"
                title={t('选择项目文件夹')}
                disabled={switchingProject !== null}
                onClick={() => void pickProject()}
              >
                ＋
              </button>
            </div>
            <WorkspaceTree
              sidebarTreeGroups={sidebarTreeGroups}
              expandedWorkspaces={expandedWorkspaces}
              runningSessionIds={runningSessionIds}
              runningOther={runningOther}
              switchingProject={switchingProject}
              activeSessionId={activeSessionId}
              pendingSession={pendingSession}
              showPendingSession={showPendingSession}
              visibleSessions={visibleSessions}
              extraSearchResults={extraSearchResults}
              searchResults={searchResults}
              searchingSessions={searchingSessions}
              loading={!sessionsLoaded}
              othersLoading={!workspaceSessionsLoaded}
              sessionQuery={sessionQuery}
              showArchived={showArchived}
              tabTitles={tabTitles}
              renaming={renaming}
              deletingSession={deletingSession}
              sessionSearchRef={sessionSearchRef}
              renameCancelRef={renameCancelRef}
              setSessionQuery={setSessionQuery}
              setShowArchived={setShowArchived}
              setRenaming={setRenaming}
              setDeletingSession={setDeletingSession}
              setSessionMenu={setSessionMenu}
              toggleWorkspace={toggleWorkspace}
              switchProject={switchProject}
              newSession={newSession}
              openWorkspaceWindow={openWorkspaceWindow}
              newWorkspaceSession={newWorkspaceSession}
              openWorkspaceSession={openWorkspaceSession}
              loadSession={loadSession}
              commitRename={commitRename}
              confirmDeleteSession={confirmDeleteSession}
            />
          </div>
          {!usageDismissed && usageDone < 5 ? (
            <UsageChecklist
              progress={usageProgress}
              open={usageOpen}
              onToggle={() => setUsageOpen((value) => !value)}
              onDismiss={() => {
                setUsageDismissed(true)
                setUsageOpen(false)
                try {
                  localStorage.setItem(USAGE_DISMISSED_KEY, '1')
                } catch {
                  // 忽略。
                }
              }}
              onRun={(key) => {
                setUsageOpen(false)
                if (key === 'attach') void pickDocument()
                else if (key === 'screenshot') setCaptureMenuOpen(true)
                else if (key === 'document') void openDocumentPanel()
                else if (key === 'palette') setPaletteOpen(true)
                else void openSettings('skillmarket')
              }}
            />
          ) : null}
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('调整侧栏宽度')}
            title={t('拖动调整宽度，双击恢复默认')}
            onPointerDown={startSidebarResize}
            onDoubleClick={() => setSidebarWidth(280)}
          />
        </aside>
      ) : null}
      <div className="main">
        <header className="topbar">
          <div className="brand">
            <h1 className="brand-title">X-CODE</h1>
            <span className="brand-status" title={t(STATUS_LABEL[status])}>
              <span className={`status-dot ${status === 'ready' ? 'ready' : ''}`} aria-hidden="true" />
              {t(STATUS_LABEL[status])}
            </span>
          </div>
          <span className="spacer" />

          <div className="menu-anchor">
            <button
              className="model-chip"
              onClick={() => {
                setSettingsOpen(false)
                setTaskModeMenuOpen(false)
                setToolsMenuOpen(false)
                setModelMenuOpen((open) => {
                  if (!open) {
                    setModelQuery('')
                    setModelKeyIndex(-1)
                  }
                  return !open
                })
              }}
            >
              <span>{currentTitle}</span>
              {appState?.demo ? <span className="chip-tag">{t('演示')}</span> : null}
              <span className={`caret ${modelMenuOpen ? 'open' : ''}`} aria-hidden="true">
                <ChevronIcon />
              </span>
            </button>
            {modelMenuOpen ? (
              <>
                <div className="menu-scrim" onClick={() => setModelMenuOpen(false)} aria-hidden="true" />
                <div className="model-menu" role="menu">
                  <div className="model-scan">
                    <button className="btn btn-quiet" onClick={() => void scanLocalModels()}>
                      {t('扫描本地模型')}
                    </button>
                    <span className="model-scan-hint">{modelScan ?? t('支持 Ollama 与 LM Studio')}</span>
                  </div>
                  <div className="model-search">
                    <input
                      className="settings-input"
                      data-testid="model-search"
                      placeholder={t('搜索模型')}
                      value={modelQuery}
                      onChange={(event) => {
                        setModelQuery(event.target.value)
                        setModelKeyIndex(-1)
                      }}
                      onKeyDown={(event) => {
                        if (isImeEvent(event)) return
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          if (keyboardModels.length === 0) return
                          const delta = event.key === 'ArrowDown' ? 1 : -1
                          setModelKeyIndex((current) => {
                            const next = current + delta
                            if (next < 0) return keyboardModels.length - 1
                            if (next >= keyboardModels.length) return 0
                            return next
                          })
                          return
                        }
                        if (event.key === 'Enter' && keyboardModels.length > 0) {
                          if (isImeEnter(event)) return
                          event.preventDefault()
                          void chooseModel(keyboardModels[modelKeyIndex] ?? keyboardModels[0]!)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setModelMenuOpen(false)
                        }
                      }}
                    />
                  </div>
                  <div className="model-list">
                    {activeModel ? (
                      <>
                        <div className="model-group pinned">{t('当前模型')}</div>
                        {renderModelItem(activeModel, true)}
                      </>
                    ) : null}
                    {localModelOptions.length > 0 ? (
                      <>
                        <div className="model-group">
                          <span>{t('本地模型')}</span>
                          <span className="model-group-count">{localModelOptions.length}</span>
                        </div>
                        {localModelOptions.map((model) => renderModelItem(model, true))}
                      </>
                    ) : null}
                    {providerGroups.map((group) => (
                      <Fragment key={group.provider}>
                        <div className="model-group">
                          <span>{providerDisplayName(group.provider)}</span>
                          <span className="model-group-count">{group.models.length}</span>
                        </div>
                        {group.models.map((model) => renderModelItem(model))}
                      </Fragment>
                    ))}
                    {filteredModels.length === 0 ? <div className="menu-hint">{t('没有匹配的模型')}</div> : null}
                  </div>
                  {appState?.demo ? (
                    <div className="menu-hint">
                      {t('未配置 API Key。打开「设置 → 模型与密钥」配置后即可使用真实模型。')}
                    </div>
                  ) : null}
                  <div className="model-custom">
                    <input
                      className="settings-input"
                      placeholder={t('自定义模型 ID，如 custom:my-model')}
                      value={customModelInput}
                      onChange={(event) => setCustomModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (isImeEnter(event)) return
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void activateCustomModel()
                        }
                      }}
                    />
                    <button className="btn" onClick={() => void activateCustomModel()}>
                      {t('使用')}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="menu-anchor">
            <button
              className="btn mode-chip"
              data-testid="task-mode-chip"
              onClick={() => {
                setModelMenuOpen(false)
                setToolsMenuOpen(false)
                setTaskModeMenuOpen((open) => !open)
              }}
            >
              {t(TASK_MODE_LABEL[taskMode])}
              <span className={`caret ${taskModeMenuOpen ? 'open' : ''}`} aria-hidden="true">
                <ChevronIcon />
              </span>
            </button>
            {taskModeMenuOpen ? (
              <>
                <div className="menu-scrim" onClick={() => setTaskModeMenuOpen(false)} aria-hidden="true" />
                <div className="mode-menu" role="menu" data-testid="task-mode-menu">
                  {TASK_MODES.map((mode) => (
                    <button
                      key={mode}
                      className={`mode-item ${mode === taskMode ? 'active' : ''}`}
                      onClick={() => void chooseTaskMode(mode)}
                    >
                      <span className="mode-item-label">{t(TASK_MODE_LABEL[mode])}</span>
                      <span className="mode-item-desc">{t(TASK_MODE_DESCRIPTION[mode])}</span>
                    </button>
                  ))}
                  <div className="mode-menu-note">{t('模式只调整回答侧重点，不限制可用工具。')}</div>
                </div>
              </>
            ) : null}
          </div>

          <div className="topbar-actions">
            <button
              className={`icon-btn ${sidebarOpen ? 'active' : ''}`}
              data-testid="sidebar-toggle"
              title={t('侧栏')}
              aria-label={t('侧栏')}
              onClick={() => void toggleSidebar()}
            >
              <SidebarIcon />
            </button>
            <button
              className={`icon-btn ${goalOpen ? 'active' : ''}`}
              data-testid="goal-toggle"
              title={t('目标循环')}
              aria-label={t('目标循环')}
              onClick={() => {
                setModelMenuOpen(false)
                setSettingsOpen(false)
                setTaskModeMenuOpen(false)
                setToolsMenuOpen(false)
                setGoalOpen(true)
              }}
            >
              <GoalIcon />
              {goal && ['active', 'paused', 'blocked', 'max_turns'].includes(goal.status) ? (
                <span className={`goal-dot ${goal.status === 'active' ? 'active' : ''}`} aria-hidden="true" />
              ) : null}
            </button>
            <button
              className={`icon-btn ${inspectorTab === 'outline' ? 'active' : ''}`}
              data-testid="outline-toggle"
              title={t('对话目录')}
              aria-label={t('对话目录')}
              onClick={() => {
                setModelMenuOpen(false)
                setSettingsOpen(false)
                setTaskModeMenuOpen(false)
                setToolsMenuOpen(false)
                toggleInspector('outline')
              }}
            >
              <OutlineIcon />
            </button>
            <button
              className={`icon-btn ${terminalOpen ? 'active' : ''}`}
              data-testid="terminal-toggle"
              title={terminalOpen ? t('收起终端') : t('终端')}
              aria-label={t('终端')}
              onClick={() => {
                setModelMenuOpen(false)
                setSettingsOpen(false)
                setTaskModeMenuOpen(false)
                setToolsMenuOpen(false)
                toggleInspector('terminal')
              }}
            >
              <TerminalIcon />
            </button>
            <button
              className="icon-btn"
              data-testid="manual-toggle"
              title={t('用户手册')}
              aria-label={t('用户手册')}
              onClick={() => {
                setModelMenuOpen(false)
                setTaskModeMenuOpen(false)
                setToolsMenuOpen(false)
                setManualOpen(true)
              }}
            >
              <HelpIcon />
            </button>
            <button
              className="icon-btn"
              data-testid="settings-toggle"
              title={t('设置')}
              aria-label={t('设置')}
              onClick={() => void openSettings()}
            >
              <SettingsIcon />
            </button>
            <div className="menu-anchor">
              <button
                className={`icon-btn ${toolsMenuOpen ? 'active' : ''}`}
                data-testid="tools-menu-toggle"
                title={t('更多工具')}
                aria-label={t('更多工具')}
                onClick={() => {
                  setModelMenuOpen(false)
                  setTaskModeMenuOpen(false)
                  setToolsMenuOpen((open) => !open)
                }}
              >
                <MoreIcon />
              </button>
              {toolsMenuOpen ? (
                <>
                  <div className="menu-scrim" onClick={() => setToolsMenuOpen(false)} aria-hidden="true" />
                  <div className="tools-menu" role="menu" data-testid="tools-menu">
                    {toolMenuActions.map((action) => (
                      <button
                        key={action.id}
                        className="tools-item"
                        data-testid={action.menuTestId ?? `tools-${action.id}`}
                        onClick={() => {
                          setToolsMenuOpen(false)
                          void action.run()
                        }}
                      >
                        <span className="tools-item-label">
                          {action.menuLabel ?? action.label}
                          {action.id === 'background' && backgroundActive > 0 ? ` · ${backgroundActive}` : ''}
                        </span>
                        {(action.menuHint ?? action.hint) ? (
                          <span className="tools-item-meta">{action.menuHint ?? action.hint}</span>
                        ) : null}
                      </button>
                    ))}
                    <div className="tools-separator" />
                    <div className="tools-display" data-testid="tool-display">
                      <span className="tools-item-label">{t('工具显示')}</span>
                      <div className="settings-segments" role="group" aria-label={t('工具显示')}>
                        {TOOL_DISPLAY_MODES.map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={`settings-tab-inline ${toolDisplayMode === mode ? 'active' : ''}`}
                            data-testid={`tool-display-${mode}`}
                            title={t(TOOL_DISPLAY_HINT[mode])}
                            onClick={() => changeToolDisplayMode(mode)}
                          >
                            {t(TOOL_DISPLAY_LABEL[mode])}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button className="tools-item" data-testid="theme-toggle" onClick={cycleTheme}>
                      <span className="tools-item-label">{t('主题')}</span>
                      <span className="tools-item-meta">
                        {themeSetting === 'light' ? '☀' : themeSetting === 'dark' ? '☾' : '◐'}{' '}
                        {t(themeSetting === 'light' ? '亮' : themeSetting === 'dark' ? '暗' : '跟随')}
                      </span>
                    </button>
                    <button className="tools-item" data-testid="language-toggle" onClick={toggleLanguage}>
                      <span className="tools-item-label">{t('语言')}</span>
                      <span className="tools-item-meta">{language === 'zh' ? '中文' : 'English'}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </header>

        <nav className="tab-bar" data-testid="tab-bar">
          <div className="tab-scroll">
            {tabs.map((sessionId) => {
              const item = sessions.find((session) => session.sessionId === sessionId)
              return (
                <div
                  key={sessionId}
                  className={`tab-item ${sessionId === activeSessionId ? 'active' : ''}`}
                  data-testid="session-tab"
                  data-session-id={sessionId}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    void closeTab(sessionId)
                  }}
                >
                  <button
                    className="tab-label"
                    title={item?.filePath ?? item?.firstPrompt ?? t('新会话')}
                    onClick={() => void activateTab(sessionId)}
                  >
                    {runningSessionIds.has(sessionId) ? <span className="tab-busy" aria-hidden="true" /> : null}
                    <span className="tab-title">{item ? sessionTitle(item) : tabTitles[sessionId] || t('新会话')}</span>
                  </button>
                  <button
                    className="tab-close"
                    title={t('关闭标签页')}
                    aria-label={t('关闭标签页')}
                    onClick={() => void closeTab(sessionId)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          <button
            className="tab-add"
            title={t('新建标签页')}
            aria-label={t('新建标签页')}
            onClick={() => void newSession()}
          >
            ＋
          </button>
          <button
            className="tab-add"
            title={t('将当前会话移到新窗口')}
            aria-label={t('将当前会话移到新窗口')}
            onClick={() => void openInNewWindow(true)}
          >
            ⧉
          </button>
        </nav>

        <div className="workspace-body">
          <div className="conversation">
            {findOpen ? (
              <div className="find-bar" data-testid="find-bar">
                <input
                  autoFocus
                  value={findQuery}
                  placeholder={t('在当前会话中查找…')}
                  onChange={(event) => {
                    setFindQuery(event.target.value)
                    setFindIndex(0)
                  }}
                  onKeyDown={(event) => {
                    if (isImeEvent(event)) return
                    if (event.key === 'Enter') {
                      if (isImeEnter(event)) return
                      event.preventDefault()
                      goFind(event.shiftKey ? -1 : 1)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setFindOpen(false)
                    }
                  }}
                />
                <span className="find-count">
                  {findMatchIds.length > 0 ? `${findActiveIndex + 1} / ${findMatchIds.length}` : t('无匹配')}
                </span>
                <button className="btn btn-quiet" onClick={() => goFind(-1)} title={t('上一个')}>
                  ↑
                </button>
                <button className="btn btn-quiet" onClick={() => goFind(1)} title={t('下一个')}>
                  ↓
                </button>
                <button className="btn btn-quiet" onClick={() => setFindOpen(false)} title={t('关闭')}>
                  ×
                </button>
              </div>
            ) : null}

            <div className="chat-wrap">
              <main className="chat" ref={scrollRef} onScroll={handleChatScroll}>
                {turnBuild.hiddenTurns > 0 ? (
                  <div className="turn-window">
                    <button
                      className="btn btn-quiet"
                      data-testid="load-earlier-turns"
                      onClick={() => {
                        const node = scrollRef.current
                        if (node) turnWindowAnchorRef.current = { height: node.scrollHeight, top: node.scrollTop }
                        setTurnWindow((value) => value + 40)
                      }}
                    >
                      {t('显示更早的 {{count}} 轮', { count: Math.min(40, turnBuild.hiddenTurns) })}
                    </button>
                  </div>
                ) : null}
                {entries.length === 0 && (sessionLoading || appState === null) ? <ChatSkeleton /> : null}
                {entries.length === 0 && !sessionLoading && appState !== null ? (
                  <div className="empty">
                    <p className="empty-title">{t('静候一问')}</p>
                    <p className="empty-sub" data-testid="starter-hint">
                      {starterHint}
                    </p>
                    <div className="mode-suggestions" data-testid="workspace-starters">
                      {starterSuggestions.map((suggestion) => (
                        <button key={suggestion} className="mode-suggestion" onClick={() => setInput(suggestion)}>
                          {suggestion}
                        </button>
                      ))}
                    </div>
                    <div className="empty-actions" data-testid="empty-actions">
                      <button className="btn" onClick={() => setGoalOpen(true)}>
                        {t('新建目标')}
                      </button>
                      <button className="btn" onClick={() => void pickProject()}>
                        {t('选择项目文件夹')}
                      </button>
                      <button className="btn" onClick={() => setManualOpen(true)}>
                        {t('打开用户手册')}
                      </button>
                    </div>
                    {visibleSessions.length > 0 ? (
                      <div className="empty-recent" data-testid="empty-recent">
                        <div className="empty-recent-head">{t('最近会话')}</div>
                        {visibleSessions.slice(0, 3).map((item) => (
                          <button
                            key={item.sessionId}
                            className="empty-recent-item"
                            title={item.filePath}
                            onClick={() => void loadSession(item)}
                          >
                            <span>{sessionTitle(item)}</span>
                            <span className="empty-recent-meta">{sessionTime(item)}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {sessionLoading && entries.length > 0 ? (
                  <div className="chat-loading">
                    <ChatSkeleton turns={1} />
                  </div>
                ) : null}
                <TranscriptEntryProvider
                  value={{
                    busy,
                    now: turnNow,
                    toolDisplayMode,
                    movingTempEntry,
                    shellSandboxEnabled: settings?.shellSandbox.enabled === true,
                    shellSandboxAllowNetwork: settings?.shellSandbox.allowNetwork === true,
                    activeTextEntryId: activeTextEntryId.current,
                    findMatchIds,
                    findActiveId,
                    lastAssistantId,
                    lastUserId,
                    onOpenDocument: (path) => void openDocument(path),
                    onOpenEditor: (path, line) => openInEditor(path, line),
                    onRevertEdit: (toolCallId, entryId) => void revertEdit(toolCallId, entryId),
                    onAllowSandboxNetwork: () => void allowSandboxNetwork(),
                    onRefreshEnvironment: () => void refreshAgentEnvironment(),
                    onOpenToolsSettings: () => void openSettings('tools'),
                    onMoveTempDeliverables: (entryId, files) => void moveTempDeliverables(entryId, files),
                    onOpenImage: (src, name) => setImageLightbox({ src, name }),
                    onRunInTerminal: runInTerminal,
                    onRegenerate: () => void regenerateLast(),
                    onEditLast: beginEditLast,
                  }}
                >
                  {turnItems.map((item) => {
                    if (item.kind === 'divider') {
                      const clock = item.at
                        ? (() => {
                            const date = new Date(item.at)
                            return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
                          })()
                        : ''
                      return (
                        <div className="turn-divider" data-testid="turn-divider" key={item.key}>
                          <span className="turn-divider-label">
                            {t('第 {{turn}} 轮', { turn: item.turn })}
                            {clock ? ` · ${clock}` : ''}
                          </span>
                        </div>
                      )
                    }
                    if (item.kind === 'toggle') {
                      return (
                        <div
                          className="turn-tool-toggle"
                          data-testid="turn-tool-toggle"
                          key={`turn-toggle-${item.key}`}
                        >
                          <span>{t('工具调用 {{count}} 次', { count: item.count })}</span>
                          {item.failures > 0 ? (
                            <span className="tool-failure">{t('{{count}} 个失败', { count: item.failures })}</span>
                          ) : null}
                          <span className="spacer" />
                          <button
                            type="button"
                            className="btn btn-quiet"
                            data-testid="turn-tool-toggle-button"
                            onClick={() => toggleTurnTools(item.key)}
                          >
                            {item.collapsed ? t('展开') : t('收起')}
                          </button>
                        </div>
                      )
                    }
                    const entry = item.entry
                    return <TranscriptEntry key={entry.id} entry={entry} />
                  })}
                </TranscriptEntryProvider>
              </main>
              <PromptRail entries={turnBuild.shownEntries} scrollRef={scrollRef} />
            </div>
            {showScrollBottom ? (
              <button
                className="scroll-bottom"
                title={t('回到底部')}
                aria-label={t('回到底部')}
                onClick={() => {
                  const node = scrollRef.current
                  if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
                  nearBottomRef.current = true
                  setShowScrollBottom(false)
                  setUnseenEntries(0)
                }}
              >
                ↓{unseenEntries > 0 ? ` ${unseenEntries}` : ''}
              </button>
            ) : null}

            {notice ? <div className="notice">{notice}</div> : null}

            {shownTodos.length > 0 ? (
              <div className={`todos ${todosLeaving ? 'leaving' : ''}`} data-testid="todos">
                <span className="todos-title">{t('待办')}</span>
                {shownTodos.map((todo, index) => (
                  <span key={index} className={`todo ${todo.status}`}>
                    <span className="todo-glyph" aria-hidden="true">
                      {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
                    </span>
                    {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  </span>
                ))}
              </div>
            ) : null}

            {report ? (
              <div className="report-shell">
                <pre className="report" aria-label={t('诊断结果')}>
                  {report}
                </pre>
                <div className="report-actions">
                  <button className="btn btn-quiet" onClick={() => window.xcode.copyText(report)}>
                    {t('复制诊断')}
                  </button>
                  <button
                    className="report-close"
                    data-testid="report-close"
                    aria-label={t('关闭结果')}
                    title={t('关闭结果')}
                    onClick={() => setReport(null)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : null}

            <footer className="composer">
              <MentionPalette items={mentionItems} index={mentionIndex} onPick={pickMention} />
              <SlashPalette
                commands={paletteCommands}
                index={paletteIndex}
                paletteRef={slashPaletteRef}
                onRun={runSlashCommand}
              />
              {editArmed ? (
                <EditBadge
                  onCancel={() => {
                    setEditArmed(false)
                    setInput('')
                    setAttachments([])
                  }}
                />
              ) : null}
              {backgroundRunning && backgroundSessionId ? (
                <div className="background-wait" data-testid="background-session">
                  <span>{t('“{{title}}”正在后台运行。', { title: backgroundTitle })}</span>
                  <button className="btn btn-quiet" onClick={() => void activateTab(backgroundSessionId)}>
                    {t('查看')}
                  </button>
                  <button className="btn btn-quiet" onClick={() => void abort(backgroundSessionId)}>
                    {t('停止')}
                  </button>
                </div>
              ) : null}
              {busy && backgroundActive > 0 ? (
                <BackgroundWait count={backgroundActive} queued={queued} onStop={() => void abort()} />
              ) : null}
              <QueuedList
                items={queuedItems}
                onOpenInNewWindow={(index) => void openQueuedInNewWindow(index)}
                onRemove={removeQueued}
                onMove={moveQueued}
                onClear={clearQueued}
              />
              {recording || voiceBusy ? (
                <RecordingBar
                  recording={recording}
                  voiceBusy={voiceBusy}
                  seconds={recordingSeconds}
                  level={audioLevel}
                  onCancel={() => void stopRecording(false)}
                  onFinish={() => void stopRecording(true)}
                />
              ) : null}
              <AttachmentsStrip
                files={attachments}
                onRemove={(file) => setAttachments((current) => current.filter((entry) => entry !== file))}
                onClear={() => setAttachments([])}
                onOpenImage={(src, name) => setImageLightbox({ src, name })}
              />
              {!busy && nextSteps.length > 0 && !nextStepsHidden ? (
                <NextSteps
                  steps={nextSteps}
                  onRun={(prompt) => void submit(prompt)}
                  onDismiss={() => setNextStepsHidden(true)}
                />
              ) : null}
              <ComposerBox
                value={input}
                editorRef={composerRef}
                placeholder={busy ? t('落笔未竟…') : t('写下你的问题，或输入指令…')}
                busy={busy}
                canSend={canSend}
                recording={recording}
                voiceBusy={voiceBusy}
                backgroundActive={backgroundActive}
                captureMenuOpen={captureMenuOpen}
                onComposerChange={({ markdown, text, caret }) => {
                  setInput(markdown)
                  updateMention(text, caret)
                }}
                onComposerKeyDown={(event) => {
                  handleComposerKeyDown(event)
                  return event.defaultPrevented
                }}
                onOpenDocumentPanel={() => void openDocumentPanel()}
                onPickDocument={() => void pickDocument()}
                screens={captureScreens}
                onToggleCaptureMenu={toggleCaptureMenu}
                onCaptureRegion={() => void captureRegion()}
                onCaptureScreen={(displayId) => void captureScreen(displayId)}
                onToggleRecording={toggleRecording}
                onAbort={() => void abort()}
                onSubmit={() => {
                  const prompt = input
                  setInput('')
                  void submit(prompt)
                }}
              />
              <div className="composer-hint">
                {busyForActive && turnActivity ? (
                  <TurnActivityBar
                    inline
                    activity={turnActivity}
                    elapsedMs={Math.max(0, turnNow - turnActivity.startedAt)}
                    idleMs={lastAgentEventAtRef.current ? Math.max(0, turnNow - lastAgentEventAtRef.current) : 0}
                  />
                ) : backgroundRunning ? (
                  <span>{t('“{{title}}”正在另一个标签运行；可切换过去查看或停止。', { title: backgroundTitle })}</span>
                ) : (
                  <span>{busy ? t('Enter 排队 · 停止按钮结束当前任务') : t('Enter 发送 · Shift+Enter 换行')}</span>
                )}
                {!busy && backgroundActive > 0 ? (
                  <button
                    type="button"
                    className="capability-hint background-chip"
                    data-testid="background-idle"
                    onClick={() => setBackgroundOpen(true)}
                  >
                    {t('{{count}} 个后台任务', { count: backgroundActive })} · {t('查看')}
                  </button>
                ) : null}
                <button type="button" className="capability-hint" onClick={() => setPaletteOpen(true)}>
                  {window.xcode.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} {t('全部能力')}
                </button>
                <UsageFooter
                  shellSandbox={settings?.shellSandbox}
                  contextPercent={contextPercent}
                  usedContextTokens={usedContextTokens}
                  contextWindow={contextWindow}
                  usage={usage}
                  queued={queued}
                  onOpenToolsSettings={() => void openSettings('tools')}
                />
              </div>
            </footer>
          </div>

          {inspectorTab ? (
            <Inspector tab={inspectorTab} onTab={openInspector} onClose={closeInspector}>
              {inspectorTab === 'outline' ? <OutlinePanel entries={entries} onJump={jumpToEntry} /> : null}
              {inspectorTab === 'document' ? (
                <DocumentPanel
                  view={documentView}
                  loading={documentLoading}
                  error={documentError}
                  onClose={closeInspector}
                  onReload={() => {
                    const current = documentView?.path
                    if (current) void openDocument(current)
                  }}
                  onAttach={(path) => {
                    setAttachments((current) => [...new Set([...current, path])])
                    closeInspector()
                  }}
                  onAsk={(prompt, path) => {
                    void submit(prompt, false, [path])
                    closeInspector()
                  }}
                  onSummarize={(path) => {
                    void submit(t('请总结这个文件的内容与结构。'), false, [path])
                    closeInspector()
                  }}
                  onOcrPage={ocrDocumentPage}
                  onLoadMore={loadMoreDocumentPages}
                  loadingMore={documentLoadingMore}
                  onForgetOcr={forgetDocumentOcr}
                  documents={documentRecent}
                  onSwitchDocument={switchDocument}
                  onPickDocument={pickDocumentToPreview}
                  onDiff={fetchDocumentDiff}
                  onApplyHunks={applyReviewedHunks}
                  onSaveBaseline={saveDocumentBaseline}
                  focusPage={documentFocusPage}
                />
              ) : null}
              {inspectorTab === 'git' ? (
                <GitPanel
                  status={gitStatusView}
                  loading={gitLoading}
                  error={gitError}
                  selected={gitSelected}
                  diff={gitDiffText}
                  diffTruncated={gitDiffTruncated}
                  busy={false}
                  onRefresh={() => void refreshGit()}
                  onSelect={(path, staged) => void selectGitFile(path, staged)}
                  onRewind={() => openRewind('code')}
                  onOpenEditor={(path, line) => openInEditor(path, line)}
                  onClose={closeInspector}
                />
              ) : null}
              {inspectorTab === 'checks' ? (
                <ChecksPanel
                  checks={projectChecks}
                  results={checkResults}
                  autoChecks={checkAuto}
                  autoFix={checkAutoFix}
                  loading={checksLoading}
                  error={checksError}
                  onRefresh={() => void refreshChecks()}
                  onRun={() => void runChecksNow()}
                  onToggleAuto={() => void toggleAutoChecks()}
                  onToggleAutoFix={() => void toggleAutoFixChecks()}
                  onFix={fixFromChecks}
                  onClose={closeInspector}
                />
              ) : null}
              {inspectorTab === 'file' ? (
                <Suspense fallback={null}>
                  <FilePanel
                    workspace={appState?.workspace ?? settings?.workspace ?? ''}
                    initialPath={fileInitialPath}
                    onOpenEditor={(path, line) => openInEditor(path, line)}
                    onOpenDocument={(path) => void openDocument(path)}
                    onClose={() => {
                      closeInspector()
                      setFileInitialPath(null)
                    }}
                  />
                </Suspense>
              ) : null}
              {inspectorTab === 'terminal' ? (
                <aside className="terminal-drawer embedded" data-testid="terminal-shell" aria-label={t('终端')}>
                  <header className="drawer-head">
                    <span className="drawer-seal" aria-hidden="true">
                      端
                    </span>
                    <div className="drawer-titles">
                      <div className="drawer-title">{t('终端')}</div>
                      <div className="drawer-sub">PTY · runtime process</div>
                    </div>
                    <span className="spacer" />
                    <button className="btn btn-quiet" onClick={closeInspector}>
                      {t('关闭')}
                    </button>
                  </header>
                  <Suspense fallback={null}>
                    <TerminalPanel
                      cwd={appState?.workspace ?? settings?.workspace ?? ''}
                      command={terminalCommand}
                      onCommandConsumed={() => setTerminalCommand(null)}
                    />
                  </Suspense>
                </aside>
              ) : null}
            </Inspector>
          ) : null}
        </div>
      </div>

      {approval ? (
        <ApprovalCard
          approval={approval}
          queueCount={approvals.length}
          backgroundRunning={backgroundRunning}
          questionDraft={questionDraft}
          onQuestionDraft={setQuestionDraft}
          onRespond={(request, decision) => void respondApproval(request, decision)}
        />
      ) : null}

      {settingsOpen && settings ? (
        <Suspense fallback={<SettingsSkeleton />}>
          <SettingsPanel
            settings={settings}
            onSettings={setSettings}
            onState={setAppState}
            onClose={() => setSettingsOpen(false)}
            theme={themeSetting}
            onTheme={setThemeSetting}
            onLanguage={(next) => void i18n.changeLanguage(next)}
            workspace={appState?.workspace ?? ''}
            onOpenDocument={(path, page) => void openDocument(path, page)}
            activeTab={settingsTab ?? undefined}
            onTabChange={setSettingsTab}
            onUsage={(key) => markUsage(key)}
            onSessionsChanged={() => void refreshSessions()}
          />
        </Suspense>
      ) : null}
      {backgroundOpen ? <BackgroundPanel onClose={() => setBackgroundOpen(false)} /> : null}
      {manualOpen ? (
        <Suspense fallback={null}>
          <ManualPanel onClose={() => setManualOpen(false)} />
        </Suspense>
      ) : null}
      {rewindOpen ? (
        <RewindPanel
          initialMode={rewindInitialMode}
          onClose={() => setRewindOpen(false)}
          onRewound={(view, mode) => {
            applySessionView(view)
            setRewindOpen(false)
            const label = mode === 'both' ? t('代码与对话') : mode === 'code' ? t('代码') : t('对话')
            setReport(t('已回退到检查点（{{target}}）。', { target: label }))
            void refreshSessions()
            void refreshState()
          }}
        />
      ) : null}
      {goalOpen ? <GoalPanel goal={goal} onGoal={setGoal} onClose={() => setGoalOpen(false)} /> : null}
      {contextSearchOpen ? (
        <ContextSearchPanel
          onClose={() => setContextSearchOpen(false)}
          onOpenPath={(path, line) => openInEditor(path, line)}
          onOpenDocument={(path, page) => void openDocument(path, page)}
          onOpenSession={(sessionId) => void openSessionById(sessionId)}
        />
      ) : null}
      <CommandPalette
        key={paletteOpen ? 'palette-open' : 'palette-closed'}
        open={paletteOpen}
        actions={paletteActions}
        sessions={sessions}
        commands={commandsWithHelp}
        onSession={(item) => void loadSession(item)}
        onClose={() => setPaletteOpen(false)}
      />
      {sessionMenu && sessionMenuItem ? (
        <>
          <div className="session-menu-scrim" onClick={() => setSessionMenu(null)} />
          <div
            className="session-menu"
            data-testid="session-menu"
            role="menu"
            style={{ left: sessionMenu.x, top: sessionMenu.y }}
          >
            <button
              type="button"
              data-testid="session-menu-pin"
              onClick={() => {
                setSessionMenu(null)
                void toggleSessionPinned(sessionMenuItem)
              }}
            >
              {sessionMenuItem.pinned ? t('取消置顶') : t('置顶')}
            </button>
            <button
              type="button"
              data-testid="session-menu-archive"
              onClick={() => {
                setSessionMenu(null)
                void toggleSessionArchived(sessionMenuItem)
              }}
            >
              {sessionMenuItem.archived ? t('取消归档') : t('归档')}
            </button>
            <button
              type="button"
              data-testid="session-menu-rename"
              onClick={() => {
                setSessionMenu(null)
                setRenaming({ filePath: sessionMenuItem.filePath, value: sessionTitle(sessionMenuItem) })
              }}
            >
              {t('重命名')}
            </button>
            <button
              type="button"
              data-testid="session-menu-copy-path"
              onClick={() => {
                setSessionMenu(null)
                window.xcode.copyText(sessionMenuItem.filePath)
                setNotice(t('已复制会话路径'))
                setTimeout(() => setNotice(null), 1_800)
              }}
            >
              {t('复制会话路径')}
            </button>
            <button
              type="button"
              data-testid="session-menu-copy-id"
              onClick={() => {
                setSessionMenu(null)
                window.xcode.copyText(sessionMenuItem.sessionId)
                setNotice(t('已复制会话 ID'))
                setTimeout(() => setNotice(null), 1_800)
              }}
            >
              {t('复制会话 ID')}
            </button>
            <button
              type="button"
              className="danger"
              data-testid="session-menu-delete"
              onClick={() => {
                setSessionMenu(null)
                setDeletingSession(sessionMenuItem.filePath)
              }}
            >
              {t('删除')}
            </button>
          </div>
        </>
      ) : null}
      {workspaceGuard ? (
        <div className="modal-scrim" onClick={cancelWorkspaceGuard}>
          <div
            className="shortcut-card"
            data-testid="workspace-guard"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shortcut-head">
              <span className="drawer-seal" aria-hidden="true">
                界
              </span>
              <div className="drawer-title">{t('工作区提醒')}</div>
              <span className="spacer" />
              <button className="btn btn-quiet" onClick={cancelWorkspaceGuard}>
                {t('取消')}
              </button>
            </div>
            <p className="settings-note">
              {t('当前工作区：{{path}}', { path: appState?.workspace ?? settings?.workspace ?? '' })}
            </p>
            <p className="settings-note">{t('消息引用了工作区外的路径：')}</p>
            <ul className="workspace-guard-paths">
              {workspaceGuard.external.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            <p className="settings-note">{t('仍要在这个工作区执行吗？如需切换工作区，请取消后在侧栏选择项目。')}</p>
            <label className="workspace-guard-off">
              <input
                type="checkbox"
                checked={workspaceGuardOff}
                onChange={(event) => setWorkspaceGuardOff(event.target.checked)}
              />
              {t('本次会话不再提示')}
            </label>
            <div className="branch-confirm-actions">
              <button className="btn btn-quiet" onClick={cancelWorkspaceGuard}>
                {t('取消')}
              </button>
              <button className="btn solid" data-testid="workspace-guard-continue" onClick={continueInCurrentWorkspace}>
                {t('仍在当前工作区执行')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {salvageTarget ? (
        <div className="modal-scrim" onClick={() => setSalvageTarget(null)}>
          <div
            className="shortcut-card"
            data-testid="salvage-dialog"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shortcut-head">
              <span className="drawer-seal" aria-hidden="true">
                复
              </span>
              <div className="drawer-title">{t('会话恢复')}</div>
              <span className="spacer" />
              <button className="btn btn-quiet" disabled={salvageBusy} onClick={() => setSalvageTarget(null)}>
                {t('取消')}
              </button>
            </div>
            <p className="settings-note">
              {t('该会话完整性校验失败，可能已损坏。可以尝试把能读取的消息恢复到一个新会话；原文件不会被修改。')}
            </p>
            <div className="branch-confirm-actions">
              <button
                className="btn"
                data-testid="salvage-confirm"
                disabled={salvageBusy}
                onClick={() => void recoverDamagedSession()}
              >
                {salvageBusy ? t('正在恢复…') : t('尝试修复')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {imageLightbox ? (
        <div
          className="modal-scrim image-lightbox-scrim"
          data-testid="image-lightbox"
          onClick={() => setImageLightbox(null)}
        >
          <figure className="image-lightbox-card" onClick={(event) => event.stopPropagation()}>
            <img src={imageLightbox.src} alt={imageLightbox.name} />
            <figcaption>
              <span className="image-lightbox-name">{imageLightbox.name}</span>
              <span className="spacer" />
              <button className="btn btn-quiet" onClick={() => setImageLightbox(null)}>
                {t('关闭')}
              </button>
            </figcaption>
          </figure>
        </div>
      ) : null}
      {branchOpen ? (
        <div className="modal-scrim" onClick={() => setBranchOpen(false)}>
          <div
            className="branch-card"
            data-testid="branch-picker"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shortcut-head">
              <span className="drawer-seal" aria-hidden="true">
                枝
              </span>
              <div className="drawer-title">{t('分支窗口')}</div>
              <span className="spacer" />
              <button className="btn btn-quiet" onClick={() => setBranchOpen(false)}>
                {t('关闭')}
              </button>
            </div>
            <p className="settings-note">{t('每个分支在独立的 Git worktree 中运行，互不影响。')}</p>
            <input
              className="settings-input"
              data-testid="branch-search"
              autoFocus
              placeholder={t('搜索分支')}
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (isImeEnter(event)) return
                if (event.key === 'Enter' && visibleBranches.length === 1) {
                  event.preventDefault()
                  void openBranchInWindow(visibleBranches[0])
                }
              }}
            />
            <div className="branch-create" data-testid="branch-create">
              <input
                className="settings-input"
                data-testid="branch-new-input"
                placeholder={t('新建分支（从当前 HEAD 创建）')}
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeEnter(event)) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void createBranchInWindow()
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                data-testid="branch-create-button"
                disabled={!newBranchName.trim() || newBranchBusy || branchBusy !== null}
                onClick={() => void createBranchInWindow()}
              >
                {newBranchBusy ? t('创建中…') : t('创建并打开')}
              </button>
            </div>
            <div className="branch-create branch-task-create" data-testid="branch-task-create">
              <input
                className="settings-input"
                data-testid="branch-task-input"
                placeholder={t('按任务创建：描述要做什么')}
                value={newTaskPrompt}
                onChange={(event) => setNewTaskPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeEnter(event)) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void createBranchInWindow(newTaskPrompt)
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                data-testid="branch-task-button"
                disabled={!newTaskPrompt.trim() || newBranchBusy || branchBusy !== null}
                onClick={() => void createBranchInWindow(newTaskPrompt)}
              >
                {newBranchBusy ? t('创建中…') : t('按任务创建')}
              </button>
            </div>
            <p className="settings-note">{t('会创建独立 worktree，并在新窗口直接开始这个任务。')}</p>
            <div className="branch-parent">
              <button
                type="button"
                className="btn btn-quiet"
                data-testid="branch-parent-button"
                disabled={newBranchBusy || branchBusy !== null}
                onClick={() => void chooseBranchParent()}
              >
                {t('选择父目录')}
              </button>
              <span className="branch-parent-path" title={newBranchParent || undefined}>
                {newBranchParent || t('默认：仓库旁边的目录')}
              </span>
              {newBranchParent ? (
                <button
                  type="button"
                  className="attachment-remove"
                  title={t('清除')}
                  onClick={() => setNewBranchParent('')}
                >
                  ×
                </button>
              ) : null}
            </div>
            {branchError ? <p className="branch-error">{branchError}</p> : null}
            <div className="branch-list">
              {branchView === null && !branchError ? <div className="menu-hint">{t('正在读取分支…')}</div> : null}
              {branchView && !branchView.isRepo ? (
                <div className="menu-hint">{t('当前工作区不是 Git 仓库')}</div>
              ) : null}
              {branchView?.isRepo && visibleBranches.length === 0 ? (
                <div className="menu-hint">{t('没有匹配的分支')}</div>
              ) : null}
              {visibleBranches.map((branch) => {
                const sameWindow = sameWorkspacePath(branch.worktreePath, appState?.workspace)
                const worktreePath = branch.worktreePath
                return (
                  <div className="branch-entry" key={branch.name}>
                    <button
                      className={`branch-row ${sameWindow ? 'active' : ''}`}
                      data-testid="branch-row"
                      data-branch={branch.name}
                      disabled={sameWindow || branchBusy !== null || removeWorktree !== null || newBranchBusy}
                      title={worktreePath ?? (branch.remote ? branch.name : t('将新建 worktree'))}
                      onClick={() => void openBranchInWindow(branch)}
                    >
                      <span className="branch-row-head">
                        <span className="branch-row-name">{branch.name}</span>
                        {branch.current ? <span className="branch-badge current">{t('当前分支')}</span> : null}
                        {branch.remote ? <span className="branch-badge muted">{t('远端')}</span> : null}
                        {branch.remote ? null : sameWindow ? (
                          <span className="branch-badge current">{t('当前窗口')}</span>
                        ) : worktreePath ? (
                          <span className="branch-badge">{t('已有 worktree')}</span>
                        ) : (
                          <span className="branch-badge muted">{t('新建 worktree')}</span>
                        )}
                        {branchBusy === branch.name ? <span className="branch-row-busy">{t('准备中…')}</span> : null}
                      </span>
                      {worktreePath ? <span className="branch-row-path">{worktreePath}</span> : null}
                    </button>
                    {branch.removable && worktreePath && !branch.remote ? (
                      <button
                        className="branch-remove"
                        data-testid="branch-remove"
                        data-branch={branch.name}
                        title={t('移除 worktree')}
                        disabled={branchBusy !== null || removeWorktree !== null}
                        onClick={() => {
                          setRemoveWorktree({ path: worktreePath, branch: branch.name })
                          setRemoveWorktreeError(null)
                        }}
                      >
                        {t('移除')}
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {removeWorktree ? (
              <div className="branch-confirm" data-testid="worktree-remove-confirm">
                <div className="branch-confirm-text">
                  {t('移除 worktree {{path}}？', { path: removeWorktree.path })}
                </div>
                <p className="settings-note">{t('未提交的改动会阻止移除；强制移除会丢弃这些改动。')}</p>
                {removeWorktreeError ? <p className="branch-error">{removeWorktreeError}</p> : null}
                <div className="branch-confirm-actions">
                  <button
                    className="btn btn-quiet"
                    disabled={removeWorktreeBusy}
                    onClick={() => {
                      setRemoveWorktree(null)
                      setRemoveWorktreeError(null)
                    }}
                  >
                    {t('取消')}
                  </button>
                  <button
                    className="btn danger"
                    data-testid="worktree-remove-confirm-button"
                    disabled={removeWorktreeBusy}
                    onClick={() => void removeWorktreeNow(false)}
                  >
                    {removeWorktreeBusy ? t('正在移除…') : t('确认移除')}
                  </button>
                  {removeWorktreeError?.includes('未提交') ? (
                    <button
                      className="btn danger"
                      data-testid="worktree-remove-force-button"
                      disabled={removeWorktreeBusy}
                      onClick={() => void removeWorktreeNow(true)}
                    >
                      {t('强制移除（丢弃改动）')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="branch-footer">
              <button
                className="btn btn-quiet"
                data-testid="worktree-prune-button"
                disabled={pruneBusy || branchBusy !== null || removeWorktree !== null}
                onClick={() => void pruneWorktreeRecords()}
              >
                {pruneBusy ? t('清理中…') : t('清理失效 worktree')}
              </button>
              <span className="spacer" />
              <span className="settings-note">{t('移除 worktree 不会删除分支。')}</span>
            </div>
          </div>
        </div>
      ) : null}
      {shortcutSheetOpen ? (
        <div className="modal-scrim" onClick={() => setShortcutSheetOpen(false)}>
          <div
            className="shortcut-card"
            data-testid="shortcut-sheet"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shortcut-head">
              <span className="drawer-seal" aria-hidden="true">
                键
              </span>
              <div className="drawer-title">{t('键盘快捷键')}</div>
              <span className="spacer" />
              <button className="btn btn-quiet" onClick={() => setShortcutSheetOpen(false)}>
                {t('关闭')}
              </button>
            </div>
            <div className="shortcut-list">
              {(
                [
                  ['K', t('命令面板')],
                  ['N', t('新建会话')],
                  ['T', t('新建标签页')],
                  ['1–9', t('切换到第 N 个标签')],
                  ['⇧[', t('上一个标签')],
                  ['⇧]', t('下一个标签')],
                  ['⇧E', t('复制上一条回复')],
                  ['⇧N', t('新建窗口')],
                  ['⇧F', t('搜索会话')],
                  ['⇧D', t('文档面板')],
                  ['F', t('在当前会话中查找')],
                  [',', t('打开设置')],
                  ['+', t('放大界面')],
                  ['-', t('缩小界面')],
                  ['0', t('重置缩放')],
                  ['?', t('快捷键说明')],
                  ['Enter', t('发送消息')],
                  ['Shift+Enter', t('换行')],
                  ['Esc', t('关闭浮层')],
                ] as Array<[string, string]>
              ).map(([key, label]) => {
                const plain = key === '?' || key === 'Esc' || key === 'Enter' || key === 'Shift+Enter'
                return (
                  <div className="shortcut-row" key={key}>
                    <kbd>{plain ? key : window.xcode.platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`}</kbd>
                    <span>{label}</span>
                  </div>
                )
              })}
            </div>
            <p className="settings-note">{t('在文本框中输入时，? 与单键快捷键不会触发；带修饰键的快捷键始终可用。')}</p>
          </div>
        </div>
      ) : null}
      {settings && !settings.onboarded && !onboardingDismissed && (!isUiSmoke || forcedOnboarding) && !wantsSettings ? (
        <Suspense fallback={null}>
          <Onboarding
            settings={settings}
            theme={themeSetting}
            language={language}
            onTheme={setThemeSetting}
            onLanguage={(next) => void i18n.changeLanguage(next)}
            onSettings={setSettings}
            onDone={() => {
              setOnboardingDismissed(true)
              void refreshSettings()
              void refreshState()
              void refreshSessions()
            }}
            onSkip={() => {
              setOnboardingDismissed(true)
              void window.xcode
                .request({ id: crypto.randomUUID(), method: 'settings:set-onboarded', params: { value: true } })
                .then(() => refreshSettings())
            }}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
