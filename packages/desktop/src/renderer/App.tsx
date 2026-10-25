import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AppState,
  ApprovalRequestEvent,
  BranchInfoView,
  BranchListView,
  CompactResult,
  CustomCommandView,
  DocumentDiffView,
  DocumentPageView,
  DocumentRecentItem,
  DocumentView,
  FileEditView,
  GitStatusView,
  LoadedSessionView,
  ModelOption,
  ProjectCheckResultView,
  ProjectCheckView,
  RewindResultView,
  RuntimeEvent,
  SessionAttachmentView,
  SessionListItem,
  SessionSearchResult,
  SettingsActionResult,
  SettingsSnapshot,
  SmokeReport,
  SubAgentView,
  TextReport,
  TodoView,
  UsageView,
  WorkspaceFileItem,
  WorkspaceInsightsView,
  WorkspaceList,
  WorkspaceListItem,
} from '../shared/protocol.js'
import { BackgroundPanel } from './BackgroundPanel.js'
import { ChecksPanel } from './ChecksPanel.js'
import { CommandPalette } from './CommandPalette.js'
import { DocumentPanel } from './DocumentPanel.js'
import { GitPanel } from './GitPanel.js'
import { Inspector } from './Inspector.js'
import type { InspectorTab } from './Inspector.js'
import { CopyButton, MarkdownView } from './MarkdownView.js'
import { RewindPanel } from './RewindPanel.js'
import {
  AttachIcon,
  BranchIcon,
  CaptureIcon,
  ChevronIcon,
  DocumentIcon,
  HelpIcon,
  MicIcon,
  MoreIcon,
  RegionIcon,
  SendIcon,
  SettingsIcon,
  SidebarIcon,
  StopIcon,
  TerminalIcon,
} from './icons.js'
import { base64FromBuffer, isImageAttachment } from './media.js'
import { detectMention, insertMention } from './mention.js'
import { createPaletteActions } from './palette-actions.js'
import { createSlashCommands } from './slash-commands.js'
import type { SlashCommand } from './slash-commands.js'
import { applyTheme, storedTheme, watchSystemTheme } from './theme.js'
import type { ThemeSetting } from './theme.js'
import { forcedOnboarding, isUiSmoke, runUiSmoke } from './ui-smoke.js'
import { encodeWav } from './wav.js'

const SettingsPanel = lazy(() => import('./SettingsPanel.js').then((module) => ({ default: module.SettingsPanel })))
const FilePanel = lazy(() => import('./FilePanel.js').then((module) => ({ default: module.FilePanel })))
const TerminalPanel = lazy(() => import('./TerminalPanel.js').then((module) => ({ default: module.TerminalPanel })))
const Onboarding = lazy(() => import('./Onboarding.js').then((module) => ({ default: module.Onboarding })))
const ManualPanel = lazy(() => import('./ManualPanel.js').then((module) => ({ default: module.ManualPanel })))

if (isUiSmoke) {
  try {
    // Smoke runs share Electron's localStorage with the real app; keep their
    // checklist state under separate keys.
    localStorage.removeItem('xcode.smoke.usage.v1')
    localStorage.removeItem('xcode.smoke.usage.dismissed')
  } catch {
    // Smoke-only reset.
  }
}
const wantsSettings = new URLSearchParams(window.location.search).has('settings')
const wantsSlashDemo = new URLSearchParams(window.location.search).has('slash')

function formatContextTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

const imagePreviewCache = new Map<string, string>()

function attachmentName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function AttachmentImage({
  file,
  variant,
  onOpen,
}: {
  file: string
  variant: 'chip' | 'message'
  onOpen: (src: string, name: string) => void
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(() => imagePreviewCache.get(file) ?? null)
  const [failed, setFailed] = useState(false)
  const name = attachmentName(file)
  useEffect(() => {
    if (src || failed) return
    let cancelled = false
    void window.xcode
      .request({
        id: crypto.randomUUID(),
        method: 'app:image-preview',
        params: { path: file },
      })
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setFailed(true)
          return
        }
        const dataUrl = (response.result as { dataUrl: string }).dataUrl
        imagePreviewCache.set(file, dataUrl)
        setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [file, src, failed])
  if (failed) {
    return <span className="attachment-image-fallback">{name}</span>
  }
  if (!src) {
    return <span className={`attachment-image-loading ${variant}`} aria-label={name} />
  }
  if (variant === 'chip') {
    return (
      <button type="button" className="attachment-thumb-button" title={name} onClick={() => onOpen(src, name)}>
        <img className="attachment-thumb" src={src} alt={name} loading="lazy" />
      </button>
    )
  }
  return (
    <button type="button" className="message-attachment" title={name} onClick={() => onOpen(src, name)}>
      <img src={src} alt={name} loading="lazy" />
      <span>{name}</span>
    </button>
  )
}

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'error'

interface Entry {
  id: string
  role: Role
  text: string
  turnId?: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  toolOutput?: string
  toolProgress?: string
  diff?: FileEditView
  reverted?: boolean
  subagent?: SubAgentView
  attachments?: string[]
  attachmentViews?: SessionAttachmentView[]
}

type TurnRenderItem =
  | { kind: 'entry'; entry: Entry }
  | { kind: 'toggle'; key: string; count: number; failures: number; collapsed: boolean }

const ROLE_LABEL: Record<Role, string> = {
  user: '你',
  assistant: 'X-CODE',
  tool: '工具',
  system: '系统',
  error: '错误',
}

const TASK_MODES = ['coding', 'writing', 'research', 'office'] as const
type TaskMode = (typeof TASK_MODES)[number]

const TASK_MODE_LABEL: Record<TaskMode, string> = {
  coding: '编程',
  writing: '写作',
  research: '科研',
  office: '办公',
}

const TASK_MODE_DESCRIPTION: Record<TaskMode, string> = {
  coding: '代码、测试与 diff 优先',
  writing: '结构、语气与文稿优先',
  research: '资料、引用与不确定性优先',
  office: '文档、表格与导出优先',
}

const TASK_MODE_TEMPLATE: Record<TaskMode, { hint: string; suggestions: string[] }> = {
  coding: {
    hint: '描述要实现的功能、要修的 bug，或粘贴报错。',
    suggestions: ['分析这个仓库并给出改进建议', '帮我修一个 bug', '写一个自动化脚本'],
  },
  writing: {
    hint: '说说你想写什么，或粘贴需要润色的文字。',
    suggestions: ['把要点扩写成文章', '润色这段文字', '生成一份文章大纲'],
  },
  research: {
    hint: '提出研究问题，或给我论文与资料。',
    suggestions: ['总结这篇论文', '对比几种方法的优缺点', '整理一份文献综述提纲'],
  },
  office: {
    hint: '说说要处理的文档、表格或汇报任务。',
    suggestions: ['总结这份 PPT', '按部门汇总这张表', '把 Markdown 导出为 PDF'],
  },
}

function normalizeTaskMode(value: string | undefined): TaskMode {
  return (TASK_MODES as readonly string[]).includes(value ?? '') ? (value as TaskMode) : 'coding'
}

const STATUS_LABEL = {
  starting: '初启',
  ready: '运转中',
  offline: '离线',
} as const

const TOOL_STATUS_LABEL: Record<NonNullable<Entry['toolStatus']>, string> = {
  pending: '等待',
  running: '执行中',
  completed: '完成',
  denied: '已拒绝',
  error: '失败',
}

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const value =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.path as string) ??
    (input.url as string) ??
    ''
  return value.length > 90 ? `${value.slice(0, 87)}…` : value
}

function sessionTitle(item: SessionListItem): string {
  return item.name || item.firstPrompt || item.sessionId
}

