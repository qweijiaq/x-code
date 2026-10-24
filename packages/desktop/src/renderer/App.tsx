import { useEffect, useRef, useState } from 'react'
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
  HooksView,
  LoadedSessionView,
  ModelOption,
  ProjectCheckResultView,
  ProjectCheckView,
  ProjectSettingsView,
  RewindResultView,
  RuntimeEvent,
  RuntimeRequest,
  SessionAttachmentView,
  SessionListItem,
  SessionSearchResult,
  SettingsActionResult,
  SettingsSnapshot,
  SmokeReport,
  StorageUsageView,
  SubAgentView,
  TextReport,
  TodoView,
  UiSmokeCheck,
  UpdateCheckResult,
  UsageView,
  WorkspaceFileItem,
  WorkspaceList,
  WorkspaceListItem,
} from '../shared/protocol.js'
import { BackgroundPanel } from './BackgroundPanel.js'
import { ChecksPanel } from './ChecksPanel.js'
import { CommandPalette } from './CommandPalette.js'
import type { PaletteAction } from './CommandPalette.js'
import { DocumentPanel } from './DocumentPanel.js'
import { FilePanel } from './FilePanel.js'
import { GitPanel } from './GitPanel.js'
import { CopyButton, MarkdownView } from './MarkdownView.js'
import { Onboarding } from './Onboarding.js'
import { RewindPanel } from './RewindPanel.js'
import { SettingsPanel } from './SettingsPanel.js'
import { TerminalPanel } from './TerminalPanel.js'
import {
  AttachIcon,
  BranchIcon,
  CaptureIcon,
  ChevronIcon,
  MicIcon,
  MoreIcon,
  RegionIcon,
  SendIcon,
  SettingsIcon,
  SidebarIcon,
  StopIcon,
  TerminalIcon,
} from './icons.js'
import { detectMention, insertMention } from './mention.js'
import { applyTheme, storedTheme, watchSystemTheme } from './theme.js'
import type { ThemeSetting } from './theme.js'
import { encodeWav } from './wav.js'

const isUiSmoke = new URLSearchParams(window.location.search).has('ui-smoke')
const forcedOnboarding = isUiSmoke && new URLSearchParams(window.location.search).has('onboard')
const wantsSettings = new URLSearchParams(window.location.search).has('settings')
const wantsSlashDemo = new URLSearchParams(window.location.search).has('slash')

function formatContextTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

const IMAGE_ATTACHMENT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
const imagePreviewCache = new Map<string, string>()