function sessionTime(item: SessionListItem): string {
  try {
    return new Date(item.mtime).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function DiffView({
  diff,
  reverted,
  onRevert,
  onOpenEditor,
}: {
  diff: FileEditView
  reverted?: boolean
  onRevert?: () => void
  onOpenEditor?: (path: string, line?: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const lines =
    diff.isCreate && diff.content ? diff.content.split('\n').slice(0, 14) : diff.hunks.flatMap((hunk) => hunk.lines)
  return (
    <div className="diff">
      <div className="diff-head">
        <button
          type="button"
          className="diff-path diff-path-button"
          title={t('在编辑器中打开')}
          onClick={() => onOpenEditor?.(diff.filePath, diff.hunks[0]?.newStart ?? 1)}
        >
          {diff.filePath}
        </button>
        <span className="diff-counts">
          +{diff.additions} −{diff.removals}
        </span>
        {reverted ? <span className="diff-reverted">{t('已回退')}</span> : null}
        {onRevert && !reverted ? (
          <button className="session-action" onClick={onRevert}>
            {t('回退这次编辑')}
          </button>
        ) : null}
      </div>
      <div className="diff-body">
        {lines.slice(0, 80).map((line, index) => {
          const sigil = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
          return (
            <div key={index} className={`diff-line ${sigil}`}>
              {line}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function extractSourceUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []
  const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => url.startsWith('https://'))
  return [...new Set(cleaned)].slice(0, 8)
}

function SourceList({ text }: { text: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const urls = extractSourceUrls(text)
  if (urls.length === 0) return null
  return (
    <div className="tool-sources" data-testid="tool-sources">
      <span className="tool-sources-label">{t('来源')}</span>
      {urls.map((url) => {
        let label = url
        try {
          const parsed = new URL(url)
          label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 48)
        } catch {
          // Keep the raw URL.
        }
        return (
          <button
            key={url}
            className="source-chip"
            title={url}
            onClick={() =>
              void window.xcode.request({
                id: crypto.randomUUID(),
                method: 'app:open-external',
                params: { url },
              })
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function SubAgentBlock({ agent }: { agent: SubAgentView }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const statusLabel =
    agent.status === 'running'
      ? t('运行中')
      : agent.status === 'completed'
        ? t('已完成')
        : agent.status === 'aborted'
          ? t('已中止')
          : t('失败')
  return (
    <div className="subagent" data-testid="subagent">
      <button className="subagent-head" onClick={() => setOpen((value) => !value)}>
        <span className="subagent-name">{agent.agentName}</span>
        <span className={`subagent-status ${agent.status}`}>{statusLabel}</span>
        <span className="subagent-meta">
          {agent.turnCount !== undefined ? t('{{count}} 轮', { count: agent.turnCount }) : ''}
          {agent.durationMs !== undefined ? ` · ${(agent.durationMs / 1000).toFixed(1)}s` : ''}
        </span>
        <span className="spacer" />
        <span className="subagent-toggle">{open ? t('收起') : t('展开')}</span>
      </button>
      {agent.description ? <div className="subagent-desc">{agent.description}</div> : null}
      {open ? (
        <div className="subagent-log">
          {agent.log.map((line, index) => (
            <div key={index} className={`subagent-line ${line.kind}`}>
              {line.text}
            </div>
          ))}
          {agent.finalText ? <div className="subagent-final">{agent.finalText}</div> : null}
          {agent.log.length === 0 && !agent.finalText ? (
            <div className="subagent-line text">{t('等待子代理输出…')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function draftStorageKey(sessionId: string | null): string {
  return `xcode.draft.${sessionId ?? 'new'}`
}

const LAST_DOCUMENTS_KEY = 'xcode.lastDocuments'

function readLastDocument(workspace: string): string | null {
  if (!workspace) return null
  try {
    const raw = localStorage.getItem(LAST_DOCUMENTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const value = parsed[workspace]
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

function rememberLastDocument(workspace: string, filePath: string): void {
  if (!workspace || !filePath) return
  try {
    const raw = localStorage.getItem(LAST_DOCUMENTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    parsed[workspace] = filePath
    localStorage.setItem(LAST_DOCUMENTS_KEY, JSON.stringify(parsed))
  } catch {
    // Remembering the last document is a convenience only.
  }
}

function forgetLastDocument(workspace: string, filePath: string): void {
  if (!workspace) return
  try {
    const raw = localStorage.getItem(LAST_DOCUMENTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    if (parsed[workspace] !== filePath) return
    delete parsed[workspace]
    localStorage.setItem(LAST_DOCUMENTS_KEY, JSON.stringify(parsed))
  } catch {
    // Ignore.
  }
}

type UsageKey = 'attach' | 'screenshot' | 'document' | 'palette' | 'skill'

const USAGE_KEY = isUiSmoke ? 'xcode.smoke.usage.v1' : 'xcode.usage.v1'
const USAGE_DISMISSED_KEY = isUiSmoke ? 'xcode.smoke.usage.dismissed' : 'xcode.usage.dismissed'

function readUsage(): Record<UsageKey, boolean> {
  const empty: Record<UsageKey, boolean> = {
    attach: false,
    screenshot: false,
    document: false,
    palette: false,
    skill: false,
  }
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<UsageKey, unknown>>) : {}
    for (const key of Object.keys(empty) as UsageKey[]) empty[key] = parsed[key] === true
  } catch {
    // A corrupt usage record should not block the checklist.
  }
  return empty
}

function writeUsage(usage: Record<UsageKey, boolean>): void {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
  } catch {
    // Ignore quota errors.
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
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

  // Other windows share localStorage; follow theme/language changes made there.
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
  const [status, setStatus] = useState<'starting' | 'ready' | 'offline'>('starting')
  const [report, setReport] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(() =>
    new URLSearchParams(window.location.search).has('terminal') ? 'terminal' : null,
  )
  const openInspector = (tab: InspectorTab): void => setInspectorTab(tab)
  const closeInspector = (): void => setInspectorTab(null)
  const toggleInspector = (tab: InspectorTab): void => setInspectorTab((current) => (current === tab ? null : tab))
  const terminalOpen = inspectorTab === 'terminal'
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const [usageProgress, setUsageProgress] = useState<Record<UsageKey, boolean>>(() => readUsage())
  const [usageDismissed, setUsageDismissed] = useState(() => {
    try {
      return localStorage.getItem(USAGE_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
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
  const [markdownToolsOpen, setMarkdownToolsOpen] = useState(false)
  const [markdownPreview, setMarkdownPreview] = useState(false)
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
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([])
  const [workspaceInsights, setWorkspaceInsights] = useState<WorkspaceInsightsView | null>(null)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set())
  const [tabs, setTabs] = useState<string[]>([])
  const [pendingSession, setPendingSession] = useState<{ sessionId: string; at: number } | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([])
  const [searchingSessions, setSearchingSessions] = useState(false)
  const [renaming, setRenaming] = useState<{ filePath: string; value: string } | null>(null)
  const [deletingSession, setDeletingSession] = useState<string | null>(null)
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
  const [gitBusy, setGitBusy] = useState(false)
  const [projectChecks, setProjectChecks] = useState<ProjectCheckView[]>([])
  const [checkResults, setCheckResults] = useState<ProjectCheckResultView[]>([])
  const [checkAuto, setCheckAuto] = useState(false)
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
  const [modelScan, setModelScan] = useState<string | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  // Keep window titles distinguishable when several workspaces are open.
  useEffect(() => {
    const name = appState?.workspace?.split(/[\\/]/).filter(Boolean).pop()
    document.title = name ? `X-Code · ${name}` : 'X-Code'
  }, [appState?.workspace])
  const [approval, setApproval] = useState<ApprovalRequestEvent | null>(null)
  const [todos, setTodos] = useState<TodoView[]>([])
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [queued, setQueued] = useState(0)
  const [queuedItems, setQueuedItems] = useState<Array<{ prompt: string; attachments: string[] }>>([])
  const [editArmed, setEditArmed] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [captureMenuOpen, setCaptureMenuOpen] = useState(false)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const activeTurn = useRef<string | null>(null)
  const activeTextEntryId = useRef<string | null>(null)
  const busyRef = useRef(false)
  const queueRef = useRef<Array<{ prompt: string; attachments: string[] }>>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nearBottomRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const uiSmokeRan = useRef(false)
  const submitRef = useRef<(prompt: string, alreadyShown?: boolean, attachments?: string[]) => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
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
  const draftKey = draftStorageKey(activeSessionId)

  const append = (entry: Omit<Entry, 'id'> & { id?: string }): void => {
    setEntries((prev) => [...prev, { id: entry.id ?? crypto.randomUUID(), ...entry }])
  }

  const addTab = (sessionId: string): void => {
    setTabs((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]))
  }

  const openSessionFileKey = tabs
    .map((sessionId) => sessions.find((item) => item.sessionId === sessionId)?.filePath)
    .filter((value): value is string => Boolean(value))
    .join('\n')

  // Tell main which session files this window owns so another window cannot
  // load the same transcript and write it concurrently.
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

  /** Show a tab whose session has not been written to disk yet (no messages sent). */
  const activateEmptyTab = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    setEntries([])
    setUsage(null)
    setTodos([])
    setQueued(0)
    queueRef.current = []
    setQueuedItems([])
    setAttachments([])
    setReport(null)
    pendingSessionRef.current = sessionId
    setPendingSession({ sessionId, at: Date.now() })
  }

  const refreshSessions = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:list',
      params: {},
    })
    if (response.ok) setSessions(response.result as SessionListItem[])
  }

  const refreshWorkspaces = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'workspace:list',
      params: {},
    })
    if (response.ok) setWorkspaces((response.result as WorkspaceList).projects)
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
    // Only reset the highlight when the token itself changed. Keyup fires
    // after every arrow-key press too; resetting there would snap the
    // selection back to the first entry.
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
    const next = insertMention(input, mention, file)
    setInput(next.text)
    setMention(null)
    setMentionItems([])
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.setSelectionRange(next.cursor, next.cursor)
      // Keep browsing: picking a directory reopens the menu on its children.
      if (file.isDirectory) updateMention(next.text, next.cursor)
    })
  }

  const applyMarkdown = (kind: 'bold' | 'italic' | 'code' | 'codeBlock' | 'link' | 'list' | 'quote'): void => {
    const element = textareaRef.current
    const start = element?.selectionStart ?? input.length
    const end = element?.selectionEnd ?? input.length
    const selected = input.slice(start, end)
    if (kind === 'list' || kind === 'quote') {
      const prefix = kind === 'list' ? '- ' : '> '
      const lineStart = input.lastIndexOf('\n', start - 1) + 1
      const block = input
        .slice(lineStart, end)
        .split('\n')
        .map((line) => (line.startsWith(prefix) ? line : prefix + line))
        .join('\n')
      const next = input.slice(0, lineStart) + block + input.slice(end)
      const cursor = lineStart + block.length
      setInput(next)
      updateMention(next, cursor)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(cursor, cursor)
      })
      return
    }

    let before = ''
    let after = ''
    let placeholder = ''
    switch (kind) {
      case 'bold':
        before = '**'
        after = '**'
        placeholder = t('粗体')
        break
      case 'italic':
        before = '*'
        after = '*'
        placeholder = t('斜体')
        break
      case 'code':
        before = '`'
        after = '`'
        placeholder = t('行内代码')
        break
      case 'codeBlock':
        before = (start > 0 ? '\n' : '') + '```\n'
        after = '\n```\n'
        placeholder = t('代码块')
        break
      case 'link':
        before = '['
        after = '](https://)'
        placeholder = t('链接')
        break
    }
    const content = selected || placeholder
    const next = input.slice(0, start) + before + content + after + input.slice(end)
    const cursorStart = start + before.length
    const cursorEnd = cursorStart + content.length
    setInput(next)
    updateMention(next, cursorEnd)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(cursorStart, cursorEnd)
    })
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
    // The onboarding overlay needs the settings snapshot on first launch.
    void refreshSettings()
    void refreshWorkspaceInsights()
  }, [])

  useEffect(() => {
    if (appState?.workspace) void refreshWorkspaceInsights()
  }, [appState?.workspace])

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
      // Zoom is a cosmetic preference.
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
      // Defaults to 1.
    }
    const next = reset ? 1 : Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 10) / 10))
    try {
      localStorage.setItem('xcode.zoom', String(next))
    } catch {
      // Still applied for this session.
    }
    void window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:set-zoom',
      params: { factor: next },
    })
  }

  // Per-session composer drafts survive session switches and app restarts.
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
      // Drafts are best-effort.
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
    const off = window.xcode.onEvent((event: RuntimeEvent) => {
      switch (event.type) {
        case 'runtime:ready':
          setStatus('ready')
          append({
            role: 'system',
            text: i18n.t('运行时已连接 · Node {{node}} · Electron {{electron}}', {
              node: event.versions.node ?? '?',
              electron: event.versions.electron ?? '?',
            }),
          })
          break
        case 'app:state':
          setAppState(event.state)
          break
        case 'agent:turn-start':
          activeTurn.current = event.turnId
          activeTextEntryId.current = null
          busyRef.current = true
          setBusy(true)
          setNotice(null)
          setActiveSessionId(event.sessionId)
          addTab(event.sessionId)
          break
        case 'agent:text-delta': {
          const textEntryId = activeTextEntryId.current
          if (!textEntryId) {
            const id = crypto.randomUUID()
            activeTextEntryId.current = id
            append({ id, role: 'assistant', text: event.delta, turnId: activeTurn.current ?? undefined })
          } else {
            setEntries((prev) =>
              prev.map((entry) => (entry.id === textEntryId ? { ...entry, text: entry.text + event.delta } : entry)),
            )
          }
          break
        }
        case 'agent:tool-call':
          // toolSearch is an internal deferred-tool loader; the CLI hides it
          // and the desktop transcript should too.
          if (event.toolName === 'toolSearch') break
          // Text after a tool belongs after this card, not in the earlier
          // assistant bubble that was created before the tool ran.
          activeTextEntryId.current = null
          append({
            id: event.toolCallId,
            role: 'tool',
            text: '',
            turnId: activeTurn.current ?? undefined,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolInput: event.input,
            toolStatus: 'running',
          })
          break
        case 'agent:tool-progress':
          setEntries((prev) =>
            prev.map((entry) =>
              entry.toolCallId === event.toolCallId ? { ...entry, toolProgress: event.message } : entry,
            ),
          )
          break
        case 'agent:tool-result':
          setEntries((prev) =>
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
          setEntries((prev) =>
            prev.map((entry) => (entry.toolCallId === event.toolCallId ? { ...entry, diff: event.payload } : entry)),
          )
          break
        case 'agent:subagent':
          setEntries((prev) =>
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
          setTodos(event.todos)
          break
        case 'agent:usage':
          setUsage(event.usage)
          break
        case 'agent:permission-mode':
          setNotice(event.mode === 'plan' ? i18n.t('计划模式') : null)
          break
        case 'agent:context-compressed':
          activeTextEntryId.current = null
          append({
            role: 'system',
            text: i18n.t('上下文已压缩：{{summary}}', { summary: event.summary.slice(0, 160) }),
            turnId: activeTurn.current ?? undefined,
          })
          setNotice(null)
          break
        case 'agent:compression-progress':
          setNotice(event.description)
          break
        case 'agent:ingest-progress':
          setNotice(event.description)
          break
        case 'agent:attachments':
          setNotice(
            i18n.t('附件已读取：{{files}} 个文件，{{chars}} 字符', {
              files: event.files.length,
              chars: event.textBytes,
            }),
          )
          break
        case 'agent:stream-retry':
          setNotice(
            i18n.t('连接波动，重试 {{attempt}}/{{max}}…', {
              attempt: event.attempt,
              max: event.maxAttempts,
            }),
          )
          break
        case 'agent:turn-end':
          activeTurn.current = null
          activeTextEntryId.current = null
          busyRef.current = false
          setBusy(false)
          setNotice(null)
          setEntries((prev) =>
            prev.map((entry) =>
              entry.subagent?.status === 'running'
                ? {
                    ...entry,
                    subagent: { ...entry.subagent, status: event.reason === 'completed' ? 'completed' : 'aborted' },
                  }
                : entry,
            ),
          )
          setQueued(queueRef.current.length)
          if (queueRef.current.length > 0) {
            const next = queueRef.current.shift()
            setQueued(queueRef.current.length)
            setQueuedItems([...queueRef.current])
            if (next) setTimeout(() => submitRef.current(next.prompt, true, next.attachments), 0)
          }
          void refreshSessions()
          break
        case 'agent:error':
          activeTextEntryId.current = null
          append({ role: 'error', text: event.message, turnId: activeTurn.current ?? undefined })
          busyRef.current = false
          setBusy(false)
          break
        case 'approval:request':
          setApproval(event)
          break
        case 'session:saved':
          setSessions((prev) => [event.item, ...prev.filter((item) => item.sessionId !== event.item.sessionId)])
          setActiveSessionId(event.item.sessionId)
          emptyTabsRef.current.delete(event.item.sessionId)
          if (pendingSessionRef.current === event.item.sessionId) {
            pendingSessionRef.current = null
            setPendingSession(null)
          }
          break
        case 'checks:finished': {
          setCheckResults(event.results)
          const failed = event.results.filter(
            (result) => result.status === 'failed' || result.status === 'timeout',
          ).length
          if (event.auto) {
            append({
              role: 'system',
              text:
                failed > 0 ? i18n.t('自动项目检查失败：{{count}} 项', { count: failed }) : i18n.t('自动项目检查通过'),
            })
            setNotice(failed > 0 ? i18n.t('自动项目检查失败，可在“检查”面板查看') : i18n.t('自动项目检查通过'))
          }
          break
        }
        case 'settings:changed':
          setSettings(event.settings)
          break
        case 'app:settings-changed':
          // Another window changed shared preferences. Coalesce bursts, then
          // reload this window's runtime so keys/tools/plugins stay in sync.
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
      if (settingsSyncTimerRef.current) {
        clearTimeout(settingsSyncTimerRef.current)
        settingsSyncTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node && nearBottomRef.current) node.scrollTop = node.scrollHeight
  }, [entries])

  const handleChatScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    nearBottomRef.current = near
    setShowScrollBottom(!near)
  }

  useEffect(() => {
    const prompt = new URLSearchParams(window.location.search).get('prompt')
    if (!prompt) return
    const timer = setTimeout(() => submitRef.current(prompt), 600)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!wantsSlashDemo) return
    const timer = setTimeout(() => setInput('/'), 800)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!terminalOpen && !settingsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
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
      if (event.key === 'Escape') {
        void respondApproval(approval, approval.kind === 'question' ? '' : 'no')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [approval])

  useEffect(() => {
    if (!isUiSmoke || uiSmokeRan.current) return
    uiSmokeRan.current = true
    void runUiSmoke({ setInput, setAttachments, openDocument, closeInspector, activeSessionId })
  }, [])

  const submit = async (promptText: string, alreadyShown = false, files: string[] = attachments): Promise<void> => {
    const prompt = promptText.trim() || (files.length > 0 ? t('请阅读并分析这些附件。') : '')
    if (!prompt) return
    if (editArmed && !alreadyShown && !busyRef.current) {
      const rewound = await rewindConversation()
      setEditArmed(false)
      if (!rewound) return
    }
    setReport(null)
    if (!alreadyShown) {
      append({ role: 'user', text: prompt, attachments: files })
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
  submitRef.current = (prompt, alreadyShown, files) => void submit(prompt, alreadyShown, files)

  const abort = async (): Promise<void> => {
    await window.xcode.request({ id: crypto.randomUUID(), method: 'agent:abort', params: {} })
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

  const switchProject = async (nextPath: string): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'workspace:switch',
      params: { path: nextPath },
    })
    if (!response.ok) {
      append({ role: 'error', text: t('切换项目失败：{{message}}', { message: response.error.message }) })
      return
    }
    const result = response.result as SettingsActionResult
    setAppState(result.state)
    setSettings(result.settings)
    setEntries([])
    setTodos([])
    setUsage(null)
    setReport(null)
    setQueued(0)
    queueRef.current = []
    setQueuedItems([])
    setAttachments([])
    setActiveSessionId(null)
    setTabs([])
    emptyTabsRef.current.clear()
    pendingSessionRef.current = null
    setPendingSession(null)
    setSessionQuery('')
    setRenaming(null)
    setDeletingSession(null)
    closeInspector()
    await Promise.all([refreshSessions(), refreshWorkspaces()])
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
    // A citation may point past the first batch; load batches until the page
    // is rendered (bounded) before scrolling to it.
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
      const status = statusResponse.result as { autoChecks: boolean; lastResults?: ProjectCheckResultView[] }
      setCheckAuto(status.autoChecks)
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
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'git:status',
      params: {},
    })
    setGitLoading(false)
    if (!response.ok) {
      setGitError(response.error.message)
      return
    }
    setGitError(null)
    setGitStatusView(response.result as GitStatusView)
  }

  const openGitPanel = async (): Promise<void> => {
    openInspector('git')
    setSettingsOpen(false)
    await refreshGit()
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

  const undoGitTurn = async (): Promise<void> => {
    setGitBusy(true)
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'git:undo-turn',
        params: {},
      })
      if (!response.ok) {
        setGitError(response.error.message)
        return
      }
      const result = response.result as { message: string }
      setNotice(t('已撤销本轮修改'))
      setGitSelected(null)
      setGitDiffText(null)
      append({ role: 'system', text: result.message })
      await refreshGit()
    } finally {
      setGitBusy(false)
    }
  }

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
    // No previous document in this workspace: show the recent list inside the
    // panel instead of forcing a file dialog.
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

  const loadSession = async (item: SessionListItem): Promise<void> => {
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
    setEntries(view.messages.map((message) => ({ ...message })))
    setUsage(view.usage)
    setTodos([])
    setQueued(0)
    queueRef.current = []
    setQueuedItems([])
    setAttachments([])
    setActiveSessionId(item.sessionId)
    emptyTabsRef.current.delete(item.sessionId)
    addTab(item.sessionId)
    pendingSessionRef.current = null
    setPendingSession(null)
    try {
      localStorage.setItem('xcode.lastSession', item.filePath)
    } catch {
      // Restoring the last session is best-effort.
    }
    await refreshState()
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
    // A secondary window starts from its requested session (or empty), never
    // from the last session of the previous window.
    const windowParams = new URLSearchParams(window.location.search)
    if (windowParams.get('session') || windowParams.get('fresh')) return
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
  }, [sessions, activeSessionId, loadSession])

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
      emptyTabsRef.current.add(sessionId)
      addTab(sessionId)
      activateEmptyTab(sessionId)
      await refreshSessions()
    }
  }

  const activateTab = async (sessionId: string): Promise<void> => {
    if (sessionId === activeSessionId) return
    if (busyRef.current) {
      setReport(t('请先停止当前回复，再切换标签页。'))
      return
    }
    const item = sessions.find((session) => session.sessionId === sessionId)
    if (item) {
      emptyTabsRef.current.delete(sessionId)
      await loadSession(item)
      return
    }
    if (emptyTabsRef.current.has(sessionId)) {
      activateEmptyTab(sessionId)
      return
    }
    setTabs((prev) => prev.filter((id) => id !== sessionId))
    setReport(t('该标签页的会话已不存在。'))
  }

  const closeTab = async (sessionId: string): Promise<void> => {
    if (busyRef.current && sessionId === activeSessionId) {
      setReport(t('请先停止当前回复，再关闭标签页。'))
      return
    }
    const remaining = tabs.filter((id) => id !== sessionId)
    emptyTabsRef.current.delete(sessionId)
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

  const createBranchInWindow = async (): Promise<void> => {
    const branch = newBranchName.trim()
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
        params: { workspacePath },
      })
      if (!windowResult.ok) {
        setBranchError(t('打开新窗口失败：{{message}}', { message: windowResult.error.message }))
        return
      }
      setBranchOpen(false)
      setNewBranchName('')
      setNewBranchParent('')
      setNotice(t(createdBranch ? '已在新窗口打开新分支 {{branch}}' : '已在新窗口打开分支 {{branch}}', { branch }))
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
  ])

  const applySessionView = (view: LoadedSessionView): void => {
    setEntries(view.messages.map((message) => ({ ...message })))
    setUsage(view.usage)
    setTodos([])
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

  /** Truncate the conversation to just before the most recent user turn.
   *  Files are left untouched; this backs edit-and-resend and regenerate. */
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
    textareaRef.current?.focus()
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

  /** Clipboard images have no filesystem path, so they are handed to the
   *  runtime which writes them under the user data directory. */
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
      textareaRef.current?.focus()
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
    setEntries((prev) => prev.map((entry) => (entry.id === entryId ? { ...entry, reverted: true } : entry)))
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

  const captureScreen = async (): Promise<void> => {
    setCaptureMenuOpen(false)
    setNotice(t('正在截屏…'))
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:capture-screen',
        params: {},
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
      textareaRef.current?.focus()
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
    if (resetActive) {
      setEntries([])
      setUsage(null)
      setTodos([])
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

  const exportCurrentSession = async (format: 'markdown' | 'json' | 'pdf'): Promise<void> => {
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
    setApproval(null)
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

  const paletteActions = createPaletteActions({
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
  const localModelOptions = filteredModels.filter(isLocalModel)
  const remoteModelOptions = filteredModels.filter((model) => !isLocalModel(model))
  const canSend = !busy && (input.trim().length > 0 || attachments.length > 0)
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
  const extraSearchResults =
    sessionQuery.trim().length >= 2
      ? searchResults.filter((result) => !visibleSessions.some((item) => item.filePath === result.filePath))
      : []
  const branchNeedle = branchQuery.trim().toLowerCase()
  const visibleBranches = (branchView?.branches ?? []).filter(
    (branch) => !branchNeedle || branch.name.toLowerCase().includes(branchNeedle),
  )
  const turnGroups: Entry[][] = []
  let currentTurn: Entry[] | undefined
  let currentTurnId: string | undefined
  for (const entry of entries) {
    const startsTurn =
      !currentTurn ||
      entry.role === 'user' ||
      (entry.turnId !== undefined && currentTurnId !== undefined && entry.turnId !== currentTurnId)
    if (startsTurn) {
      const group: Entry[] = []
      turnGroups.push(group)
      currentTurn = group
      currentTurnId = undefined
    }
    if (!currentTurn) continue
    currentTurn.push(entry)
    if (entry.turnId) currentTurnId = entry.turnId
  }
  const turnItems: TurnRenderItem[] = []
  for (const group of turnGroups) {
    const entryKey = group.find((entry) => entry.role === 'user')?.id ?? group[0]?.id ?? 'turn'
    const key = `${activeSessionId ?? 'current'}:${entryKey}`
    const tools = group.filter((entry) => entry.role === 'tool')
    const collapsed = collapsedTurns.has(key)
    const failures = tools.filter((entry) => entry.toolStatus === 'error' || entry.toolStatus === 'denied').length
    let toggleAdded = false
    for (const entry of group) {
      if (entry.role === 'tool') {
        if (!toggleAdded) {
          turnItems.push({ kind: 'toggle', key, count: tools.length, failures, collapsed })
          toggleAdded = true
        }
        if (collapsed) continue
      }
      turnItems.push({ kind: 'entry', entry })
    }
  }
  const toggleTurnTools = (key: string): void => {
    setCollapsedTurns((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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

  return (
    <div
      className="app"
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
        <aside className="sidebar" data-testid="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-head">
              <span className="sidebar-title">{t('项目')}</span>
              <button
                className="sidebar-add"
                data-testid="branch-window-button"
                title={t('在新窗口打开分支')}
                aria-label={t('在新窗口打开分支')}
                onClick={() => void openBranchPicker()}
              >
                <BranchIcon />
              </button>
              <button className="sidebar-add" title={t('选择项目文件夹')} onClick={() => void pickProject()}>
                ＋
              </button>
            </div>
            <div className="sidebar-projects">
              {workspaces.map((project) => (
                <button
                  key={project.path}
                  className={`sidebar-project ${project.current ? 'active' : ''}`}
                  title={project.path}
                  onClick={() => void switchProject(project.path)}
                >
                  <span className="sidebar-project-name">{project.name}</span>
                  <span className="sidebar-project-path">{project.path}</span>
                </button>
              ))}
            </div>
          </div>
          {!usageDismissed && usageDone < 5 ? (
            <div className="sidebar-section usage-checklist" data-testid="usage-checklist">
              <div className="sidebar-head">
                <span className="sidebar-title">{t('上手清单')}</span>
                <span className="usage-progress">
                  {usageDone}/{5}
                </span>
                <button
                  className="sidebar-add"
                  data-testid="usage-dismiss"
                  title={t('收起上手清单')}
                  aria-label={t('收起上手清单')}
                  onClick={() => {
                    setUsageDismissed(true)
                    try {
                      localStorage.setItem(USAGE_DISMISSED_KEY, '1')
                    } catch {
                      // Ignore.
                    }
                  }}
                >
                  ×
                </button>
              </div>
              {(
                [
                  ['attach', t('附加一个文件或图片'), () => void pickDocument()],
                  ['screenshot', t('截一张图'), () => setCaptureMenuOpen(true)],
                  ['document', t('打开文档面板'), () => void openDocumentPanel()],
                  [
                    'palette',
                    t('用 {{key}} 搜索能力', {
                      key: window.xcode.platform === 'darwin' ? '⌘K' : 'Ctrl+K',
                    }),
                    () => setPaletteOpen(true),
                  ],
                  ['skill', t('从技能市场安装技能'), () => void openSettings('skillmarket')],
                ] as Array<[UsageKey, string, () => void]>
              ).map(([key, label, run]) => (
                <button
                  key={key}
                  className={`usage-item ${usageProgress[key] ? 'done' : ''}`}
                  data-testid={`usage-item-${key}`}
                  onClick={run}
                >
                  <span className="usage-check" aria-hidden="true">
                    {usageProgress[key] ? '✓' : '○'}
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="sidebar-section sidebar-sessions-section">
            <div className="sidebar-head">
              <span className="sidebar-title">{t('会话')}</span>
              <button className="sidebar-add" title={t('新建会话')} onClick={() => void newSession()}>
                ＋
              </button>
            </div>
            <div className="sidebar-search">
              <input
                ref={sessionSearchRef}
                value={sessionQuery}
                placeholder={t('搜索会话')}
                onChange={(event) => setSessionQuery(event.target.value)}
              />
            </div>
            <button
              className={`sidebar-archived-toggle ${showArchived ? 'active' : ''}`}
              onClick={() => setShowArchived((value) => !value)}
            >
              {showArchived ? t('隐藏归档') : t('显示归档')}
            </button>
            <div className="sidebar-sessions">
              {showPendingSession ? (
                <div className="sidebar-session sidebar-session-placeholder active">
                  <span className="sidebar-session-title">{t('新会话')}</span>
                  <span className="sidebar-session-meta">{t('刚刚')}</span>
                </div>
              ) : null}
              {visibleSessions.length === 0 && !showPendingSession ? (
                <div className="sidebar-empty">{sessionQuery.trim() ? t('没有匹配的会话') : t('暂无会话')}</div>
              ) : null}
              {visibleSessions.slice(0, 100).map((item) => (
                <div
                  key={item.sessionId}
                  className={`sidebar-session-row ${activeSessionId === item.sessionId ? 'active' : ''}`}
                  data-session-id={item.sessionId}
                >
                  {renaming?.filePath === item.filePath ? (
                    <input
                      className="sidebar-rename"
                      autoFocus
                      value={renaming.value}
                      onChange={(event) => setRenaming({ filePath: item.filePath, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void commitRename()
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          renameCancelRef.current = true
                          setRenaming(null)
                          renameCancelRef.current = false
                        }
                      }}
                      onBlur={() => {
                        if (renaming) void commitRename()
                      }}
                    />
                  ) : (
                    <>
                      <button
                        className="sidebar-session"
                        title={sessionTitle(item)}
                        onClick={() => void loadSession(item)}
                      >
                        <span className="sidebar-session-title">
                          {item.pinned ? '★ ' : ''}
                          {sessionTitle(item)}
                        </span>
                        <span className="sidebar-session-meta">{sessionTime(item)}</span>
                      </button>
                      <span className="sidebar-session-actions">
                        {deletingSession === item.filePath ? (
                          <>
                            <button className="session-action danger" onClick={() => void confirmDeleteSession(item)}>
                              {t('确认')}
                            </button>
                            <button className="session-action" onClick={() => setDeletingSession(null)}>
                              {t('取消')}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className={`session-action ${item.pinned ? 'active' : ''}`}
                              title={item.pinned ? t('取消置顶') : t('置顶')}
                              onClick={() => void toggleSessionPinned(item)}
                            >
                              {item.pinned ? '★' : '☆'}
                            </button>
                            <button
                              className="session-action"
                              title={item.archived ? t('取消归档') : t('归档')}
                              onClick={() => void toggleSessionArchived(item)}
                            >
                              {item.archived ? t('复') : t('档')}
                            </button>
                            <button
                              className="session-action"
                              title={t('重命名')}
                              onClick={() => setRenaming({ filePath: item.filePath, value: sessionTitle(item) })}
                            >
                              {t('改')}
                            </button>
                            <button
                              className="session-action"
                              title={t('删除')}
                              onClick={() => setDeletingSession(item.filePath)}
                            >
                              {t('删')}
                            </button>
                          </>
                        )}
                      </span>
                    </>
                  )}
                </div>
              ))}
              {sessionQuery.trim().length >= 2 ? (
                <div className="sidebar-search-results" data-testid="session-search-results">
                  <div className="sidebar-search-head">
                    {searchingSessions ? t('全文搜索中…') : t('全文匹配 {{count}}', { count: searchResults.length })}
                  </div>
                  {extraSearchResults.map((result) => (
                    <button
                      key={result.filePath}
                      className="sidebar-search-hit"
                      onClick={() =>
                        void loadSession({
                          filePath: result.filePath,
                          sessionId: result.sessionId,
                          ...(result.name ? { name: result.name } : {}),
                          firstPrompt: result.firstPrompt,
                          startedAt: new Date(result.mtime).toISOString(),
                          modelId: '',
                          mtime: result.mtime,
                        })
                      }
                    >
                      <span className="sidebar-search-name">
                        {result.name || result.firstPrompt || result.sessionId}
                      </span>
                      <span className="sidebar-search-snippet">{result.snippet}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
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
                  if (!open) setModelQuery('')
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
                      onChange={(event) => setModelQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && filteredModels.length > 0) {
                          event.preventDefault()
                          void chooseModel(filteredModels[0])
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setModelMenuOpen(false)
                        }
                      }}
                    />
                  </div>
                  <div className="model-list">
                    {localModelOptions.length > 0 ? (
                      <>
                        <div className="model-group">{t('本地模型')}</div>
                        {localModelOptions.map((model) => (
                          <button
                            key={model.id}
                            className={`model-item ${model.id === appState?.activeModelId ? 'active' : ''}`}
                            onClick={() => void chooseModel(model)}
                          >
                            <span className="model-item-label">{model.label}</span>
                            <span className="model-item-meta">
                              {model.provider}
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
                        ))}
                      </>
                    ) : null}
                    {remoteModelOptions.length > 0 ? (
                      <>
                        <div className="model-group">{t('云端 / 内置')}</div>
                        {remoteModelOptions.map((model) => (
                          <button
                            key={model.id}
                            className={`model-item ${model.id === appState?.activeModelId ? 'active' : ''}`}
                            onClick={() => void chooseModel(model)}
                          >
                            <span className="model-item-label">{model.label}</span>
                            <span className="model-item-meta">
                              {model.provider}
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
                        ))}
                      </>
                    ) : null}
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
                    <button
                      className="tools-item"
                      data-testid="files-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        openInspector('file')
                      }}
                    >
                      <span className="tools-item-label">{t('文件')}</span>
                      <span className="tools-item-meta">{t('浏览与编辑')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="document-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        void openDocumentPanel()
                      }}
                    >
                      <span className="tools-item-label">{t('文档面板')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="tools-skill-market"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        void openSettings('skillmarket')
                      }}
                    >
                      <span className="tools-item-label">{t('技能市场')}</span>
                      <span className="tools-item-meta">SkillHub / SkillsMP</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="git-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        void openGitPanel()
                      }}
                    >
                      <span className="tools-item-label">Git</span>
                      <span className="tools-item-meta">{t('变更')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="checks-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        void openChecksPanel()
                      }}
                    >
                      <span className="tools-item-label">{t('项目检查')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="background-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        setBackgroundOpen(true)
                      }}
                    >
                      <span className="tools-item-label">{t('后台任务')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="diagnostics-toggle"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        void runDiagnostics()
                      }}
                    >
                      <span className="tools-item-label">{t('诊断')}</span>
                    </button>
                    <button
                      className="tools-item"
                      data-testid="tools-manual"
                      onClick={() => {
                        setToolsMenuOpen(false)
                        setManualOpen(true)
                      }}
                    >
                      <span className="tools-item-label">{t('用户手册')}</span>
                      <span className="tools-item-meta">{t('功能与使用')}</span>
                    </button>
                    <div className="tools-separator" />
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
                >
                  <button
                    className="tab-label"
                    title={item?.filePath ?? item?.firstPrompt ?? t('新会话')}
                    onClick={() => void activateTab(sessionId)}
                  >
                    {busy && sessionId === activeSessionId ? <span className="tab-busy" aria-hidden="true" /> : null}
                    <span className="tab-title">{item ? sessionTitle(item) : t('新会话')}</span>
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
                if (event.key === 'Enter') {
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

        <main className="chat" ref={scrollRef} onScroll={handleChatScroll}>
          {entries.length === 0 ? (
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
            </div>
          ) : null}
          {turnItems.map((item) => {
            if (item.kind === 'toggle') {
              return (
                <div className="turn-tool-toggle" data-testid="turn-tool-toggle" key={`turn-toggle-${item.key}`}>
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
            return entry.role === 'tool' ? (
              <article key={entry.id} className={`tool-card ${entry.toolStatus ?? 'running'}`}>
                <div className="tool-head">
                  <span className="tool-name">{entry.toolName ?? 'tool'}</span>
                  <span className={`tool-state ${entry.toolStatus ?? 'running'}`}>
                    {t(TOOL_STATUS_LABEL[entry.toolStatus ?? 'running'])}
                  </span>
                  <span className="spacer" />
                  <span className="tool-target">{summarizeInput(entry.toolInput)}</span>
                  {entry.toolName === 'readDocument' && typeof entry.toolInput?.filePath === 'string' ? (
                    <button
                      className="session-action"
                      onClick={() => void openDocument(String(entry.toolInput?.filePath))}
                    >
                      {t('预览')}
                    </button>
                  ) : null}
                </div>
                {entry.toolProgress ? <div className="tool-progress">{entry.toolProgress}</div> : null}
                {entry.subagent ? <SubAgentBlock agent={entry.subagent} /> : null}
                {entry.diff ? (
                  <DiffView
                    diff={entry.diff}
                    reverted={entry.reverted}
                    onOpenEditor={(path, line) => openInEditor(path, line)}
                    onRevert={
                      entry.diff.revertible && entry.toolCallId
                        ? () => void revertEdit(entry.toolCallId!, entry.id)
                        : undefined
                    }
                  />
                ) : null}
                {entry.toolOutput ? (
                  <details className="tool-output">
                    <summary>{t('结果')}</summary>
                    <pre>{entry.toolOutput}</pre>
                  </details>
                ) : null}
                {entry.toolOutput && (entry.toolName === 'webSearch' || entry.toolName === 'webFetch') ? (
                  <SourceList text={entry.toolOutput} />
                ) : null}
              </article>
            ) : (
              <article
                key={entry.id}
                id={`entry-${entry.id}`}
                data-entry-id={entry.id}
                className={`message ${entry.role} ${findMatchIds.includes(entry.id) ? 'find-hit' : ''} ${
                  entry.id === findActiveId ? 'find-current' : ''
                }`}
              >
                <span className="role">{t(ROLE_LABEL[entry.role])}</span>
                {entry.role === 'assistant' || entry.role === 'user' ? (
                  <MarkdownView text={entry.text} />
                ) : (
                  <span className="message-text">{entry.text}</span>
                )}
                {entry.attachments?.length ? (
                  <div className="message-attachments">
                    {entry.attachments.map((file) =>
                      isImageAttachment(file) ? (
                        <AttachmentImage
                          key={file}
                          file={file}
                          variant="message"
                          onOpen={(src, name) => setImageLightbox({ src, name })}
                        />
                      ) : (
                        <span className="message-attachment-file" key={file} title={file}>
                          {attachmentName(file)}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {entry.attachmentViews?.length ? (
                  <div className="message-attachments">
                    {entry.attachmentViews.map((attachment, index) => {
                      const dataUrl = attachment.dataUrl
                      return dataUrl ? (
                        <button
                          key={`${attachment.name}-${index}`}
                          type="button"
                          className="message-attachment"
                          title={attachment.name}
                          onClick={() => setImageLightbox({ src: dataUrl, name: attachment.name })}
                        >
                          <img src={dataUrl} alt={attachment.name} loading="lazy" />
                          <span>{attachment.name}</span>
                        </button>
                      ) : attachment.path && isImageAttachment(attachment.path) ? (
                        <AttachmentImage
                          key={`${attachment.name}-${index}`}
                          file={attachment.path}
                          variant="message"
                          onOpen={(src, name) => setImageLightbox({ src, name })}
                        />
                      ) : (
                        <span
                          key={`${attachment.name}-${index}`}
                          className="message-attachment-file"
                          title={attachment.name}
                        >
                          {attachment.name}
                        </span>
                      )
                    })}
                  </div>
                ) : null}
                {entry.text ? (
                  <span className="message-actions">
                    {entry.role === 'assistant' || entry.role === 'user' ? <CopyButton text={entry.text} /> : null}
                    {entry.role === 'assistant' && entry.id === lastAssistantId && !busy ? (
                      <button type="button" className="copy-btn" onClick={() => void regenerateLast()}>
                        {t('重新生成')}
                      </button>
                    ) : null}
                    {entry.role === 'user' && entry.id === lastUserId && !busy ? (
                      <button type="button" className="copy-btn" onClick={beginEditLast}>
                        {t('编辑并重发')}
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </article>
            )
          })}
        </main>
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
            }}
          >
            ↓
          </button>
        ) : null}

        {notice ? <div className="notice">{notice}</div> : null}

        {todos.length > 0 ? (
          <div className="todos">
            <span className="todos-title">{t('待办')}</span>
            {todos.map((todo, index) => (
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
        ) : null}

        <footer className="composer">
          {mention !== null && mentionItems.length > 0 ? (
            <div className="slash-palette mention-palette" data-testid="mention-palette">
              {mentionItems.map((file, index) => (
                <button
                  key={file.path}
                  className={`slash-item ${index === mentionIndex ? 'active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pickMention(file)
                  }}
                >
                  <span className="slash-name">
                    {file.relative}
                    {file.isDirectory ? '/' : ''}
                  </span>
                  <span className="slash-desc">{file.isDirectory ? t('目录') : ''}</span>
                </button>
              ))}
            </div>
          ) : null}
          {paletteCommands.length > 0 ? (
            <div className="slash-palette" data-testid="slash-palette" ref={slashPaletteRef}>
              {paletteCommands.map((command, index) => (
                <button
                  key={command.name}
                  className={`slash-item ${index === paletteIndex ? 'active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    runSlashCommand(command)
                  }}
                >
                  <span className="slash-name">{command.name}</span>
                  <span className="slash-desc">{command.description}</span>
                </button>
              ))}
            </div>
          ) : null}
          {editArmed ? (
            <div className="edit-badge" data-testid="edit-badge">
              <span>{t('编辑模式：发送后将重写上一轮，文件改动会保留')}</span>
              <button
                className="attachment-remove"
                title={t('取消')}
                onClick={() => {
                  setEditArmed(false)
                  setInput('')
                  setAttachments([])
                }}
              >
                ×
              </button>
            </div>
          ) : null}
          {queuedItems.length > 0 ? (
            <div className="queued-list" data-testid="queued-list">
              {queuedItems.map((item, index) => (
                <div className="queued-item" key={`${index}-${item.prompt.slice(0, 24)}`}>
                  <span className="queued-text">{item.prompt}</span>
                  <button className="attachment-remove" title={t('移出队列')} onClick={() => removeQueued(index)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {recording || voiceBusy ? (
            <div className={`recording-bar ${voiceBusy ? 'busy' : ''}`} data-testid="recording-bar">
              <span className="recording-dot" aria-hidden="true" />
              <span className="recording-time">{formatDuration(recordingSeconds)}</span>
              {recording ? (
                <span className="recording-level" aria-hidden="true">
                  <span style={{ width: `${Math.round(audioLevel * 100)}%` }} />
                </span>
              ) : null}
              <span className="recording-hint">{voiceBusy ? t('正在转写…') : t('正在录音…')}</span>
              <span className="spacer" />
              {recording ? (
                <>
                  <button className="btn btn-quiet" onClick={() => void stopRecording(false)}>
                    {t('取消')}
                  </button>
                  <button className="btn" onClick={() => void stopRecording(true)}>
                    {t('完成并转写')}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="composer-attachments" data-testid="attachments" hidden={attachments.length === 0}>
            {attachments.map((file) => (
              <span className="attachment-chip" key={file} title={file}>
                {isImageAttachment(file) ? (
                  <AttachmentImage file={file} variant="chip" onOpen={(src, name) => setImageLightbox({ src, name })} />
                ) : null}
                <span className="attachment-name">{file.split(/[\\/]/).pop() ?? file}</span>
                <button
                  className="attachment-remove"
                  title={t('移除附件')}
                  onClick={() => setAttachments((current) => current.filter((entry) => entry !== file))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="markdown-bar">
            <button
              type="button"
              className={`btn btn-quiet markdown-toggle ${markdownToolsOpen ? 'active' : ''}`}
              data-testid="markdown-toggle"
              title={t('Markdown 格式')}
              aria-label={t('Markdown 格式')}
              onClick={() => setMarkdownToolsOpen((open) => !open)}
            >
              MD
            </button>
            {markdownToolsOpen ? (
              <div className="markdown-toolbar" data-testid="markdown-toolbar">
                <button
                  type="button"
                  data-testid="markdown-bold"
                  title={`${t('粗体')} (⌘B)`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('bold')}
                >
                  <strong>B</strong>
                </button>
                <button
                  type="button"
                  title={`${t('斜体')} (⌘I)`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('italic')}
                >
                  <em>I</em>
                </button>
                <button
                  type="button"
                  title={`${t('行内代码')} (⌘E)`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('code')}
                >
                  {'</>'}
                </button>
                <button
                  type="button"
                  title={t('代码块')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('codeBlock')}
                >
                  {'{ }'}
                </button>
                <button
                  type="button"
                  title={t('链接')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('link')}
                >
                  {t('链接')}
                </button>
                <button
                  type="button"
                  title={t('列表')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('list')}
                >
                  {t('列表')}
                </button>
                <button
                  type="button"
                  title={t('引用')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMarkdown('quote')}
                >
                  {t('引用')}
                </button>
              </div>
            ) : null}
            <span className="spacer" />
            {markdownToolsOpen ? (
              <button
                type="button"
                className={`btn btn-quiet markdown-preview-toggle ${markdownPreview ? 'active' : ''}`}
                data-testid="markdown-preview-toggle"
                onClick={() => setMarkdownPreview((preview) => !preview)}
              >
                {t('预览')}
              </button>
            ) : null}
          </div>
          {markdownToolsOpen && markdownPreview ? (
            <div className="markdown-preview" data-testid="markdown-preview">
              {input.trim() ? <MarkdownView text={input} /> : <div className="menu-hint">{t('暂无内容')}</div>}
            </div>
          ) : null}
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              placeholder={busy ? t('落笔未竟…') : t('写下你的问题，或输入指令…')}
              onChange={(event) => {
                setInput(event.target.value)
                updateMention(event.target.value, event.target.selectionStart)
              }}
              onKeyUp={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
              onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (mention !== null && mentionItems.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setMentionIndex((index) => (index + 1) % mentionItems.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length)
                    return
                  }
                  if (event.key === 'Tab' || event.key === 'Enter') {
                    event.preventDefault()
                    const picked = mentionItems[mentionIndex]
                    if (picked) pickMention(picked)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    dismissedMentionRef.current = { atIdx: mention.atIdx, query: mention.query }
                    setMention(null)
                    return
                  }
                }
                if (paletteCommands.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setPaletteIndex((index) => (index + 1) % paletteCommands.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setPaletteIndex((index) => (index - 1 + paletteCommands.length) % paletteCommands.length)
                    return
                  }
                  if (event.key === 'Tab') {
                    event.preventDefault()
                    const command = paletteCommands[paletteIndex]
                    if (command) setInput(command.name)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setInput('')
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    const command = paletteCommands[paletteIndex]
                    if (command) runSlashCommand(command)
                    return
                  }
                }
                if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
                  const key = event.key.toLowerCase()
                  if (key === 'b') {
                    event.preventDefault()
                    applyMarkdown('bold')
                    return
                  }
                  if (key === 'i') {
                    event.preventDefault()
                    applyMarkdown('italic')
                    return
                  }
                  if (key === 'e') {
                    event.preventDefault()
                    applyMarkdown('code')
                    return
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (input.startsWith('/')) {
                    const match = input.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
                    const name = match?.[1]
                    if (name === 'export') {
                      const format = (match?.[2] ?? '').trim().toLowerCase()
                      setInput('')
                      void exportCurrentSession(format === 'json' ? 'json' : format === 'pdf' ? 'pdf' : 'markdown')
                      return
                    }
                    if (name && customCommands.some((command) => command.name === name)) {
                      setInput('')
                      void runCustomCommand(name, (match?.[2] ?? '').trim())
                      return
                    }
                    append({
                      role: 'system',
                      text: t('未知命令：{{command}}（输入 /help 查看命令）', { command: input.trim() }),
                    })
                    setInput('')
                    return
                  }
                  if (!canSend) return
                  const prompt = input
                  setInput('')
                  void submit(prompt)
                }
              }}
            />
            <button
              className="btn attach"
              data-testid="document-button"
              title={t('文档面板')}
              aria-label={t('文档面板')}
              onClick={() => void openDocumentPanel()}
            >
              <DocumentIcon />
            </button>
            <button className="btn attach" title={t('选择文档或媒体文件')} onClick={() => void pickDocument()}>
              <AttachIcon />
            </button>
            <div className="menu-anchor capture-anchor">
              <button
                className={`btn attach ${captureMenuOpen ? 'active' : ''}`}
                title={t('截图')}
                data-testid="capture-button"
                onClick={() => setCaptureMenuOpen((open) => !open)}
              >
                <CaptureIcon />
              </button>
              {captureMenuOpen ? (
                <>
                  <div className="capture-scrim" onClick={() => setCaptureMenuOpen(false)} aria-hidden="true" />
                  <div className="capture-menu" role="menu" data-testid="capture-menu">
                    <button className="capture-item" data-testid="capture-region" onClick={() => void captureRegion()}>
                      <RegionIcon />
                      <span>{t('框选区域')}</span>
                    </button>
                    <button className="capture-item" data-testid="capture-screen" onClick={() => void captureScreen()}>
                      <CaptureIcon />
                      <span>{t('整个屏幕')}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <button
              className={`btn attach ${recording ? 'recording' : ''}`}
              data-testid="mic-button"
              title={recording ? t('停止录音并转写') : t('语音输入')}
              disabled={voiceBusy}
              onClick={toggleRecording}
            >
              {recording ? <StopIcon /> : <MicIcon />}
            </button>
            {busy ? (
              <button className="send stop" onClick={() => void abort()}>
                {t('停止')}
              </button>
            ) : (
              <button
                className="send"
                title={t('落笔')}
                aria-label={t('落笔')}
                disabled={!canSend}
                onClick={() => {
                  const prompt = input
                  setInput('')
                  void submit(prompt)
                }}
              >
                <SendIcon />
              </button>
            )}
          </div>
          <div className="composer-hint">
            <span>{t('Enter 发送 · Shift+Enter 换行')}</span>
            <button type="button" className="capability-hint" onClick={() => setPaletteOpen(true)}>
              {window.xcode.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} {t('全部能力')}
            </button>
            {contextPercent !== null ? (
              <span
                className={`context-meter ${contextPercent >= 85 ? 'danger' : contextPercent >= 65 ? 'warn' : ''}`}
                title={t('上下文 {{used}} / {{total}} tokens', {
                  used: usedContextTokens,
                  total: contextWindow ?? 0,
                })}
              >
                <span className="context-track">
                  <span className="context-fill" style={{ width: `${contextPercent}%` }} />
                </span>
                <span className="context-numbers">
                  {formatContextTokens(usedContextTokens)} / {formatContextTokens(contextWindow ?? 0)}
                </span>
                <span className="context-percent">{contextPercent}%</span>
              </span>
            ) : null}
            {usage ? (
              <span className="usage">
                ↑{usage.inputTokens} ↓{usage.outputTokens}
              </span>
            ) : null}
            {queued > 0 ? <span className="queued">{t('已排队 {{count}}', { count: queued })}</span> : null}
          </div>
        </footer>
      </div>

      {inspectorTab ? (
        <Inspector tab={inspectorTab} onTab={openInspector} onClose={closeInspector}>
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
              embedded
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
              busy={gitBusy}
              onRefresh={() => void refreshGit()}
              onSelect={(path, staged) => void selectGitFile(path, staged)}
              onUndo={() => void undoGitTurn()}
              onOpenEditor={(path, line) => openInEditor(path, line)}
              onClose={closeInspector}
              embedded
            />
          ) : null}
          {inspectorTab === 'checks' ? (
            <ChecksPanel
              checks={projectChecks}
              results={checkResults}
              autoChecks={checkAuto}
              loading={checksLoading}
              error={checksError}
              onRefresh={() => void refreshChecks()}
              onRun={() => void runChecksNow()}
              onToggleAuto={() => void toggleAutoChecks()}
              onFix={fixFromChecks}
              onClose={closeInspector}
              embedded
            />
          ) : null}
          {inspectorTab === 'file' ? (
            <Suspense fallback={null}>
              <FilePanel
                workspace={appState?.workspace ?? settings?.workspace ?? ''}
                initialPath={fileInitialPath}
                onOpenEditor={(path, line) => openInEditor(path, line)}
                onClose={() => {
                  closeInspector()
                  setFileInitialPath(null)
                }}
                embedded
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
                <TerminalPanel />
              </Suspense>
            </aside>
          ) : null}
        </Inspector>
      ) : null}

      {approval ? (
        <div className="modal-scrim">
          <div className="approval-card" data-testid="approval-modal">
            <div className="approval-head">
              <span className="drawer-seal" aria-hidden="true">
                {approval.kind === 'plan' ? '策' : approval.kind === 'question' ? '问' : '准'}
              </span>
              <div>
                <div className="approval-title">
                  {approval.kind === 'plan'
                    ? t('计划确认')
                    : approval.kind === 'question'
                      ? t('需要你的选择')
                      : approval.kind === 'authority'
                        ? t('外部影响确认')
                        : t('权限请求')}
                </div>
                <div className="approval-sub">{approval.toolName ?? approval.kind}</div>
              </div>
            </div>

            {approval.kind === 'permission' ? (
              <pre className="approval-body">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
            ) : null}
            {approval.kind === 'authority' ? (
              <div className="approval-body text">
                <div>{approval.preview?.summary}</div>
                {approval.preview?.paths?.length ? (
                  <div className="approval-paths">{approval.preview.paths.join('\n')}</div>
                ) : null}
                {approval.preview?.reason ? <div className="approval-reason">{approval.preview.reason}</div> : null}
              </div>
            ) : null}
            {approval.kind === 'question' ? <div className="approval-body text">{approval.question}</div> : null}
            {approval.kind === 'plan' ? <pre className="approval-body">{approval.planText ?? ''}</pre> : null}

            <div className="approval-actions">
              {approval.kind === 'question' ? (
                <>
                  <button className="btn" onClick={() => void respondApproval(approval, '')}>
                    {t('取消')}
                  </button>
                  {approval.options?.map((option) => (
                    <button
                      key={option.label}
                      className="btn solid"
                      title={option.description}
                      onClick={() => void respondApproval(approval, option.label)}
                    >
                      {option.label}
                    </button>
                  ))}
                </>
              ) : approval.kind === 'plan' ? (
                <>
                  <button className="btn" onClick={() => void respondApproval(approval, false)}>
                    {t('继续修改')}
                  </button>
                  <button className="btn solid" onClick={() => void respondApproval(approval, true)}>
                    {t('批准计划')}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => void respondApproval(approval, 'no')}>
                    {t('拒绝')}
                  </button>
                  {approval.kind === 'permission' ? (
                    <button className="btn" onClick={() => void respondApproval(approval, 'always')}>
                      {t('始终允许')}
                    </button>
                  ) : null}
                  <button className="btn solid" onClick={() => void respondApproval(approval, 'yes')}>
                    {t('允许一次')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen && settings ? (
        <Suspense fallback={null}>
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
      <CommandPalette
        key={paletteOpen ? 'palette-open' : 'palette-closed'}
        open={paletteOpen}
        actions={paletteActions}
        sessions={sessions}
        commands={commandsWithHelp}
        onSession={(item) => void loadSession(item)}
        onClose={() => setPaletteOpen(false)}
      />
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
              ).map(([key, label]) => (
                <div className="shortcut-row" key={key}>
                  <kbd>{window.xcode.platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`}</kbd>
                  <span>{label}</span>
                </div>
              ))}
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