function isImageAttachment(filePath: string): boolean {
  return IMAGE_ATTACHMENT_RE.test(filePath)
}

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

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) {
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
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

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
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
  const [terminalOpen, setTerminalOpen] = useState(() => new URLSearchParams(window.location.search).has('terminal'))
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchView, setBranchView] = useState<BranchListView | null>(null)
  const [branchQuery, setBranchQuery] = useState('')
  const [branchBusy, setBranchBusy] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
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
  const [documentOpen, setDocumentOpen] = useState(false)
  const [fileOpen, setFileOpen] = useState(false)
  const [documentView, setDocumentView] = useState<DocumentView | null>(null)
  const [documentLoading, setDocumentLoading] = useState(false)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [documentRecent, setDocumentRecent] = useState<DocumentRecentItem[]>([])
  const [documentLoadingMore, setDocumentLoadingMore] = useState(false)
  const [documentFocusPage, setDocumentFocusPage] = useState<number | null>(null)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitStatusView, setGitStatusView] = useState<GitStatusView | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitSelected, setGitSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [gitDiffText, setGitDiffText] = useState<string | null>(null)
  const [gitDiffTruncated, setGitDiffTruncated] = useState(false)
  const [gitBusy, setGitBusy] = useState(false)
  const [checksOpen, setChecksOpen] = useState(false)
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
  }, [])

  useEffect(() => {
    const onOpenFile = (event: Event): void => {
      const path = (event as CustomEvent<string>).detail
      if (typeof path === 'string' && path.trim()) {
        setFileInitialPath(path)
        setFileOpen(true)
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
        else if (terminalOpen) setTerminalOpen(false)
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

    const run = async (): Promise<void> => {
      const checks: Record<string, UiSmokeCheck> = {}
      try {
        for (const key of Object.keys(localStorage)) {
          if (key === 'xcode.lastSession' || key.startsWith('xcode.draft.')) localStorage.removeItem(key)
        }
        setInput('')
        setAttachments([])
      } catch {
        // Smoke isolation is best-effort.
      }
      const openToolsMenu = async (): Promise<boolean> => {
        document.querySelector<HTMLButtonElement>('[data-testid="tools-menu-toggle"]')?.click()
        return waitFor(() => document.querySelector('[data-testid="tools-menu"]') !== null, 2_000)
      }
      let originalModelId: string | null = null
      let workspace = ''
      const originalLanguage = i18n.language === 'en' ? 'en' : 'zh'
      const originalTheme = storedTheme()
      if (originalLanguage !== 'zh') await i18n.changeLanguage('zh')
      applyTheme('light')
      try {
        if (forcedOnboarding) {
          const shown = await waitFor(() => document.querySelector('[data-testid="onboarding"]') !== null, 5_000)
          const title = document.querySelector('.onboarding-title')?.textContent ?? ''
          const nextButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
          ).find((button) => !button.classList.contains('btn-quiet'))
          nextButton?.click()
          const providerStep = await waitFor(
            () => document.querySelector('[data-testid="onboarding"] .onboarding-provider') !== null,
            2_000,
          )
          // With no key typed and no stored key, the test button must explain
          // itself instead of silently ignoring the click.
          const anyConfigured = document.querySelector('[data-testid="onboarding"] .onboarding-available') !== null
          let testResponded = anyConfigured
          let testDetail = anyConfigured ? 'skipped (provider configured)' : 'no feedback'
          if (!anyConfigured) {
            const testButton = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn-quiet'),
            ).find((button) => (button.textContent ?? '').includes('测试连接'))
            testButton?.click()
            testResponded = await waitFor(
              () => document.querySelector('[data-testid="onboarding"] .onboarding-test.fail') !== null,
              2_000,
            )
            testDetail = testResponded
              ? (document.querySelector('[data-testid="onboarding"] .onboarding-test.fail')?.textContent ??
                'error shown')
              : 'no result shown'
          }
          // Exercise the "save and continue" path with a throwaway key, then
          // clear it and return to the demo model for the remaining checks.
          const keyInput = document.querySelector<HTMLInputElement>('[data-testid="onboarding"] input[type="password"]')
          let keySaveStep = false
          let keySaveDetail = 'password input missing'
          if (keyInput) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(keyInput, 'sk-ant-smoke-test')
            keyInput.dispatchEvent(new Event('input', { bubbles: true }))
            const saveButton = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
            ).find((button) => (button.textContent ?? '').includes('保存并继续'))
            saveButton?.click()
            keySaveStep = await waitFor(
              () => document.querySelector('[data-testid="onboarding"] .onboarding-choices') !== null,
              10_000,
            )
            keySaveDetail = keySaveStep
              ? 'saved and advanced'
              : (document.querySelector('[data-testid="onboarding"] .settings-warn')?.textContent ?? 'no error shown')
            const activeProvider =
              document.querySelector('[data-testid="onboarding"] .onboarding-provider.active span')?.textContent ??
              'anthropic'
            await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'settings:clear-api-key',
              params: { provider: activeProvider },
            })
            await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'models:set',
              params: { modelId: 'demo:mock' },
            })
          }
          if (!keySaveStep) {
            const quietButtons = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn-quiet'),
            )
            quietButtons[quietButtons.length - 1]?.click()
          }
          const preferenceStep = await waitFor(
            () => document.querySelector('[data-testid="onboarding"] .onboarding-choices') !== null,
            2_000,
          )
          const startButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
          ).find((button) => (button.textContent ?? '').includes('开始使用'))
          startButton?.click()
          const dismissed = await waitFor(() => document.querySelector('[data-testid="onboarding"]') === null, 3_000)
          checks.onboarding = {
            ok: shown && providerStep && preferenceStep && dismissed && title.length > 0 && testResponded,
            detail: `shown=${shown} provider=${providerStep} test=${testDetail} saveKey=${keySaveDetail} prefs=${preferenceStep} dismissed=${dismissed} title=${title}`,
          }
        }
        const stateResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:state',
          params: {},
        })
        if (stateResponse.ok) {
          const state = stateResponse.result as AppState
          workspace = state.workspace
          originalModelId = state.demo ? null : state.activeModelId
          if (!state.demo) {
            await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'models:set',
              params: { modelId: 'demo:mock' },
            })
          }
        }

        let text = ''
        const offText = window.xcode.onEvent((event) => {
          if (event.type === 'agent:text-delta') text += event.delta
        })
        const agent = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: 'ui smoke' },
        })
        offText()
        checks.agent = {
          ok: agent.ok && text.includes('演示模型'),
          detail: agent.ok ? `streamed ${text.length} chars` : agent.error.message,
        }
        const contextMeterReady = await waitFor(
          () => document.querySelector('.context-meter .context-numbers')?.textContent?.includes('/') ?? false,
          2_000,
        )
        const contextNumbersText = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
        checks.contextMeter = {
          ok: contextMeterReady && /\d.*\/.*\d/.test(contextNumbersText),
          detail: contextNumbersText || 'context meter missing',
        }

        const attachmentState: {
          event: { files: string[]; mediaParts: number; textBytes: number } | null
        } = { event: null }
        const offAttach = window.xcode.onEvent((event) => {
          if (event.type === 'agent:attachments') attachmentState.event = event
        })
        const attachmentTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: 'attachment smoke', attachments: [`${workspace}/README.md`] },
        })
        offAttach()
        checks.attachment = {
          ok:
            attachmentTurn.ok &&
            attachmentState.event !== null &&
            attachmentState.event.files.length === 1 &&
            attachmentState.event.textBytes > 0,
          detail: attachmentState.event
            ? `${attachmentState.event.files.length} file(s), ${attachmentState.event.textBytes} chars, ${attachmentState.event.mediaParts} media`
            : 'no agent:attachments event',
        }

        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[markdown-demo]' },
        })
        const markdownReady = await waitFor(
          () =>
            document.querySelector('.code-block') !== null &&
            document.querySelector('.markdown table') !== null &&
            document.querySelector('.code-block .copy-btn') !== null,
          5_000,
        )
        const copyButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.code-block .copy-btn')).find(
          (button) => button.textContent?.trim() === '复制',
        )
        copyButton?.click()
        const copied = await waitFor(() => copyButton?.textContent === '已复制', 2_000)
        checks.markdown = {
          ok: markdownReady && copied,
          detail: markdownReady
            ? `code block, table rendered; copy=${copied ? 'ok' : 'failed'}`
            : 'markdown did not render',
        }

        const composer = document.querySelector('.composer textarea') as HTMLTextAreaElement | null
        if (composer) {
          const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setValue?.call(composer, '@')
          composer.setSelectionRange(1, 1)
          composer.dispatchEvent(new Event('input', { bubbles: true }))
          const paletteReady = await waitFor(
            () => document.querySelectorAll('[data-testid="mention-palette"] .slash-item').length > 1,
            3_000,
          )
          composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
          const arrowKept = await waitFor(
            () =>
              document
                .querySelectorAll('[data-testid="mention-palette"] .slash-item')[1]
                ?.classList.contains('active') ?? false,
            1_500,
          )
          const firstItem = document.querySelector(
            '[data-testid="mention-palette"] .slash-item',
          ) as HTMLButtonElement | null
          firstItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          const inserted = await waitFor(() => composer.value.startsWith('@') && composer.value.length > 2, 2_000)
          checks.mention = {
            ok: paletteReady && arrowKept && inserted,
            detail: `palette=${paletteReady} arrow=${arrowKept} inserted=${inserted}`,
          }
          setValue?.call(composer, '')
          composer.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          checks.mention = { ok: false, detail: 'composer textarea missing' }
        }

        let sawApproval = false
        let sawDiff = false
        let diffEdit: { toolCallId: string; filePath: string } | null = null
        const offTool = window.xcode.onEvent((event) => {
          if (event.type === 'approval:request' && event.kind === 'permission') {
            sawApproval = true
            void window.xcode.request({
              id: crypto.randomUUID(),
              method: 'approval:respond',
              params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
            })
          }
          if (event.type === 'agent:file-edit') {
            sawDiff = true
            diffEdit = { toolCallId: event.toolCallId, filePath: event.payload.filePath }
          }
        })
        const toolTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[tool-demo]' },
        })
        offTool()
        checks.toolFlow = {
          ok: toolTurn.ok && sawApproval && sawDiff,
          detail: `approval=${sawApproval} diff=${sawDiff}`,
        }
        const lastToolCard = Array.from(document.querySelectorAll('.chat > .tool-card')).pop()
        const lastAssistant = Array.from(document.querySelectorAll('.chat > .message.assistant')).pop()
        const toolOrderBits = lastToolCard && lastAssistant ? lastToolCard.compareDocumentPosition(lastAssistant) : 0
        const toolOrderOk = (toolOrderBits & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        checks.toolOrder = {
          ok: toolOrderOk,
          detail: `tool=${Boolean(lastToolCard)} answer=${Boolean(lastAssistant)} after=${toolOrderOk}`,
        }
        const capturedEdit = diffEdit as { toolCallId: string; filePath: string } | null
        if (capturedEdit) {
          const revertResponse = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'edit:revert',
            params: { toolCallId: capturedEdit.toolCallId },
          })
          checks.editRevert = {
            ok: revertResponse.ok,
            detail: revertResponse.ok
              ? (revertResponse.result as { message: string }).message
              : revertResponse.error.message,
          }
        } else {
          checks.editRevert = { ok: false, detail: 'no file-edit event captured' }
        }

        let subagentStart = false
        let subagentEnd = false
        const offSubagent = window.xcode.onEvent((event) => {
          if (event.type === 'agent:subagent') {
            if (event.phase === 'start') subagentStart = true
            if (event.phase === 'end') subagentEnd = true
          }
          if (event.type === 'approval:request' && event.kind === 'permission') {
            void window.xcode.request({
              id: crypto.randomUUID(),
              method: 'approval:respond',
              params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
            })
          }
        })
        const subagentTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[subagent-demo]' },
        })
        offSubagent()
        const subagentDom = await waitFor(() => document.querySelector('[data-testid="subagent"]') !== null, 3_000)
        checks.subagent = {
          ok: subagentTurn.ok && subagentStart && subagentEnd && subagentDom,
          detail: `turn=${subagentTurn.ok} start=${subagentStart} end=${subagentEnd} dom=${subagentDom}`,
        }

        let sawDenyApproval = false
        let deniedDiff = false
        const offDeny = window.xcode.onEvent((event) => {
          if (event.type === 'approval:request' && event.kind === 'permission') {
            sawDenyApproval = true
            void window.xcode.request({
              id: crypto.randomUUID(),
              method: 'approval:respond',
              params: { requestId: event.requestId, kind: 'permission', decision: 'no' },
            })
          }
          if (event.type === 'agent:file-edit') deniedDiff = true
        })
        const denyTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[tool-demo]' },
        })
        offDeny()
        checks.toolDeny = {
          ok: denyTurn.ok && sawDenyApproval && !deniedDiff,
          detail: `approval=${sawDenyApproval} diff=${deniedDiff}`,
        }

        const turnToggles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="turn-tool-toggle"]'))
        const lastTurnToggle = turnToggles.at(-1)
        const turnToolCount = Number(/工具调用\s*(\d+)\s*次/.exec(lastTurnToggle?.textContent ?? '')?.[1] ?? 0)
        const toolCardsBefore = document.querySelectorAll('.tool-card').length
        lastTurnToggle?.querySelector<HTMLButtonElement>('[data-testid="turn-tool-toggle-button"]')?.click()
        const toolsHidden = await waitFor(
          () => document.querySelectorAll('.tool-card').length === toolCardsBefore - turnToolCount,
          2000,
        )
        const toggleStays = lastTurnToggle?.isConnected === true
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid="turn-tool-toggle"]'))
          .at(-1)
          ?.querySelector<HTMLButtonElement>('[data-testid="turn-tool-toggle-button"]')
          ?.click()
        const toolsRestored = await waitFor(
          () => document.querySelectorAll('.tool-card').length === toolCardsBefore,
          2000,
        )
        checks.turnToolCollapse = {
          ok: turnToggles.length >= 2 && turnToolCount > 0 && toolsHidden && toggleStays && toolsRestored,
          detail: `turns=${turnToggles.length} tools=${turnToolCount} hidden=${toolsHidden} keeps=${toggleStays} restored=${toolsRestored}`,
        }

        // Build enough history that reactive compaction has something to
        // summarize, then make the demo model reject the next request with a
        // context-overflow error. The turn must recover on its own.
        const filler = '上下文填充内容，用于触发自动压缩。'.repeat(4000)
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: `填充一：${filler}` },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: `填充二：${filler}` },
        })
        let sawCompression = false
        let compactText = ''
        const offCompact = window.xcode.onEvent((event) => {
          if (event.type === 'agent:context-compressed') sawCompression = true
          if (event.type === 'agent:text-delta') compactText += event.delta
        })
        const compactTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[compact-demo]' },
        })
        offCompact()
        checks.contextCompaction = {
          ok: compactTurn.ok && sawCompression && compactText.includes('压缩'),
          detail: `compressed=${sawCompression} chars=${compactText.length}`,
        }

        const sessionList = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:list',
          params: {},
        })
        const list = sessionList.ok ? (sessionList.result as SessionListItem[]) : []
        const currentSessionId = toolTurn.ok ? (toolTurn.result as { sessionId: string }).sessionId : ''
        const target = list.find((item) => item.sessionId === currentSessionId) ?? list[0]
        checks.sessions = { ok: list.length > 0, detail: `${list.length} session(s)` }
        if (target) {
          const loaded = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:load',
            params: { filePath: target.filePath },
          })
          const view = loaded.ok ? (loaded.result as LoadedSessionView) : null
          checks.sessionResume = {
            ok: Boolean(view && view.messages.length > 0),
            detail: loaded.ok ? `${view?.messages.length ?? 0} message(s)` : loaded.error.message,
          }
        } else {
          checks.sessionResume = { ok: false, detail: 'no session to resume' }
        }

        const settingsResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:get',
          params: {},
        })
        const snapshot = settingsResponse.ok ? (settingsResponse.result as SettingsSnapshot) : null
        checks.settings = {
          ok: Boolean(snapshot && snapshot.providers.length > 0 && snapshot.tools.length > 0),
          detail: snapshot
            ? `${snapshot.providers.length} providers, ${snapshot.tools.length} tools, ${snapshot.mcpServers.length} mcp`
            : settingsResponse.ok
              ? 'empty settings'
              : settingsResponse.error.message,
        }
        const settingsButton = document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')
        settingsButton?.click()
        const settingsMounted = await waitFor(() => document.querySelector('.settings-drawer') !== null, 3000)
        const appearanceMounted = await waitFor(() => document.querySelector('.settings-appearance') !== null, 2_000)
        checks.settingsPanel = {
          ok: settingsMounted && appearanceMounted,
          detail: settingsMounted
            ? `settings drawer mounted${appearanceMounted ? ', appearance controls present' : ', appearance missing'}`
            : 'settings drawer missing',
        }
        const customFields = Array.from(
          document.querySelectorAll<HTMLInputElement>('[data-testid="provider-fields"] input'),
        )
        const customGap =
          customFields.length >= 2
            ? customFields[1].getBoundingClientRect().top - customFields[0].getBoundingClientRect().bottom
            : 0
        checks.customProviderFields = {
          ok: customFields.length >= 2 && customGap >= 8,
          detail:
            customFields.length >= 2
              ? `custom fields mounted, gap=${customGap.toFixed(1)}px`
              : 'custom model fields missing',
        }
        const updateInput = document.querySelector<HTMLInputElement>(
          '[data-testid="update-check"] .update-controls .settings-input',
        )
        const updateButton = document.querySelector<HTMLButtonElement>(
          '[data-testid="update-check"] .update-buttons .btn',
        )
        const updateGap =
          updateInput && updateButton
            ? updateButton.getBoundingClientRect().top - updateInput.getBoundingClientRect().bottom
            : 0
        checks.updateSpacing = {
          ok: Boolean(updateInput && updateButton) && updateGap >= 8,
          detail:
            updateInput && updateButton ? `update controls gap=${updateGap.toFixed(1)}px` : 'update controls missing',
        }
        const settingsTabs = document.querySelectorAll<HTMLButtonElement>('.settings-tab')
        const clickSettingsTab = (label: string): void => {
          Array.from(settingsTabs)
            .find((tab) => tab.textContent?.trim() === label)
            ?.click()
        }
        clickSettingsTab('技能')
        const skillCommandMounted = await waitFor(
          () => document.querySelector('[data-testid="skill-command"]') !== null,
          2000,
        )
        checks.skillCommandTab = {
          ok: skillCommandMounted,
          detail: skillCommandMounted ? 'skill command field mounted' : 'skill command field missing',
        }
        clickSettingsTab('插件市场')
        const marketMounted = await waitFor(() => document.querySelector('.market-form') !== null, 3000)
        checks.marketplaceTab = {
          ok: marketMounted,
          detail: marketMounted ? 'marketplace tab mounted' : 'marketplace tab missing',
        }

        clickSettingsTab('文档库')
        const libraryPanel = await waitFor(() => document.querySelector('[data-testid="library-tab"]') !== null, 3_000)
        let libraryIndexed = false
        let librarySearchOk = false
        if (libraryPanel) {
          document.querySelector<HTMLButtonElement>('[data-testid="library-index"]')?.click()
          libraryIndexed = await waitFor(() => {
            const value = document.querySelector('[data-testid="library-tab"] .library-status b')?.textContent ?? '0'
            return Number(value) > 0
          }, 30_000)
          const libraryInput = document.querySelector<HTMLInputElement>('[data-testid="library-search-input"]')
          if (libraryInput) {
            const setLibraryValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setLibraryValue?.call(libraryInput, 'Attachment smoke')
            libraryInput.dispatchEvent(new Event('input', { bubbles: true }))
            libraryInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
            librarySearchOk = await waitFor(
              () => document.querySelectorAll('[data-testid="library-results"] .library-result').length > 0,
              20_000,
            )
          }
        }
        checks.library = {
          ok: libraryPanel && libraryIndexed && librarySearchOk,
          detail: `panel=${libraryPanel} indexed=${libraryIndexed} search=${librarySearchOk}`,
        }
        document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') === null, 2000)

        const modelChip = document.querySelector<HTMLButtonElement>('.model-chip')
        modelChip?.click()
        const customModelMenu = await waitFor(() => document.querySelector('.model-custom') !== null, 2000)
        const modelSearch = document.querySelector<HTMLInputElement>('[data-testid="model-search"]')
        let modelSearchFiltered = false
        let modelSearchEmpty = false
        let modelGroups = false
        if (modelSearch) {
          const setModelSearch = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setModelSearch?.call(modelSearch, 'zzzz-no-model')
          modelSearch.dispatchEvent(new Event('input', { bubbles: true }))
          modelSearchEmpty = await waitFor(
            () => (document.querySelector('.model-list')?.textContent ?? '').includes('没有匹配的模型'),
            2_000,
          )
          setModelSearch?.call(modelSearch, '')
          modelSearch.dispatchEvent(new Event('input', { bubbles: true }))
          modelSearchFiltered = await waitFor(
            () => document.querySelectorAll('.model-list .model-item').length > 0,
            2_000,
          )
          modelGroups = document.querySelectorAll('.model-list .model-group').length > 0
        }
        checks.modelSearch = {
          ok: customModelMenu && Boolean(modelSearch) && modelSearchFiltered && modelSearchEmpty && modelGroups,
          detail: `search=${Boolean(modelSearch)} filtered=${modelSearchFiltered} empty=${modelSearchEmpty} groups=${modelGroups}`,
        }
        checks.customModelMenu = {
          ok: customModelMenu,
          detail: customModelMenu ? 'custom model menu mounted' : 'custom model menu missing',
        }
        const modelContextBadge = document.querySelector('.model-list .model-item-context')?.textContent?.trim() ?? ''
        checks.modelContext = {
          ok: /\d/.test(modelContextBadge),
          detail: modelContextBadge || 'context badge missing',
        }
        const contextBeforeSwitch = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
        document.querySelector<HTMLButtonElement>('.model-list .model-item.active')?.click()
        const switchMenuClosed = await waitFor(() => document.querySelector('.model-menu') === null, 2_000)
        const contextAfterSwitch = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
        checks.modelSwitchUsage = {
          ok:
            switchMenuClosed &&
            Boolean(contextBeforeSwitch) &&
            contextBeforeSwitch === contextAfterSwitch &&
            !contextAfterSwitch.startsWith('0 /'),
          detail: `${contextBeforeSwitch || 'none'} -> ${contextAfterSwitch || 'none'}`,
        }
        document.querySelector<HTMLButtonElement>('.menu-scrim')?.click()

        const toolName = 'webFetch'
        const beforeTool = snapshot?.tools.find((tool) => tool.name === toolName)?.enabled
        if (typeof beforeTool === 'boolean') {
          const toggled = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-enabled',
            params: { name: toolName, enabled: !beforeTool },
          })
          const toggledState = toggled.ok
            ? (toggled.result as SettingsActionResult).settings.tools.find((tool) => tool.name === toolName)?.enabled
            : undefined
          const restored = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-enabled',
            params: { name: toolName, enabled: beforeTool },
          })
          const restoredState = restored.ok
            ? (restored.result as SettingsActionResult).settings.tools.find((tool) => tool.name === toolName)?.enabled
            : undefined
          checks.toolSettings = {
            ok: toggledState === !beforeTool && restoredState === beforeTool,
            detail: `before=${beforeTool} toggled=${toggledState} restored=${restoredState}`,
          }
        } else {
          checks.toolSettings = { ok: false, detail: 'webFetch tool missing' }
        }

        const writeTool = snapshot?.tools.find((tool) => tool.name === 'writeFile')
        if (writeTool) {
          const on = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-always-allow',
            params: { name: 'writeFile', enabled: !writeTool.alwaysAllow },
          })
          const onValue = on.ok
            ? (on.result as SettingsActionResult).settings.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow
            : undefined
          const off = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-always-allow',
            params: { name: 'writeFile', enabled: writeTool.alwaysAllow },
          })
          const offValue = off.ok
            ? (off.result as SettingsActionResult).settings.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow
            : undefined
          checks.toolAlwaysAllow = {
            ok: onValue === !writeTool.alwaysAllow && offValue === writeTool.alwaysAllow,
            detail: `before=${writeTool.alwaysAllow} toggled=${onValue} restored=${offValue}`,
          }
        } else {
          checks.toolAlwaysAllow = { ok: false, detail: 'writeFile tool missing' }
        }

        const beforeAll = snapshot?.alwaysAllowAll ?? false
        const enableAll = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:set-always-allow-all',
          params: { enabled: !beforeAll },
        })
        const enableValue = enableAll.ok
          ? (enableAll.result as SettingsActionResult).settings.alwaysAllowAll
          : undefined
        const restoreAll = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:set-always-allow-all',
          params: { enabled: beforeAll },
        })
        const restoreValue = restoreAll.ok
          ? (restoreAll.result as SettingsActionResult).settings.alwaysAllowAll
          : undefined
        checks.allowAll = {
          ok: enableValue === !beforeAll && restoreValue === beforeAll,
          detail: `before=${beforeAll} enabled=${enableValue} restored=${restoreValue}`,
        }

        // The drawer was closed after the tab checks above; reopen it on the
        // Tools tab to exercise the sandbox row in the DOM.
        document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') !== null, 3_000)
        Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tab'))
          .find((tab) => tab.textContent?.trim() === '工具')
          ?.click()
        const sandboxRow = await waitFor(() => document.querySelector('[data-testid="shell-sandbox"]') !== null, 3_000)
        let sandboxOk = sandboxRow
        let sandboxDetail = sandboxRow ? '' : 'sandbox row missing'
        if (sandboxRow && window.xcode.platform === 'darwin') {
          const readSandboxEnabled = async (): Promise<boolean> => {
            const response = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'settings:get',
              params: {},
            })
            return response.ok ? (response.result as SettingsSnapshot).shellSandbox.enabled : false
          }
          const waitForSandbox = async (expected: boolean): Promise<boolean> => {
            for (let attempt = 0; attempt < 40; attempt++) {
              if ((await readSandboxEnabled()) === expected) return true
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            return false
          }
          // The button is disabled while the previous save is in flight; wait
          // for it to become clickable before toggling again.
          const toggleSandbox = async (): Promise<void> => {
            for (let attempt = 0; attempt < 40; attempt++) {
              const button = document
                .querySelector('[data-testid="shell-sandbox"]')
                ?.querySelector<HTMLButtonElement>('.settings-toggle')
              if (button && !button.disabled) {
                button.click()
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          const sandboxBefore = await readSandboxEnabled()
          await toggleSandbox()
          const sandboxDisabled = await waitForSandbox(!sandboxBefore)
          await toggleSandbox()
          const sandboxRestored = await waitForSandbox(sandboxBefore)
          sandboxOk = sandboxDisabled && sandboxRestored
          sandboxDetail = `before=${sandboxBefore} disabled=${sandboxDisabled} restored=${sandboxRestored}`
        } else if (sandboxRow) {
          sandboxDetail = 'unsupported platform row shown'
        }
        checks.shellSandbox = { ok: sandboxOk, detail: sandboxDetail }

        const settingsBeforeExt = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:get',
          params: {},
        })
        const extBefore = settingsBeforeExt.ok
          ? (settingsBeforeExt.result as SettingsSnapshot).shellSandbox.extensions
          : false
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:set-shell-sandbox',
          params: { extensions: !extBefore },
        })
        const settingsExtOn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:get',
          params: {},
        })
        const extToggled = settingsExtOn.ok
          ? (settingsExtOn.result as SettingsSnapshot).shellSandbox.extensions === !extBefore
          : false
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:set-shell-sandbox',
          params: { extensions: extBefore },
        })
        checks.sandboxExtensions = {
          ok: extToggled,
          detail: `before=${extBefore} toggled=${extToggled}`,
        }
        document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)

        const writeAlways = snapshot?.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow ?? false
        if (!writeAlways) {
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-always-allow',
            params: { name: 'writeFile', enabled: true },
          })
        }
        let autoApproval = false
        let autoDiff = false
        const offAutoAllow = window.xcode.onEvent((event) => {
          if (event.type === 'approval:request' && event.kind === 'permission') autoApproval = true
          if (event.type === 'agent:file-edit') autoDiff = true
        })
        const autoTurn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[tool-demo]' },
        })
        offAutoAllow()
        checks.alwaysAllowEffect = {
          ok: autoTurn.ok && !autoApproval && autoDiff,
          detail: `approval=${autoApproval} diff=${autoDiff}`,
        }

        const composerTextarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
        if (composerTextarea) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setter?.call(composerTextarea, '/')
          composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
          const paletteMounted = await waitFor(() => document.querySelector('.slash-palette') !== null, 2000)
          checks.slashPalette = {
            ok: paletteMounted,
            detail: paletteMounted ? 'command palette mounted' : 'command palette missing',
          }

          setter?.call(composerTextarea, '/usage')
          composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
          const usageSelected = await waitFor(
            () => [...document.querySelectorAll('.slash-name')].some((el) => el.textContent === '/usage'),
            2000,
          )
          if (usageSelected) {
            composerTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          }
          const usageReport = await waitFor(
            () => (document.querySelector('.report')?.textContent ?? '').includes('用量'),
            3000,
          )
          checks.slashCommand = {
            ok: usageSelected && usageReport,
            detail: `selected=${usageSelected} report=${usageReport}`,
          }
        } else {
          checks.slashPalette = { ok: false, detail: 'composer missing' }
          checks.slashCommand = { ok: false, detail: 'composer missing' }
        }

        const reportMethods = [
          'context:stats',
          'doctor:run',
          'agents:list',
          'goal:get',
          'shell:list',
          'usage:history',
          'memory:get',
        ]
        const reportDetails: string[] = []
        let reportsOk = true
        for (const method of reportMethods) {
          const response = await window.xcode.request({
            id: crypto.randomUUID(),
            method,
            params: {},
          } as unknown as RuntimeRequest)
          const text = response.ok ? (response.result as TextReport).text : ''
          if (!response.ok || text.length === 0) reportsOk = false
          reportDetails.push(`${method}=${response.ok ? text.length : 'fail'}`)
        }
        checks.commandReports = { ok: reportsOk, detail: reportDetails.join(' ') }

        const stateBefore = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:state',
          params: {},
        })
        const beforeThinking = stateBefore.ok ? (stateBefore.result as AppState).thinking : false
        const beforeMode = stateBefore.ok ? (stateBefore.result as AppState).permissionMode : 'default'
        const thinkingOn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:set-thinking',
          params: { enabled: !beforeThinking },
        })
        const thinkingRestored = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:set-thinking',
          params: { enabled: beforeThinking },
        })
        const planOn = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:set-permission-mode',
          params: { mode: 'plan' },
        })
        const planRestored = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:set-permission-mode',
          params: { mode: beforeMode === 'plan' ? 'plan' : 'default' },
        })
        checks.modeToggles = {
          ok: thinkingOn.ok && thinkingRestored.ok && planOn.ok && planRestored.ok,
          detail: `thinking=${beforeThinking} mode=${beforeMode}`,
        }

        const sidebarMounted = Boolean(
          document.querySelector('[data-testid="sidebar"]') && document.querySelectorAll('.sidebar-project').length > 0,
        )
        checks.sidebar = {
          ok: sidebarMounted,
          detail: sidebarMounted ? 'sidebar mounted with projects' : 'sidebar missing',
        }
        const sidebarToggle = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]')
        sidebarToggle?.click()
        const sidebarClosed = await waitFor(() => document.querySelector('[data-testid="sidebar"]') === null, 2000)
        sidebarToggle?.click()
        const sidebarReopened = await waitFor(() => document.querySelector('[data-testid="sidebar"]') !== null, 2000)
        checks.sidebarToggle = {
          ok: sidebarClosed && sidebarReopened,
          detail: `closed=${sidebarClosed} reopened=${sidebarReopened}`,
        }

        const searchInput = document.querySelector('.sidebar-search input') as HTMLInputElement | null
        let searchFiltered = false
        if (searchInput) {
          const setSearch = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setSearch?.call(searchInput, 'zzzz-no-match')
          searchInput.dispatchEvent(new Event('input', { bubbles: true }))
          searchFiltered = await waitFor(() => document.querySelectorAll('.sidebar-session-row').length === 0, 2_000)
          setSearch?.call(searchInput, '')
          searchInput.dispatchEvent(new Event('input', { bubbles: true }))
          await waitFor(() => document.querySelectorAll('.sidebar-session-row').length > 0, 2_000)
        }

        let renamed = false
        let deleted = false
        const firstRow = document.querySelector('.sidebar-session-row') as HTMLElement | null
        const renameButton = Array.from(firstRow?.querySelectorAll<HTMLButtonElement>('.session-action') ?? []).find(
          (button) => button.title === '重命名' || button.textContent?.trim() === '改',
        )
        renameButton?.click()
        await waitFor(() => document.querySelector('.sidebar-rename') !== null, 2_000)
        const renameInput = document.querySelector('.sidebar-rename') as HTMLInputElement | null
        if (renameInput) {
          const setRename = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setRename?.call(renameInput, 'smoke-renamed')
          renameInput.dispatchEvent(new Event('input', { bubbles: true }))
          renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          renamed = await waitFor(() => document.body.textContent?.includes('smoke-renamed') ?? false, 2_000)
        }
        const renamedRow = Array.from(document.querySelectorAll('.sidebar-session-row')).find((row) =>
          row.textContent?.includes('smoke-renamed'),
        )
        if (renamedRow) {
          const deleteButton = Array.from(renamedRow.querySelectorAll<HTMLButtonElement>('.session-action')).find(
            (button) => button.title === '删除' || button.textContent?.trim() === '删',
          )
          deleteButton?.click()
          await waitFor(() => document.querySelector('.session-action.danger') !== null, 1_500)
          document.querySelector<HTMLButtonElement>('.session-action.danger')?.click()
          deleted = await waitFor(() => !(document.body.textContent ?? '').includes('smoke-renamed'), 2_000)
        }
        checks.sessionManagement = {
          ok: searchFiltered && renamed && deleted,
          detail: `search=${searchFiltered} row=${Boolean(firstRow)} button=${Boolean(renameButton)} input=${Boolean(renameInput)} rename=${renamed} delete=${deleted}`,
        }
        document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
        const placeholderReady = await waitFor(
          () => document.querySelector('.sidebar-session-placeholder') !== null,
          2_000,
        )
        checks.newSessionPlaceholder = {
          ok: placeholderReady,
          detail: placeholderReady ? '新会话 placeholder shown' : 'placeholder missing',
        }

        document.querySelector<HTMLButtonElement>('[data-testid="task-mode-chip"]')?.click()
        const modeMenu = await waitFor(() => document.querySelector('[data-testid="task-mode-menu"]') !== null, 2_000)
        Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-item'))
          .find((button) => button.textContent?.trim() === '写作')
          ?.click()
        const writingHint = await waitFor(
          () => (document.querySelector('.empty-sub')?.textContent ?? '').includes('说说你想写什么'),
          3_000,
        )
        const suggestionChips = document.querySelectorAll('.mode-suggestion').length === 3
        const modeState = await window.xcode.request({ id: crypto.randomUUID(), method: 'app:state', params: {} })
        const modePersisted = modeState.ok && (modeState.result as AppState).taskMode === 'writing'
        document.querySelector<HTMLButtonElement>('[data-testid="task-mode-chip"]')?.click()
        await waitFor(() => document.querySelector('[data-testid="task-mode-menu"]') !== null, 2_000)
        Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-item'))
          .find((button) => button.textContent?.trim() === '编程')
          ?.click()
        const backToCoding = await waitFor(
          () => (document.querySelector('[data-testid="task-mode-chip"]')?.textContent ?? '').includes('编程'),
          3_000,
        )
        checks.taskMode = {
          ok: modeMenu && writingHint && suggestionChips && modePersisted && backToCoding,
          detail: `menu=${modeMenu} hint=${writingHint} suggestions=${suggestionChips} persisted=${modePersisted} back=${backToCoding}`,
        }

        await openDocument(`${workspace}/README.md`)
        const markdownPreview = await waitFor(
          () => document.querySelector('[data-testid="document-drawer"] .markdown') !== null,
          3_000,
        )
        await openDocument(`${workspace}/data.csv`)
        const csvPreview = await waitFor(
          () => document.querySelectorAll('[data-testid="document-drawer"] .document-table tr').length >= 2,
          3_000,
        )
        await openDocument(`${workspace}/sample.pdf`)
        const pdfPageText = await waitFor(
          () =>
            (document.querySelector('[data-testid="document-drawer"] .document-page-text')?.textContent ?? '').includes(
              'Page 1',
            ),
          5_000,
        )
        checks.documentPanel = {
          ok: markdownPreview && csvPreview && pdfPageText,
          detail: `markdown=${markdownPreview} csv=${csvPreview} pdfPageText=${pdfPageText}`,
        }
        setDocumentOpen(false)

        let reviewApproved = false
        const offReview = window.xcode.onEvent((event) => {
          if (event.type === 'approval:request' && event.kind === 'permission') {
            reviewApproved = true
            void window.xcode.request({
              id: crypto.randomUUID(),
              method: 'approval:respond',
              params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
            })
          }
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: '[review-demo]' },
        })
        offReview()
        await openDocument(`${workspace}/README.md`)
        const reviewBar = await waitFor(() => document.querySelector('.document-review-bar') !== null, 4_000)
        const reviewButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.document-review-bar .settings-btn'),
        ).find((button) => button.textContent?.includes('查看改动'))
        reviewButton?.click()
        const hunksReady = await waitFor(() => document.querySelectorAll('.document-hunk').length > 0, 4_000)
        const applyButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.document-diff-head .settings-btn'),
        ).find((button) => button.textContent?.includes('应用所选'))
        applyButton?.click()
        const reviewCleared = await waitFor(
          () =>
            document.querySelector('.document-review-bar') === null &&
            document.querySelector('.document-diff') === null,
          5_000,
        )
        checks.documentReview = {
          ok: reviewApproved && reviewBar && hunksReady && reviewCleared,
          detail: `approved=${reviewApproved} bar=${reviewBar} hunks=${hunksReady} applied=${reviewCleared}`,
        }
        setDocumentOpen(false)

        let rememberedDocument = ''
        try {
          const map = JSON.parse(localStorage.getItem('xcode.lastDocuments') ?? '{}') as Record<string, string>
          rememberedDocument = map[workspace] ?? ''
        } catch {
          rememberedDocument = ''
        }
        await openDocument(`${workspace}/missing-document.pdf`)
        const missingReported = await waitFor(
          () => document.querySelector('[data-testid="document-drawer"] .settings-warn') !== null,
          2_000,
        )
        document
          .querySelector<HTMLButtonElement>('[data-testid="document-drawer"] .drawer-head .btn:last-child')
          ?.click()
        await waitFor(() => document.querySelector('[data-testid="document-drawer"]') === null, 2_000)
        localStorage.removeItem('xcode.lastDocuments')
        const reopenMenu = await openToolsMenu()
        document.querySelector<HTMLButtonElement>('[data-testid="document-toggle"]')?.click()
        const reopenDrawer = await waitFor(
          () => document.querySelector('[data-testid="document-drawer"]') !== null,
          3_000,
        )
        const recentSwitcher = await waitFor(
          () => document.querySelector('[data-testid="document-drawer"] .document-switcher') !== null,
          2_000,
        )
        document
          .querySelector<HTMLButtonElement>('[data-testid="document-drawer"] .drawer-head .btn:last-child')
          ?.click()
        await waitFor(() => document.querySelector('[data-testid="document-drawer"]') === null, 2_000)
        checks.documentRemember = {
          ok: rememberedDocument.endsWith('README.md') && missingReported,
          detail: `remembered=${rememberedDocument} missingReported=${missingReported}`,
        }
        checks.documentReopen = {
          ok: reopenMenu && reopenDrawer && recentSwitcher,
          detail: `menu=${reopenMenu} drawer=${reopenDrawer} recents=${recentSwitcher}`,
        }

        const gitMenu = await openToolsMenu()
        document.querySelector<HTMLButtonElement>('[data-testid="git-toggle"]')?.click()
        const gitDrawer = await waitFor(() => document.querySelector('[data-testid="git-drawer"]') !== null, 3_000)
        const gitChanges = await waitFor(
          () => document.querySelectorAll('[data-testid="git-drawer"] .git-file').length > 0,
          4_000,
        )
        const readmeGitFile = Array.from(document.querySelectorAll<HTMLButtonElement>('.git-file')).find((button) =>
          button.textContent?.includes('README.md'),
        )
        readmeGitFile?.click()
        const gitDiffReady = await waitFor(
          () => (document.querySelector('.git-diff-body')?.textContent ?? '').includes('Reviewed change'),
          4_000,
        )
        const undoButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.git-drawer .drawer-head .btn'),
        ).find((button) => button.textContent?.includes('撤销本轮'))
        undoButton?.click()
        // Undo restores the turn's changes; pre-existing untracked paths such
        // as the workspace `.x-code` directory remain by design.
        const gitUndone = await waitFor(
          () =>
            !Array.from(document.querySelectorAll('[data-testid="git-drawer"] .git-file')).some((button) =>
              button.textContent?.includes('README.md'),
            ),
          6_000,
        )
        const gitWarning = document.querySelector('[data-testid="git-drawer"] .settings-warn')?.textContent ?? ''
        const gitSummary = document.querySelector('[data-testid="git-drawer"] .git-summary')?.textContent ?? ''
        checks.git = {
          ok: gitMenu && gitDrawer && gitChanges && gitDiffReady && gitUndone,
          detail: `menu=${gitMenu} drawer=${gitDrawer} changes=${gitChanges} diff=${gitDiffReady} undone=${gitUndone} files=${
            document.querySelectorAll('[data-testid="git-drawer"] .git-file').length
          } summary=${gitSummary.slice(0, 60)} warning=${gitWarning.slice(0, 80)}`,
        }
        document.querySelector<HTMLButtonElement>('[data-testid="git-drawer"] .drawer-head .btn:last-child')?.click()

        const checksMenu = await openToolsMenu()
        document.querySelector<HTMLButtonElement>('[data-testid="checks-toggle"]')?.click()
        const checksDrawer = await waitFor(
          () => document.querySelector('[data-testid="checks-drawer"]') !== null,
          3_000,
        )
        const checksDetected = await waitFor(
          () => document.querySelectorAll('[data-testid="checks-drawer"] .check-item').length >= 2,
          5_000,
        )
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="checks-drawer"] .drawer-head .btn'))
          .find((button) => button.textContent?.includes('运行全部'))
          ?.click()
        const checksRan = await waitFor(
          () => document.querySelector('[data-testid="checks-drawer"] .check-status.failed') !== null,
          30_000,
        )
        const checksFixAction = document.querySelector('[data-testid="checks-drawer"] .checks-actions') !== null
        checks.checkPanel = {
          ok: checksMenu && checksDrawer && checksDetected && checksRan && checksFixAction,
          detail: `menu=${checksMenu} drawer=${checksDrawer} detected=${checksDetected} failed=${checksRan} fix=${checksFixAction}`,
        }
        document.querySelector<HTMLButtonElement>('[data-testid="checks-drawer"] .drawer-head .btn:last-child')?.click()

        const pluginPath = `${workspace}/.smoke-plugin`
        const pluginPreviewResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'plugins:preview',
          params: { target: { kind: 'path', path: pluginPath } },
        })
        const pluginPreviewOk =
          pluginPreviewResponse.ok &&
          ((pluginPreviewResponse.result as { userConfig?: unknown[] }).userConfig?.length ?? 0) === 2
        const pluginInstallResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'plugins:install',
          params: {
            target: { kind: 'path', path: pluginPath },
            userConfig: { SMOKE_TOKEN: 's3cret', SMOKE_REGION: 'us' },
          },
        })
        const pluginConfigResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'plugins:user-config',
          params: { id: 'smoke-plugin@local' },
        })
        const pluginConfig = pluginConfigResponse.ok
          ? (pluginConfigResponse.result as {
              fields: unknown[]
              values: Record<string, unknown>
              setKeys: string[]
            })
          : null
        const pluginConfigOk =
          Boolean(pluginConfig) &&
          pluginConfig!.setKeys.includes('SMOKE_TOKEN') &&
          pluginConfig!.setKeys.includes('SMOKE_REGION') &&
          pluginConfig!.values.SMOKE_REGION === 'us' &&
          pluginConfig!.values.SMOKE_TOKEN === undefined
        const pluginSaveResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'plugins:save-user-config',
          params: { id: 'smoke-plugin@local', values: { SMOKE_REGION: 'cn' } },
        })
        const pluginAfterResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'plugins:user-config',
          params: { id: 'smoke-plugin@local' },
        })
        const pluginUpdatedOk =
          pluginSaveResponse.ok &&
          (pluginAfterResponse.ok
            ? (pluginAfterResponse.result as { values: Record<string, unknown> }).values.SMOKE_REGION === 'cn'
            : false)
        const pluginSettingsResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:get',
          params: {},
        })
        const pluginListed =
          pluginSettingsResponse.ok &&
          (pluginSettingsResponse.result as SettingsSnapshot).plugins.some(
            (plugin) => plugin.id === 'smoke-plugin@local' && (plugin.userConfig?.length ?? 0) === 2,
          )
        checks.pluginConfig = {
          ok: pluginPreviewOk && pluginInstallResponse.ok && pluginConfigOk && pluginUpdatedOk && pluginListed,
          detail: `preview=${pluginPreviewOk} install=${pluginInstallResponse.ok} config=${pluginConfigOk} updated=${pluginUpdatedOk} listed=${pluginListed}`,
        }
        checks.attachButton = {
          ok: Boolean(document.querySelector('.composer .attach')),
          detail: document.querySelector('.composer .attach') ? 'document picker mounted' : 'document picker missing',
        }
        const attachButtonElement = document.querySelector<HTMLButtonElement>('.composer .btn.attach')
        const attachIcon = attachButtonElement?.querySelector('svg')
        let attachCentered = false
        let attachCenterDetail = 'button or icon missing'
        if (attachButtonElement && attachIcon) {
          const buttonRect = attachButtonElement.getBoundingClientRect()
          const iconRect = attachIcon.getBoundingClientRect()
          const dx = iconRect.left + iconRect.width / 2 - (buttonRect.left + buttonRect.width / 2)
          const dy = iconRect.top + iconRect.height / 2 - (buttonRect.top + buttonRect.height / 2)
          attachCentered = Math.abs(dx) < 1 && Math.abs(dy) < 1
          attachCenterDetail = `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`
        }
        checks.attachCentered = { ok: attachCentered, detail: attachCenterDetail }
        if (!writeAlways) {
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'settings:set-tool-always-allow',
            params: { name: 'writeFile', enabled: false },
          })
        }

        let output = ''
        const offShell = window.xcode.onEvent((event) => {
          if (event.type === 'shell:output') output += event.data
        })
        const created = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'shell:create',
          params: { cols: 80, rows: 24 },
        })
        let shellOk = false
        let shellDetail = ''
        if (!created.ok) {
          shellDetail = created.error.message
        } else {
          const id = (created.result as { id: string }).id
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'shell:write',
            params: { id, data: 'echo ui-shell-ok\r' },
          })
          shellOk = await waitFor(() => output.includes('ui-shell-ok'), 8000)
          shellDetail = shellOk ? 'pty echoed marker' : `marker missing; output=${JSON.stringify(output.slice(0, 160))}`
          await window.xcode.request({ id: crypto.randomUUID(), method: 'shell:kill', params: { id } })
        }
        offShell()
        checks.shell = { ok: shellOk, detail: shellDetail }

        const diagnostics = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'smoke:run',
          params: {},
        })
        checks.diagnostics = {
          ok: diagnostics.ok && (diagnostics.result as SmokeReport).ok === true,
          detail: diagnostics.ok ? 'diagnostics completed without exiting' : diagnostics.error.message,
        }

        checks.terminalDefault = {
          ok: document.querySelector('[data-testid="terminal-shell"]') === null,
          detail: 'terminal closed by default',
        }
        const toggle = document.querySelector<HTMLButtonElement>('[data-testid="terminal-toggle"]')
        toggle?.click()
        const mounted = await waitFor(() => document.querySelector('[data-testid="terminal-shell"]') !== null, 3000)
        checks.terminalToggle = {
          ok: mounted,
          detail: mounted ? 'terminal mounted on demand' : 'terminal did not mount',
        }
        toggle?.click()
        await waitFor(() => document.querySelector('[data-testid="terminal-shell"]') === null, 2000)

        checks.renderer = {
          ok: Boolean(document.getElementById('root')?.childElementCount),
          detail: `title=${document.title} platform=${window.xcode.platform}`,
        }

        const themeMenu = await openToolsMenu()
        const themes: string[] = []
        for (let index = 0; index < 3; index++) {
          document.querySelector<HTMLButtonElement>('[data-testid="theme-toggle"]')?.click()
          await new Promise((resolve) => setTimeout(resolve, 30))
          themes.push(document.documentElement.dataset.theme ?? '')
        }
        const themeOk = new Set(themes).size >= 2
        document.querySelector<HTMLButtonElement>('[data-testid="language-toggle"]')?.click()
        const switchedToEnglish = await waitFor(
          () => (document.querySelector('.sidebar-title')?.textContent ?? '') === 'Projects',
          2_000,
        )
        document.querySelector<HTMLButtonElement>('[data-testid="language-toggle"]')?.click()
        const switchedBack = await waitFor(
          () => (document.querySelector('.sidebar-title')?.textContent ?? '') === '项目',
          2_000,
        )
        document.querySelector<HTMLButtonElement>('[data-testid="tools-menu-toggle"]')?.click()
        checks.themeLanguage = {
          ok: themeMenu && themeOk && switchedToEnglish && switchedBack,
          detail: `menu=${themeMenu} themes=${themes.join('>')} en=${switchedToEnglish} zh=${switchedBack}`,
        }

        document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
        await waitFor(() => document.querySelector('.sidebar-session-placeholder') !== null, 2_000)

        const pngBase64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        const pasted = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:save-pasted-image',
          params: {
            data: pngBase64,
            mime: 'image/png',
          },
        })
        const pastedPath = pasted.ok ? (pasted.result as { path: string }).path : ''
        checks.pasteImage = {
          ok: pasted.ok && pastedPath.endsWith('.png'),
          detail: pasted.ok ? pastedPath : pasted.error.message,
        }
        const imagePreview = pastedPath
          ? await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'app:image-preview',
              params: { path: pastedPath },
            })
          : null
        checks.imagePreview = {
          ok:
            imagePreview?.ok === true &&
            (imagePreview.result as { dataUrl: string }).dataUrl.startsWith('data:image/png;base64,'),
          detail:
            imagePreview === null ? 'no pasted image' : imagePreview.ok ? 'data:image/png' : imagePreview.error.message,
        }
        const pasteComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
        if (pasteComposer) {
          const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0))
          const transfer = new DataTransfer()
          transfer.items.add(new File([bytes], 'smoke-paste.png', { type: 'image/png' }))
          pasteComposer.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
          )
          const thumbReady = await waitFor(
            () => document.querySelector('.attachment-chip .attachment-thumb') !== null,
            4_000,
          )
          document.querySelector<HTMLButtonElement>('.attachment-chip .attachment-thumb-button')?.click()
          const lightbox = await waitFor(
            () => document.querySelector('[data-testid="image-lightbox"] img') !== null,
            2_000,
          )
          document.querySelector<HTMLButtonElement>('.image-lightbox-card .btn-quiet')?.click()
          const lightboxClosed = await waitFor(
            () => document.querySelector('[data-testid="image-lightbox"]') === null,
            2_000,
          )
          const userCountBeforeImage = document.querySelectorAll('.message.user').length
          const pasteValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          pasteValue?.call(pasteComposer, 'image attachment smoke')
          pasteComposer.dispatchEvent(new Event('input', { bubbles: true }))
          pasteComposer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          const imageUserSent = await waitFor(
            () => document.querySelectorAll('.message.user').length > userCountBeforeImage,
            4_000,
          )
          const messageImage = await waitFor(
            () =>
              document
                .querySelector<HTMLImageElement>('.message.user .message-attachments img')
                ?.src.startsWith('data:image/png') ?? false,
            4_000,
          )
          await waitFor(() => document.querySelector('.send.stop') === null, 15_000)
          checks.imageAttachmentUi = {
            ok: thumbReady && lightbox && lightboxClosed,
            detail: `thumb=${thumbReady} lightbox=${lightbox}/${lightboxClosed}`,
          }
          checks.imageMessage = {
            ok: imageUserSent && messageImage,
            detail: `sent=${imageUserSent} image=${messageImage}`,
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
          const activeImageId = document.querySelector('.tab-item.active')?.getAttribute('data-session-id') ?? ''
          const imageSessionList = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:list',
            params: {},
          })
          const imageItems = imageSessionList.ok ? (imageSessionList.result as SessionListItem[]) : []
          const imageItem = imageItems.find((item) => item.sessionId === activeImageId)
          let restoredImage = false
          let cleanRestoredText = false
          let restoreDetail = imageItem ? 'session missing' : 'active session missing'
          if (imageItem) {
            const loaded = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'session:load',
              params: { filePath: imageItem.filePath },
            })
            if (loaded.ok) {
              const view = loaded.result as LoadedSessionView
              const restoredUser = view.messages.find(
                (message) => message.role === 'user' && (message.attachmentViews?.length ?? 0) > 0,
              )
              restoredImage =
                restoredUser?.attachmentViews?.some(
                  (attachment) =>
                    attachment.dataUrl?.startsWith('data:image/') === true ||
                    (attachment.path ? isImageAttachment(attachment.path) : false),
                ) ?? false
              cleanRestoredText =
                Boolean(restoredUser) &&
                !(restoredUser?.text.includes('@"/') ?? false) &&
                !(restoredUser?.text.includes('[Image ') ?? false)
              restoreDetail = `views=${restoredUser?.attachmentViews?.length ?? 0} image=${restoredImage} clean=${cleanRestoredText}`
            } else {
              restoreDetail = loaded.error.message
            }
          }
          checks.imageSessionRestore = {
            ok: restoredImage && cleanRestoredText,
            detail: restoreDetail,
          }
        } else {
          checks.imageAttachmentUi = { ok: false, detail: 'composer missing' }
          checks.imageMessage = { ok: false, detail: 'composer missing' }
          checks.imageSessionRestore = { ok: false, detail: 'composer missing' }
        }

        const background = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'background:list',
          params: {},
        })
        checks.backgroundList = {
          ok: background.ok && Array.isArray((background.result as { sessions: unknown[] }).sessions),
          detail: background.ok
            ? `${(background.result as { sessions: unknown[] }).sessions.length} background session(s)`
            : background.error.message,
        }

        // A fresh turn guarantees the active session has a rewind checkpoint.
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'agent:submit',
          params: { prompt: 'rewind smoke' },
        })
        const checkpointResponse = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:checkpoints',
          params: {},
        })
        const checkpoints = checkpointResponse.ok
          ? (checkpointResponse.result as { checkpoints: Array<{ ckptId: string; messageCount: number }> }).checkpoints
          : []
        const latestCheckpoint = checkpoints[checkpoints.length - 1]
        let rewindOk = false
        let rewindDetail = 'no checkpoint recorded'
        if (latestCheckpoint) {
          const rewound = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:rewind',
            params: { ckptId: latestCheckpoint.ckptId, mode: 'both' },
          })
          const rewoundView = rewound.ok
            ? (rewound.result as { messageCount: number; view: { messages: unknown[] } })
            : null
          rewindOk =
            rewound.ok && rewoundView !== null && rewoundView.messageCount === latestCheckpoint.messageCount - 1
          rewindDetail = rewound.ok
            ? `checkpoint at ${latestCheckpoint.messageCount} → ${rewoundView?.messageCount}`
            : rewound.error.message
        }
        checks.rewind = { ok: rewindOk, detail: rewindDetail }

        const forked = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:fork',
          params: { name: 'smoke fork' },
        })
        const forkView = forked.ok ? (forked.result as { sessionId: string; view: { messages: unknown[] } }).view : null
        checks.fork = {
          ok: forked.ok && forkView !== null && forkView.messages.length > 0,
          detail: forked.ok
            ? `${(forked.result as { sessionId: string }).sessionId} (${forkView?.messages.length ?? 0} messages)`
            : forked.error.message,
        }

        const commandList = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'commands:list',
          params: {},
        })
        const savedCommand = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'commands:save',
          params: {
            name: 'smoke-command',
            description: 'Smoke command',
            body: 'echo $ARGUMENTS',
            scope: 'user',
          },
        })
        const ranCommand = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'commands:run',
          params: { name: 'smoke-command', args: 'hello' },
        })
        const deletedCommand = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'commands:delete',
          params: { name: 'smoke-command', scope: 'user' },
        })
        checks.commands = {
          ok:
            commandList.ok &&
            savedCommand.ok &&
            ranCommand.ok &&
            deletedCommand.ok &&
            (ranCommand.result as { prompt: string }).prompt === 'echo hello',
          detail: ranCommand.ok
            ? `prompt=${JSON.stringify((ranCommand.result as { prompt: string }).prompt)}`
            : ranCommand.error.message,
        }

        const savedHooks = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:save',
          params: { scope: 'user', config: { TurnComplete: [{ command: 'true' }] } },
        })
        const hookView = savedHooks.ok ? (savedHooks.result as HooksView) : null
        const hookActive = hookView?.active.some((hook) => hook.event === 'TurnComplete' && hook.source === 'user')
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:save',
          params: { scope: 'user', config: {} },
        })
        const projectSaved = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:save',
          params: { scope: 'project', config: { TurnComplete: [{ command: 'true' }] } },
        })
        const projectSavedView = projectSaved.ok ? (projectSaved.result as HooksView) : null
        const projectInactiveBeforeTrust =
          projectSavedView?.projectHooksPresent === true &&
          projectSavedView.projectTrusted === false &&
          !projectSavedView.active.some((hook) => hook.source === 'project')
        const trustedProject = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:trust-project',
          params: { trusted: true },
        })
        const trustedProjectView = trustedProject.ok ? (trustedProject.result as HooksView) : null
        const projectActiveAfterTrust =
          trustedProjectView?.projectTrusted === true &&
          trustedProjectView.active.some((hook) => hook.source === 'project')
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:trust-project',
          params: { trusted: false },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'hooks:save',
          params: { scope: 'project', config: {} },
        })
        checks.projectHooksTrust = {
          ok: projectInactiveBeforeTrust && projectActiveAfterTrust,
          detail: `beforeTrust=${projectInactiveBeforeTrust} afterTrust=${projectActiveAfterTrust}`,
        }
        checks.hooks = {
          ok: savedHooks.ok && hookActive === true,
          detail: savedHooks.ok ? `active=${hookActive} hooks=${hookView?.active.length}` : savedHooks.error.message,
        }

        const memoryPanel = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'memory:panel',
          params: {},
        })
        checks.memory = {
          ok:
            memoryPanel.ok &&
            Array.isArray((memoryPanel.result as { topics: unknown[] }).topics) &&
            typeof (memoryPanel.result as { root: string }).root === 'string',
          detail: memoryPanel.ok
            ? `topics=${(memoryPanel.result as { topics: unknown[] }).topics.length}`
            : memoryPanel.error.message,
        }

        document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') !== null, 3_000)
        const clickTab = (label: string): void => {
          Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tab'))
            .find((tab) => tab.textContent?.trim() === label)
            ?.click()
        }
        clickTab('命令')
        const commandTab = await waitFor(() => document.querySelector('.command-list') !== null, 3_000)
        clickTab('Hooks')
        const hooksTab = await waitFor(
          () => document.querySelector('.hook-list') !== null || document.querySelector('.settings-warn') !== null,
          3_000,
        )
        clickTab('记忆')
        const memoryTab = await waitFor(() => document.querySelector('.memory-stats') !== null, 5_000)
        clickTab('项目')
        const projectTab = await waitFor(
          () => document.querySelector('[data-testid="project-workspace"]') !== null,
          3_000,
        )
        clickTab('存储')
        const storageTab = await waitFor(() => document.querySelector('.storage-list') !== null, 3_000)
        document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)
        checks.iteration2Tabs = {
          ok: commandTab && hooksTab && memoryTab && projectTab && storageTab,
          detail: `commands=${commandTab} hooks=${hooksTab} memory=${memoryTab} project=${projectTab} storage=${storageTab}`,
        }

        const discoveredModels = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'models:discover',
          params: {},
        })
        const localModelCount = discoveredModels.ok
          ? (discoveredModels.result as AppState).models.filter(
              (model) => model.id.startsWith('ollama:') || model.id.startsWith('lmstudio:'),
            ).length
          : -1
        checks.localModels = {
          ok: discoveredModels.ok && localModelCount >= 0,
          detail: discoveredModels.ok ? `${localModelCount} local model(s)` : discoveredModels.error.message,
        }

        const updateCheck = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:check-update',
          params: { feed: '' },
        })
        const updateResult = updateCheck.ok ? (updateCheck.result as UpdateCheckResult) : null
        checks.updateCheck = {
          ok: updateCheck.ok && updateResult?.configured === false && Boolean(updateResult.currentVersion),
          detail: updateCheck.ok
            ? `current=${updateResult?.currentVersion} configured=${updateResult?.configured}`
            : updateCheck.error.message,
        }

        const zoomUp = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:set-zoom',
          params: { factor: 1.2 },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:set-zoom',
          params: { factor: 1 },
        })
        checks.zoom = {
          ok: zoomUp.ok && (zoomUp.result as { factor: number }).factor === 1.2,
          detail: zoomUp.ok ? `applied ${(zoomUp.result as { factor: number }).factor}` : zoomUp.error.message,
        }

        const silentWav = encodeWav([new Float32Array(8_000)], 16_000)
        const transcription = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'audio:transcribe',
          params: { data: base64FromBuffer(silentWav), mime: 'audio/wav', language: 'en' },
        })
        checks.transcription = {
          ok: transcription.ok && typeof (transcription.result as { text: string }).text === 'string',
          detail: transcription.ok
            ? `text=${JSON.stringify((transcription.result as { text: string }).text.slice(0, 40))}`
            : transcription.error.message,
        }

        const fileList = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:list',
          params: { path: '.' },
        })
        const readmeRead = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:read',
          params: { path: 'README.md' },
        })
        const createdFile = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:create',
          params: { path: 'smoke-editor.txt', content: 'line-one\n' },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:write',
          params: { path: 'smoke-editor.txt', content: 'line-two\n' },
        })
        const rereadFile = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:read',
          params: { path: 'smoke-editor.txt' },
        })
        checks.filesApi = {
          ok:
            fileList.ok &&
            readmeRead.ok &&
            createdFile.ok &&
            rereadFile.ok &&
            (readmeRead.result as { content: string }).content.includes('Smoke workspace') &&
            (rereadFile.result as { content: string }).content === 'line-two\n',
          detail: `list=${fileList.ok} read=${readmeRead.ok} create=${createdFile.ok} write=${rereadFile.ok}`,
        }

        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:create',
          params: {
            path: 'smoke-preview.html',
            content: '<!doctype html><html><body><h1>Preview OK</h1></body></html>',
          },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:create',
          params: {
            path: 'smoke-highlight.ts',
            content: 'const answer: number = 42\n',
          },
        })
        const filesMenu = await openToolsMenu()
        document.querySelector<HTMLButtonElement>('[data-testid="files-toggle"]')?.click()
        const fileDrawer = await waitFor(() => document.querySelector('[data-testid="file-drawer"]') !== null, 3_000)
        const fileRows = await waitFor(
          () => (document.querySelectorAll('[data-testid="file-drawer"] .file-row').length ?? 0) > 2,
          3_000,
        )
        const editorRow = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
        ).find((row) => row.textContent?.includes('smoke-editor.txt'))
        editorRow?.click()
        const editorMounted = await waitFor(
          () => document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea') !== null,
          3_000,
        )
        const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea')
        let editorSaved = false
        if (editor) {
          const setEditorValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setEditorValue?.call(editor, 'line-three\n')
          editor.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 50))
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
            .find((button) => button.textContent?.trim() === '保存')
            ?.click()
          editorSaved = false
          const saveStarted = Date.now()
          while (Date.now() - saveStarted < 3_000 && !editorSaved) {
            const response = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'files:read',
              params: { path: 'smoke-editor.txt' },
            })
            editorSaved = response.ok && (response.result as { content: string }).content === 'line-three\n'
            if (!editorSaved) await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        const previewRow = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
        ).find((row) => row.textContent?.includes('smoke-preview.html'))
        previewRow?.click()
        await waitFor(
          () => document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea') !== null,
          2_000,
        )
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
          .find((button) => button.textContent?.trim() === '预览')
          ?.click()
        const previewButtons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'),
        ).map((button) => button.textContent?.trim())
        const filePreview = await waitFor(() => document.querySelector('[data-testid="file-preview"]') !== null, 1_500)
        const highlightRow = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
        ).find((row) => row.textContent?.includes('smoke-highlight.ts'))
        highlightRow?.click()
        const syntaxHighlighted = await waitFor(
          () =>
            document.querySelector(
              '[data-testid="file-drawer"] .file-highlight .hljs-keyword, [data-testid="file-drawer"] .file-highlight .hljs-number',
            ) !== null,
          3_000,
        )
        const highlightEditor = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="file-drawer"] .file-textarea',
        )
        const editorGutter = document.querySelectorAll('[data-testid="file-drawer"] .file-gutter span').length >= 1
        let editorCursor = false
        if (highlightEditor) {
          highlightEditor.selectionStart = highlightEditor.value.length
          highlightEditor.selectionEnd = highlightEditor.value.length
          highlightEditor.dispatchEvent(new Event('select', { bubbles: true }))
          highlightEditor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 80))
          const statusText = document.querySelector('[data-testid="editor-status"]')?.textContent ?? ''
          editorCursor = statusText.includes('第 2 行') && statusText.includes('第 1 列')
        }
        let highlightSaved = false
        if (highlightEditor) {
          const setHighlightValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setHighlightValue?.call(highlightEditor, 'const answer: number = 43\n')
          highlightEditor.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 50))
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
            .find((button) => button.textContent?.trim() === '保存')
            ?.click()
          const started = Date.now()
          while (Date.now() - started < 3_000 && !highlightSaved) {
            const response = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'files:read',
              params: { path: 'smoke-highlight.ts' },
            })
            highlightSaved =
              response.ok && (response.result as { content: string }).content === 'const answer: number = 43\n'
            if (!highlightSaved) await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        document.querySelector<HTMLButtonElement>('[data-testid="file-drawer"] .drawer-head .btn:last-child')?.click()
        await waitFor(() => document.querySelector('[data-testid="file-drawer"]') === null, 2_000)
        checks.fileEditor = {
          ok:
            filesMenu &&
            fileDrawer &&
            fileRows &&
            editorMounted &&
            editorSaved &&
            filePreview &&
            syntaxHighlighted &&
            highlightSaved &&
            editorGutter &&
            editorCursor,
          detail: `menu=${filesMenu} drawer=${fileDrawer} rows=${fileRows} editor=${editorMounted} saved=${editorSaved} preview=${filePreview} highlight=${syntaxHighlighted} editSaved=${highlightSaved} gutter=${editorGutter} cursor=${editorCursor} row=${Boolean(previewRow)} buttons=${previewButtons.join('|')}`,
        }

        const setInputValue = (input: HTMLInputElement, value: string): void => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
        const paletteMounted = await waitFor(
          () => document.querySelector('[data-testid="command-palette"]') !== null,
          2_000,
        )
        const paletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
        let paletteRows = 0
        let paletteFileFound = false
        if (paletteInput) {
          setInputValue(paletteInput, '设置')
          await waitFor(() => document.querySelectorAll('.palette-row').length > 0, 2_000)
          paletteRows = document.querySelectorAll('.palette-row').length
          setInputValue(paletteInput, 'README')
          paletteFileFound = await waitFor(
            () =>
              Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('README')),
            3_000,
          )
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        const paletteClosed = await waitFor(
          () => document.querySelector('[data-testid="command-palette"]') === null,
          2_000,
        )

        window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }))
        const shortcutMounted = await waitFor(
          () => document.querySelector('[data-testid="shortcut-sheet"]') !== null,
          2_000,
        )
        document.querySelector<HTMLButtonElement>('[data-testid="shortcut-sheet"] .btn-quiet')?.click()
        const shortcutClosed = await waitFor(
          () => document.querySelector('[data-testid="shortcut-sheet"]') === null,
          2_000,
        )

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
        const findMounted = await waitFor(
          () => document.querySelector<HTMLInputElement>('[data-testid="find-bar"] input') !== null,
          2_000,
        )
        const findInput = document.querySelector<HTMLInputElement>('[data-testid="find-bar"] input')
        let findCount = ''
        if (findInput) {
          setInputValue(findInput, '演示')
          await new Promise((resolve) => setTimeout(resolve, 100))
          findCount = document.querySelector('[data-testid="find-bar"] .find-count')?.textContent ?? ''
          findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await waitFor(() => document.querySelector('[data-testid="find-bar"]') === null, 2_000)

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
        await waitFor(() => document.querySelector('[data-testid="command-palette"]') !== null, 2_000)
        const deepPaletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
        if (deepPaletteInput) setInputValue(deepPaletteInput, '项目设置')
        await waitFor(
          () =>
            Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('项目设置')),
          2_000,
        )
        deepPaletteInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        const deepLink = await waitFor(
          () =>
            document.querySelector('.settings-drawer') !== null &&
            document.querySelector('[data-testid="project-workspace"]') !== null,
          3_000,
        )
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
        await waitFor(() => document.querySelector('[data-testid="command-palette"]') !== null, 2_000)
        const switchPaletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
        if (switchPaletteInput) setInputValue(switchPaletteInput, '存储与清理')
        await waitFor(
          () =>
            Array.from(document.querySelectorAll('.palette-row')).some((row) =>
              row.textContent?.includes('存储与清理'),
            ),
          2_000,
        )
        switchPaletteInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        const tabSwitchWhileOpen = await waitFor(() => document.querySelector('.storage-list') !== null, 3_000)
        document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
        await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)
        checks.paletteShortcuts = {
          ok:
            paletteMounted &&
            paletteRows > 0 &&
            paletteFileFound &&
            paletteClosed &&
            shortcutMounted &&
            shortcutClosed &&
            findMounted &&
            findCount.includes('/') &&
            deepLink &&
            tabSwitchWhileOpen,
          detail: `palette=${paletteMounted} rows=${paletteRows} file=${paletteFileFound} closed=${paletteClosed} sheet=${shortcutMounted}/${shortcutClosed} find=${findMounted} count=${findCount} deepLink=${deepLink} switchOpen=${tabSwitchWhileOpen}`,
        }

        const continuityComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
        const userCountBefore = document.querySelectorAll('.message.user').length
        let continuityDetail = 'composer missing'
        let continuityOk = false
        if (continuityComposer) {
          const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setTextareaValue?.call(continuityComposer, 'ui continuity smoke')
          continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
          continuityComposer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          const userAdded = await waitFor(
            () => document.querySelectorAll('.message.user').length > userCountBefore,
            4_000,
          )
          await waitFor(() => document.querySelector('.send.stop') !== null, 2_000)
          const turnSettled = await waitFor(() => document.querySelector('.send.stop') === null, 15_000)
          const lastUser = Array.from(document.querySelectorAll('.message.user')).pop()
          const editButton = Array.from(lastUser?.querySelectorAll<HTMLButtonElement>('.copy-btn') ?? []).find(
            (button) => button.textContent?.includes('编辑并重发'),
          )
          editButton?.click()
          const editBadge = await waitFor(() => document.querySelector('[data-testid="edit-badge"]') !== null, 2_000)
          const editPrefill = await waitFor(() => continuityComposer.value === 'ui continuity smoke', 2_000)
          const lastAssistant = Array.from(document.querySelectorAll('.message.assistant')).pop()
          const regenerateButton = Array.from(
            lastAssistant?.querySelectorAll<HTMLButtonElement>('.copy-btn') ?? [],
          ).some((button) => button.textContent?.includes('重新生成'))
          document.querySelector<HTMLButtonElement>('[data-testid="edit-badge"] .attachment-remove')?.click()
          setTextareaValue?.call(continuityComposer, 'draft-check')
          continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 250))
          const draftSaved = Object.keys(localStorage).some((key) => {
            if (!key.startsWith('xcode.draft.')) return false
            try {
              return (JSON.parse(localStorage.getItem(key) ?? '{}') as { text?: string }).text === 'draft-check'
            } catch {
              return false
            }
          })
          setTextareaValue?.call(continuityComposer, '')
          continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
          continuityOk = userAdded && turnSettled && editBadge && editPrefill && regenerateButton && draftSaved
          continuityDetail = `user=${userAdded} settled=${turnSettled} edit=${editBadge}/${editPrefill} regen=${regenerateButton} draft=${draftSaved}`
        }
        checks.continuity = { ok: continuityOk, detail: continuityDetail }

        const markdownComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
        let markdownComposerOk = false
        let markdownComposerDetail = 'composer missing'
        if (markdownComposer) {
          const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          setTextareaValue?.call(markdownComposer, 'bold text')
          markdownComposer.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 50))
          markdownComposer.focus()
          markdownComposer.setSelectionRange(0, 4)
          document.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click()
          const toolbar = await waitFor(
            () => document.querySelector('[data-testid="markdown-toolbar"]') !== null,
            2_000,
          )
          document.querySelector<HTMLButtonElement>('[data-testid="markdown-bold"]')?.click()
          const wrapped = await waitFor(() => markdownComposer.value === '**bold** text', 2_000)
          document.querySelector<HTMLButtonElement>('[data-testid="markdown-preview-toggle"]')?.click()
          const preview = await waitFor(
            () => document.querySelector('[data-testid="markdown-preview"] strong')?.textContent === 'bold',
            2_000,
          )
          markdownComposerOk = toolbar && wrapped && preview
          markdownComposerDetail = `toolbar=${toolbar} wrapped=${wrapped} preview=${preview}`
          setTextareaValue?.call(markdownComposer, '')
          markdownComposer.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click()
          await waitFor(() => document.querySelector('[data-testid="markdown-toolbar"]') === null, 2_000)
        }
        checks.markdownComposer = { ok: markdownComposerOk, detail: markdownComposerDetail }

        const userCopyButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.message.user .message-actions .copy-btn'),
        )
          .filter((button) => button.textContent?.trim() === '复制')
          .pop()
        userCopyButton?.click()
        const userCopied = await waitFor(() => userCopyButton?.textContent === '已复制', 2_000)
        checks.userCopy = {
          ok: Boolean(userCopyButton) && userCopied,
          detail: `button=${Boolean(userCopyButton)} copied=${userCopied}`,
        }

        const captureButton = document.querySelector<HTMLButtonElement>('[data-testid="capture-button"]')
        captureButton?.click()
        const captureMenu = await waitFor(() => document.querySelector('[data-testid="capture-menu"]') !== null, 2_000)
        const captureMenuText = document.querySelector('[data-testid="capture-menu"]')?.textContent ?? ''
        const captureOptions = captureMenuText.includes('框选区域') && captureMenuText.includes('整个屏幕')
        document.querySelector<HTMLDivElement>('.capture-scrim')?.click()
        const captureMenuClosed = await waitFor(
          () => document.querySelector('[data-testid="capture-menu"]') === null,
          2_000,
        )
        checks.captureMenu = {
          ok: captureMenu && captureOptions && captureMenuClosed,
          detail: `menu=${captureMenu} options=${captureOptions} closed=${captureMenuClosed}`,
        }

        const organizedList = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:list',
          params: {},
        })
        const organizedItems = organizedList.ok ? (organizedList.result as SessionListItem[]) : []
        const targetSession = organizedItems.find((item) => item.sessionId === activeSessionId) ?? organizedItems[0]
        let pinnedOk = false
        let archivedOk = false
        let searchOk = false
        let markdownOk = false
        let pdfOk = false
        let organizeDetail = 'no sessions'
        if (targetSession) {
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:set-pinned',
            params: { filePath: targetSession.filePath, pinned: true },
          })
          const pinnedList = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:list',
            params: {},
          })
          pinnedOk =
            pinnedList.ok &&
            (pinnedList.result as SessionListItem[]).some(
              (item) => item.filePath === targetSession.filePath && item.pinned === true,
            )
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:set-pinned',
            params: { filePath: targetSession.filePath, pinned: false },
          })

          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:set-archived',
            params: { filePath: targetSession.filePath, archived: true },
          })
          const archivedList = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:list',
            params: {},
          })
          archivedOk =
            archivedList.ok &&
            (archivedList.result as SessionListItem[]).some(
              (item) => item.filePath === targetSession.filePath && item.archived === true,
            )
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:set-archived',
            params: { filePath: targetSession.filePath, archived: false },
          })

          const searchResponse = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:search',
            params: { query: 'continuity smoke', limit: 10 },
          })
          const searchResults = searchResponse.ok
            ? (searchResponse.result as { results: SessionSearchResult[] }).results
            : []
          searchOk = searchResults.some((result) => result.snippet.length > 0)

          const mdExport = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:export',
            params: { filePath: targetSession.filePath, format: 'markdown' },
          })
          markdownOk = mdExport.ok && (mdExport.result as { size: number }).size > 0
          const pdfExport = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'session:export',
            params: { filePath: targetSession.filePath, format: 'pdf' },
          })
          pdfOk = pdfExport.ok && (pdfExport.result as { size: number }).size > 1000
          organizeDetail = `pinned=${pinnedOk} archived=${archivedOk} search=${searchOk} md=${markdownOk} pdf=${pdfOk}`
        }
        checks.sessionOrganize = {
          ok: pinnedOk && archivedOk && searchOk && markdownOk && pdfOk,
          detail: organizeDetail,
        }

        const projectBefore = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'project:settings',
          params: {},
        })
        let projectOk = false
        let projectDetail = 'missing'
        if (projectBefore.ok) {
          const before = projectBefore.result as ProjectSettingsView
          const savedProject = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'project:save',
            params: { modelId: before.effective.modelId, taskMode: 'writing', autoChecks: true },
          })
          const afterSave = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'project:settings',
            params: {},
          })
          const savedView = afterSave.ok ? (afterSave.result as ProjectSettingsView) : null
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'project:save',
            params: { modelId: null, taskMode: null, autoChecks: null },
          })
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'agent:set-task-mode',
            params: { mode: before.effective.taskMode as 'coding' | 'writing' | 'research' | 'office' },
          })
          projectOk =
            savedProject.ok && savedView?.overrides.taskMode === 'writing' && savedView?.overrides.autoChecks === true
          projectDetail = `save=${savedProject.ok} overrides=${JSON.stringify(savedView?.overrides ?? {})}`
        } else {
          projectDetail = projectBefore.error.message
        }
        checks.projectSettings = { ok: projectOk, detail: projectDetail }

        const storageUsage = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'storage:usage',
          params: {},
        })
        const storageCleanup = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'storage:cleanup',
          params: { sessionsOlderThanDays: 3650, attachmentsOlderThanDays: 3650 },
        })
        checks.storage = {
          ok:
            storageUsage.ok &&
            Array.isArray((storageUsage.result as StorageUsageView).categories) &&
            (storageUsage.result as StorageUsageView).categories.length >= 5 &&
            storageCleanup.ok,
          detail: storageUsage.ok
            ? `${(storageUsage.result as StorageUsageView).categories.length} categories, ${(storageUsage.result as StorageUsageView).totalBytes} bytes`
            : storageUsage.error.message,
        }

        const tabCount = (): number => document.querySelectorAll('[data-testid="session-tab"]').length
        const activeTabId = (): string | null =>
          document.querySelector('.tab-item.active')?.getAttribute('data-session-id') ?? null
        const tabById = (sessionId: string): Element | null =>
          Array.from(document.querySelectorAll('[data-testid="session-tab"]')).find(
            (tab) => tab.getAttribute('data-session-id') === sessionId,
          ) ?? null
        const previousActiveId = activeTabId()
        const tabsBefore = tabCount()
        document.querySelector<HTMLButtonElement>('.tab-add')?.click()
        const tabOpened = await waitFor(() => tabCount() > tabsBefore, 4000)
        const tabsAfterAdd = tabCount()
        if (previousActiveId) tabById(previousActiveId)?.querySelector<HTMLButtonElement>('.tab-label')?.click()
        const tabSwitched = previousActiveId ? await waitFor(() => activeTabId() === previousActiveId, 5000) : false
        document.querySelector<HTMLButtonElement>('.tab-item.active .tab-close')?.click()
        const tabClosed = previousActiveId ? await waitFor(() => tabById(previousActiveId) === null, 5000) : false
        checks.workspaceTabs = {
          ok: tabsBefore > 0 && tabOpened && tabSwitched && tabClosed,
          detail: `before=${tabsBefore} activeBefore=${previousActiveId ?? 'none'} afterAdd=${tabsAfterAdd} switched=${tabSwitched} closed=${tabClosed}`,
        }

        const windowsBefore = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:window-info',
          params: {},
        })
        const beforeCount = windowsBefore.ok ? (windowsBefore.result as { count: number }).count : 0
        const createWindowResult = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:new-window',
          params: {},
        })
        let windowOpened = false
        if (createWindowResult.ok) {
          const deadline = Date.now() + 4000
          while (Date.now() < deadline) {
            const info = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'app:window-info',
              params: {},
            })
            if (info.ok && (info.result as { count: number }).count > beforeCount) {
              windowOpened = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        checks.multiWindow = {
          ok: beforeCount > 0 && createWindowResult.ok && windowOpened,
          detail: createWindowResult.ok
            ? `before=${beforeCount} opened=${windowOpened}`
            : createWindowResult.error.message,
        }

        const windowCount = async (): Promise<number> => {
          const info = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'app:window-info',
            params: {},
          })
          return info.ok ? (info.result as { count: number }).count : 0
        }
        const waitForWindowCount = async (baseline: number, timeoutMs: number): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            if ((await windowCount()) > baseline) return true
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          return false
        }

        const branchList = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'git:branches',
          params: {},
        })
        const branchView = branchList.ok ? (branchList.result as BranchListView) : null
        let branchPickerOpened = false
        let branchRowFound = false
        let branchWindowOpened = false
        let branchReused = false
        let branchWorkspaceReady = false
        let branchWorkspacePath = ''
        let branchDetail = branchView
          ? `${branchView.branches.length} branch(es)`
          : branchList.ok
            ? 'no data'
            : branchList.error.message
        if (branchView?.isRepo) {
          document.querySelector<HTMLButtonElement>('[data-testid="branch-window-button"]')?.click()
          branchPickerOpened = await waitFor(
            () => document.querySelector('[data-testid="branch-picker"]') !== null,
            4000,
          )
          await waitFor(() => document.querySelectorAll('[data-testid="branch-row"]').length >= 2, 4000)
          const branchRow = Array.from(document.querySelectorAll('[data-testid="branch-row"]')).find(
            (row) => row.getAttribute('data-branch') === 'smoke-branch',
          ) as HTMLButtonElement | undefined
          if (branchRow && !branchRow.disabled) {
            branchRowFound = true
            const beforeBranchWindow = await windowCount()
            branchRow.click()
            branchWindowOpened = await waitForWindowCount(beforeBranchWindow, 8000)
            const reused = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'worktree:open',
              params: { branch: 'smoke-branch' },
            })
            branchReused = reused.ok && (reused.result as { created: boolean }).created === false
            if (reused.ok) {
              const clean = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
              const expected = clean((reused.result as { workspacePath: string }).workspacePath)
              branchWorkspacePath = expected
              const deadline = Date.now() + 8000
              while (Date.now() < deadline) {
                const info = await window.xcode.request({
                  id: crypto.randomUUID(),
                  method: 'app:window-info',
                  params: {},
                })
                const windows = info.ok
                  ? ((info.result as { windows?: Array<{ workspace?: string }> }).windows ?? [])
                  : []
                if (windows.some((entry) => entry.workspace && clean(entry.workspace) === expected)) {
                  branchWorkspaceReady = true
                  break
                }
                await new Promise((resolve) => setTimeout(resolve, 150))
              }
            }
          }
          document.querySelector<HTMLButtonElement>('.branch-card .btn-quiet')?.click()
          branchDetail = `picker=${branchPickerOpened} row=${branchRowFound} window=${branchWindowOpened} reused=${branchReused} workspace=${branchWorkspaceReady}`
        }
        checks.branchWorktree = {
          ok: branchPickerOpened && branchRowFound && branchWindowOpened && branchReused && branchWorkspaceReady,
          detail: branchDetail,
        }

        let worktreeUiOk = false
        let worktreeUiDetail = 'picker missing'
        document.querySelector<HTMLButtonElement>('[data-testid="branch-window-button"]')?.click()
        const uiPickerOpen = await waitFor(() => document.querySelector('[data-testid="branch-picker"]') !== null, 4000)
        if (uiPickerOpen) {
          const removeReady = await waitFor(
            () => document.querySelector('[data-testid="branch-remove"][data-branch="smoke-branch"]') !== null,
            4000,
          )
          const removeButton = document.querySelector<HTMLButtonElement>(
            '[data-testid="branch-remove"][data-branch="smoke-branch"]',
          )
          if (removeReady) removeButton?.click()
          const confirmReady = await waitFor(
            () => document.querySelector('[data-testid="worktree-remove-confirm"]') !== null,
            2000,
          )
          document.querySelector<HTMLButtonElement>('[data-testid="worktree-remove-confirm"] .btn-quiet')?.click()
          const cancelled = await waitFor(
            () => document.querySelector('[data-testid="worktree-remove-confirm"]') === null,
            2000,
          )
          const prunePresent = document.querySelector('[data-testid="worktree-prune-button"]') !== null
          document.querySelector<HTMLButtonElement>('.branch-card .shortcut-head .btn-quiet')?.click()
          worktreeUiOk = removeReady && confirmReady && cancelled && prunePresent
          worktreeUiDetail = `remove=${removeReady} confirm=${confirmReady} cancel=${cancelled} prune=${prunePresent}`
        }
        checks.worktreeUi = { ok: worktreeUiOk, detail: worktreeUiDetail }

        const guardedRemoval = branchWorkspacePath
          ? await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'worktree:remove',
              params: { path: branchWorkspacePath },
            })
          : null
        checks.worktreeGuard = {
          ok: guardedRemoval !== null && !guardedRemoval.ok && guardedRemoval.error.code === 'worktree-in-use',
          detail:
            guardedRemoval === null
              ? 'no worktree path'
              : guardedRemoval.ok
                ? 'removal was allowed while the window is open'
                : guardedRemoval.error.code,
        }

        const openRemoveWorktree = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'worktree:open',
          params: { branch: 'smoke-remove' },
        })
        let worktreeManageOk = false
        let worktreeManageDetail = openRemoveWorktree.ok ? 'open failed' : openRemoveWorktree.error.message
        if (openRemoveWorktree.ok) {
          const removePath = (openRemoveWorktree.result as { workspacePath: string }).workspacePath
          const removed = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'worktree:remove',
            params: { path: removePath },
          })
          const pruned = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'worktree:prune',
            params: {},
          })
          const after = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'git:branches',
            params: {},
          })
          const afterView = after.ok ? (after.result as BranchListView) : null
          const smokeRemoveBranch = afterView?.branches.find((branch) => branch.name === 'smoke-remove')
          worktreeManageOk =
            removed.ok &&
            (removed.result as { removed: boolean }).removed === true &&
            pruned.ok &&
            (Boolean(smokeRemoveBranch) ? smokeRemoveBranch?.worktreePath === undefined : false)
          worktreeManageDetail = `removed=${removed.ok} pruned=${pruned.ok} branch=${Boolean(smokeRemoveBranch)} worktree=${smokeRemoveBranch?.worktreePath ?? 'none'}`
        }
        checks.worktreeManage = { ok: worktreeManageOk, detail: worktreeManageDetail }

        let sessionMoveOk = false
        let sessionMoveDetail = 'no session row'
        let movedFilePath = ''
        const sessionRow = document.querySelector<HTMLElement>('.sidebar-session-row')
        if (sessionRow) {
          sessionRow.querySelector<HTMLButtonElement>('.sidebar-session')?.click()
          let activeSaved = false
          const loadedDeadline = Date.now() + 5000
          while (Date.now() < loadedDeadline) {
            const list = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'session:list',
              params: {},
            })
            const items = list.ok ? (list.result as SessionListItem[]) : []
            const active = items.find((item) => item.sessionId === activeTabId())
            if (active) {
              activeSaved = true
              movedFilePath = active.filePath
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          const moveId = activeTabId()
          const beforeMoveWindow = await windowCount()
          document.querySelectorAll<HTMLButtonElement>('.tab-add')[1]?.click()
          const movedWindow = await waitForWindowCount(beforeMoveWindow, 8000)
          const tabGone = moveId ? await waitFor(() => tabById(moveId) === null, 6000) : false
          sessionMoveOk = activeSaved && Boolean(moveId) && movedWindow && tabGone
          sessionMoveDetail = `saved=${activeSaved} tab=${moveId ?? 'none'} window=${movedWindow} closed=${tabGone}`

          if (sessionMoveOk && movedFilePath && moveId) {
            const clean = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
            const fileName = (value: string): string => clean(value).split('/').filter(Boolean).pop() ?? ''
            const expectedName = fileName(movedFilePath)
            let ownedByOther = false
            const ownerDeadline = Date.now() + 8000
            while (Date.now() < ownerDeadline) {
              const info = await window.xcode.request({
                id: crypto.randomUUID(),
                method: 'app:window-info',
                params: {},
              })
              if (info.ok) {
                const payload = info.result as {
                  senderId: number | null
                  windows: Array<{ id: number; sessionFiles: string[] }>
                }
                if (
                  payload.windows.some(
                    (window) =>
                      window.id !== payload.senderId &&
                      window.sessionFiles.some((filePath) => fileName(filePath) === expectedName),
                  )
                ) {
                  ownedByOther = true
                  break
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 150))
            }
            const movedRow = document.querySelector<HTMLButtonElement>(
              `.sidebar-session-row[data-session-id="${moveId}"] .sidebar-session`,
            )
            movedRow?.click()
            const blocked = await waitFor(
              () => document.body.textContent?.includes('该会话已在另一个窗口打开') ?? false,
              5000,
            )
            checks.sessionOwnership = {
              ok: ownedByOther && Boolean(movedRow) && blocked,
              detail: `owner=${ownedByOther} row=${Boolean(movedRow)} blocked=${blocked}`,
            }
          }
        }
        checks.sessionMove = { ok: sessionMoveOk, detail: sessionMoveDetail }

        const editorProbe = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:open-in-editor',
          params: { filePath: '/nonexistent/x-code-editor-probe.txt' },
        })
        const editorProbeResult = editorProbe.ok ? (editorProbe.result as { opened: boolean }) : null
        checks.openInEditor = {
          ok: editorProbe.ok && editorProbeResult?.opened === false,
          detail: editorProbe.ok ? `opened=${editorProbeResult?.opened}` : editorProbe.error.message,
        }
      } catch (error) {
        checks.exception = { ok: false, detail: error instanceof Error ? error.message : String(error) }
      } finally {
        if (originalModelId) {
          await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'models:set',
            params: { modelId: originalModelId },
          })
        }
        applyTheme(originalTheme)
        if (originalLanguage !== 'zh') await i18n.changeLanguage(originalLanguage)
      }

      const ok = Object.values(checks).every((check) => check.ok)
      window.xcode.reportUiSmoke({ ok, checks })
    }

    void run()
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
    setTerminalOpen(false)
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
    setDocumentOpen(false)
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
    setDocumentOpen(true)
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
      setDocumentOpen(true)
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
    setChecksOpen(true)
    setSettingsOpen(false)
    setTerminalOpen(false)
    setDocumentOpen(false)
    setGitOpen(false)
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
    setChecksOpen(false)
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
    setGitOpen(true)
    setSettingsOpen(false)
    setTerminalOpen(false)
    setDocumentOpen(false)
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
    if (documentView) {
      setDocumentOpen(true)
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
    setDocumentOpen(true)
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
    setTerminalOpen(false)
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
        params: { branch: branch.name },
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
        else if (paletteOpen) setPaletteOpen(false)
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
    paletteOpen,
    branchOpen,
    removeWorktree,
    shortcutSheetOpen,
    findOpen,
    newSession,
    openSettings,
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

  const INIT_PROMPT =
    'Analyze this repository and create or update AGENTS.md at the project root. Follow the existing AGENTS.md conventions if present. Cover the commands, architecture, conventions, and gotchas that a new agent needs. Keep it concise and do not invent facts.'
  const REVIEW_PROMPT =
    'Review the current uncommitted changes (or the work from this session). Report correctness issues, risks, and missing tests. Do not modify files.'

  interface SlashCommand {
    name: string
    description: string
    run: () => void | Promise<void>
  }

  const slashCommands: SlashCommand[] = [
    {
      name: '/model',
      description: t('切换模型'),
      run: () => {
        setSettingsOpen(false)
        setTerminalOpen(false)
        setModelMenuOpen(true)
      },
    },
    { name: '/settings', description: t('打开设置'), run: () => void openSettings() },
    { name: '/doc', description: t('打开文档面板'), run: () => void openDocumentPanel() },
    { name: '/files', description: t('打开文件浏览器与编辑器'), run: () => setFileOpen(true) },
    { name: '/git', description: t('查看 Git 变更'), run: () => void openGitPanel() },
    { name: '/checks', description: t('运行项目检查'), run: () => void openChecksPanel() },
    { name: '/sessions', description: t('显示侧边栏'), run: () => void openSidebar() },
    { name: '/resume', description: t('显示侧边栏并选择会话'), run: () => void openSidebar() },
    {
      name: '/terminal',
      description: t('展开 / 收起终端'),
      run: () => {
        setSettingsOpen(false)
        setModelMenuOpen(false)
        setTerminalOpen((open) => !open)
      },
    },
    { name: '/diagnostics', description: t('运行诊断'), run: () => void runDiagnostics() },
    { name: '/compact', description: t('压缩上下文'), run: () => void runCompact() },
    { name: '/context', description: t('查看上下文构成'), run: () => void requestTextReport('context:stats') },
    { name: '/usage', description: t('查看本会话用量'), run: () => void requestTextReport('usage:summary') },
    {
      name: '/export',
      description: t('导出当前会话（markdown / json / pdf）'),
      run: () => void exportCurrentSession('markdown'),
    },
    {
      name: '/usage-history',
      description: t('查看最近会话用量'),
      run: () => void requestTextReport('usage:history'),
    },
    { name: '/doctor', description: t('环境 / 插件 / MCP 诊断'), run: () => void requestTextReport('doctor:run') },
    { name: '/ps', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    { name: '/background', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    { name: '/list-agents', description: t('列出子代理'), run: () => void requestTextReport('agents:list') },
    { name: '/goal', description: t('查看 goal 状态'), run: () => void requestTextReport('goal:get') },
    { name: '/thinking', description: t('切换思考模式'), run: () => void toggleThinking() },
    { name: '/plan', description: t('切换计划模式'), run: () => void togglePlan() },
    {
      name: '/clear',
      description: t('新建会话并清空对话'),
      run: () => {
        setReport(null)
        void newSession()
      },
    },
    { name: '/stop', description: t('停止当前回复'), run: () => void abort() },
    {
      name: '/init',
      description: t('分析仓库并生成 AGENTS.md'),
      run: () => {
        append({ role: 'system', text: t('执行 /init') })
        void submit(INIT_PROMPT, true)
      },
    },
    {
      name: '/review',
      description: t('审查当前改动'),
      run: () => {
        append({ role: 'system', text: t('执行 /review') })
        void submit(REVIEW_PROMPT, true)
      },
    },
    {
      name: '/fork',
      description: t('从当前会话派生一个新分支'),
      run: () => void forkCurrentSession(),
    },
    {
      name: '/rewind',
      description: t('回退到检查点（代码 / 对话）'),
      run: () => setRewindOpen(true),
    },
    {
      name: '/memory',
      description: t('查看用户记忆'),
      run: () => void requestTextReport('memory:get'),
    },
    { name: '/theme', description: t('主题说明'), run: () => setReport(t('当前仅提供水墨主题。')) },
    {
      name: '/browser',
      description: t('浏览器子代理说明'),
      run: () => setReport(t('浏览器子代理尚未接入桌面端。')),
    },
    {
      name: '/clear-peer-context',
      description: t('peer 上下文说明'),
      run: () => setReport(t('peer 跨会话消息未在桌面端启用。')),
    },
    {
      name: '/exit',
      description: t('退出应用'),
      run: () => void window.xcode.request({ id: crypto.randomUUID(), method: 'app:quit', params: {} }),
    },
  ]

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
    setFileOpen(true)
  }

  const paletteActions: PaletteAction[] = [
    { id: 'new-session', label: t('新建会话'), hint: '⌘N', run: () => newSession() },
    { id: 'new-window', label: t('新建窗口'), hint: '⌘⇧N', run: () => openInNewWindow(false) },
    {
      id: 'branch-window',
      label: t('在新窗口打开分支'),
      hint: t('Git worktree'),
      run: () => void openBranchPicker(),
    },
    {
      id: 'current-to-window',
      label: t('将当前会话移到新窗口'),
      hint: '⧉',
      run: () => openInNewWindow(true),
    },
    { id: 'settings', label: t('打开设置'), hint: '⌘,', run: () => openSettings() },
    { id: 'project-settings', label: t('项目设置'), hint: t('当前工作区'), run: () => openSettings('project') },
    { id: 'memory-settings', label: t('用户记忆'), hint: t('主题与事实'), run: () => openSettings('memory') },
    {
      id: 'storage-settings',
      label: t('存储与清理'),
      hint: t('会话 / 附件 / 模型'),
      run: () => openSettings('storage'),
    },
    { id: 'hooks-settings', label: t('Hooks'), hint: t('用户级 / 项目级'), run: () => openSettings('hooks') },
    { id: 'commands-settings', label: t('自定义命令'), hint: t('斜杠命令'), run: () => openSettings('commands') },
    { id: 'files', label: t('文件浏览器与编辑器'), hint: t('浏览工作区'), run: () => openFilesPanel() },
    {
      id: 'workspace-editor',
      label: t('在编辑器中打开工作区'),
      hint: 'VS Code / Cursor',
      run: () => openInEditor(appState?.workspace ?? ''),
    },
    {
      id: 'workspace-reveal',
      label: t('在文件管理器中显示工作区'),
      hint: 'Finder',
      run: () =>
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:reveal-path',
          params: { path: appState?.workspace ?? '' },
        }),
    },
    { id: 'documents', label: t('文档面板'), hint: t('PDF / Office / 表格'), run: () => openDocumentPanel() },
    { id: 'git', label: t('Git 变更'), hint: t('查看与回退'), run: () => openGitPanel() },
    { id: 'checks', label: t('项目检查'), hint: t('类型检查 / 测试'), run: () => openChecksPanel() },
    {
      id: 'terminal',
      label: terminalOpen ? t('收起终端') : t('打开终端'),
      hint: 'PTY',
      run: () => {
        setSettingsOpen(false)
        setTerminalOpen((open) => !open)
      },
    },
    { id: 'background', label: t('后台任务'), hint: t('查看与停止'), run: () => setBackgroundOpen(true) },
    { id: 'rewind', label: t('回退到检查点'), hint: t('代码 / 对话'), run: () => setRewindOpen(true) },
    { id: 'fork', label: t('从当前会话分叉'), hint: t('新建分支'), run: () => forkCurrentSession() },
    { id: 'scan-local', label: t('扫描本地模型'), hint: 'Ollama / LM Studio', run: () => scanLocalModels() },
    { id: 'compact', label: t('压缩上下文'), hint: t('手动压缩'), run: () => runCompact() },
    { id: 'export-md', label: t('导出会话为 Markdown'), hint: 'Markdown', run: () => exportCurrentSession('markdown') },
    { id: 'export-json', label: t('导出会话为 JSON'), hint: 'JSON', run: () => exportCurrentSession('json') },
    { id: 'export-pdf', label: t('导出会话为 PDF'), hint: 'PDF', run: () => exportCurrentSession('pdf') },
    { id: 'theme', label: t('切换主题'), hint: t('浅色 / 深色 / 跟随系统'), run: () => cycleTheme() },
    { id: 'language', label: t('切换语言'), hint: '中文 / English', run: () => toggleLanguage() },
    { id: 'sidebar', label: t('显示 / 隐藏侧边栏'), hint: '', run: () => setSidebarOpen((open) => !open) },
    {
      id: 'diagnostics',
      label: t('运行诊断'),
      hint: t('环境 / 插件 / MCP'),
      run: () => runDiagnostics(),
    },
    { id: 'shortcuts', label: t('键盘快捷键'), hint: '?', run: () => setShortcutSheetOpen(true) },
  ]

  const slashQuery = input.startsWith('/') ? input.slice(1).toLowerCase() : null
  const paletteCommands =
    slashQuery === null
      ? []
      : commandsWithHelp.filter((command) => command.name.slice(1).startsWith(slashQuery)).slice(0, 8)

  const runSlashCommand = (command: SlashCommand): void => {
    setInput('')
    setPaletteIndex(0)
    void command.run()
  }

  useEffect(() => {
    setPaletteIndex(0)
  }, [input])

  const taskMode = normalizeTaskMode(appState?.taskMode)
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
                setTerminalOpen(false)
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
                      {t(TASK_MODE_LABEL[mode])}
                    </button>
                  ))}
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
                setTerminalOpen((open) => !open)
              }}
            >
              <TerminalIcon />
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
                        setFileOpen(true)
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
              <p className="empty-sub">{t(TASK_MODE_TEMPLATE[taskMode].hint)}</p>
              <div className="mode-suggestions">
                {TASK_MODE_TEMPLATE[taskMode].suggestions.map((suggestion) => (
                  <button key={suggestion} className="mode-suggestion" onClick={() => setInput(suggestion)}>
                    {t(suggestion)}
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
          <pre className="report" aria-label={t('诊断结果')}>
            {report}
          </pre>
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
            <div className="slash-palette">
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

      {terminalOpen ? (
        <>
          <div className="drawer-scrim" onClick={() => setTerminalOpen(false)} aria-hidden="true" />
          <aside className="terminal-drawer" data-testid="terminal-shell" aria-label={t('终端')}>
            <header className="drawer-head">
              <span className="drawer-seal" aria-hidden="true">
                端
              </span>
              <div className="drawer-titles">
                <div className="drawer-title">{t('终端')}</div>
                <div className="drawer-sub">PTY · runtime process</div>
              </div>
              <span className="spacer" />
              <button className="btn btn-quiet" onClick={() => setTerminalOpen(false)}>
                {t('关闭')}
              </button>
            </header>
            <TerminalPanel />
          </aside>
        </>
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

      {checksOpen ? (
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
          onClose={() => setChecksOpen(false)}
        />
      ) : null}
      {gitOpen ? (
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
          onClose={() => setGitOpen(false)}
        />
      ) : null}
      {settingsOpen && settings ? (
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
        />
      ) : null}
      {fileOpen ? (
        <FilePanel
          workspace={appState?.workspace ?? settings?.workspace ?? ''}
          initialPath={fileInitialPath}
          onOpenEditor={(path, line) => openInEditor(path, line)}
          onClose={() => {
            setFileOpen(false)
            setFileInitialPath(null)
          }}
        />
      ) : null}
      {documentOpen ? (
        <DocumentPanel
          view={documentView}
          loading={documentLoading}
          error={documentError}
          onClose={() => setDocumentOpen(false)}
          onReload={() => {
            const current = documentView?.path
            if (current) void openDocument(current)
          }}
          onAttach={(path) => {
            setAttachments((current) => [...new Set([...current, path])])
            setDocumentOpen(false)
          }}
          onAsk={(prompt, path) => {
            void submit(prompt, false, [path])
            setDocumentOpen(false)
          }}
          onSummarize={(path) => {
            void submit(t('请总结这个文件的内容与结构。'), false, [path])
            setDocumentOpen(false)
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
      {backgroundOpen ? <BackgroundPanel onClose={() => setBackgroundOpen(false)} /> : null}
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
                      disabled={sameWindow || branchBusy !== null || removeWorktree !== null}
                      title={worktreePath ?? t('将新建 worktree')}
                      onClick={() => void openBranchInWindow(branch)}
                    >
                      <span className="branch-row-head">
                        <span className="branch-row-name">{branch.name}</span>
                        {branch.current ? <span className="branch-badge current">{t('当前分支')}</span> : null}
                        {sameWindow ? (
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
                    {branch.removable && worktreePath ? (
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
      ) : null}
    </div>
  )
}
