// @x-code-cli/desktop — 会话渲染的纯模型与格式化助手
//
// 从 App.tsx 拆出的无 React 依赖部分：条目类型、标签、任务模式、
// 时间/路径格式化。抽出后 App.tsx 只保留状态与视图编排。
import type { FileEditView, SessionAttachmentView, SessionListItem, SubAgentView } from '../shared/protocol.js'

export function formatContextTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

const SANDBOX_NETWORK_DENIAL =
  /(Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|Network is unreachable|Failed to connect|Couldn't connect to server|ENOTFOUND|EAI_AGAIN|connect: operation not permitted)/i
// GUI 程序（Electron / Chromium）在沙箱里会先被系统拒绝嵌套沙箱，随后
// 报 GPU / 缓存目录错误；这些输出和普通的写入拒绝要分开解释。
const SANDBOX_GUI_DENIAL =
  /(sandbox initialization failed|Failed to initialize sandbox|GPU process isn't usable|persistent_cache_sandboxed_file_factory)/i
// npm / pip 会把缓存和日志写进用户目录；被沙箱拦截时 npm 会误报
// “sudo chown ~/.npm”。
const SANDBOX_PACKAGE_WRITE =
  // npm 的真实输出是多行带前缀的（`npm error code EACCES` / `npm error syscall
  // mkdir` / `npm error path /Users/x/.npm/_cacache`），`.` 不匹配换行，所以
  // 「code」与「路径」之间的匹配必须跨行。
  /(Log files were not written due to an error writing|npm error code (?:EACCES|EPERM)|EACCES: permission denied[\s\S]{0,200}?(?:\.npm|\.cache)|Cache (?:directory|folder)[\s\S]{0,80}?permission denied)/i
const SANDBOX_WRITE_DENIAL = /(sandbox-exec|Operation not permitted|Read-only file system)/i
const COMMAND_NOT_FOUND =
  /(command not found|not recognized as an internal or external command|(?:sh|bash|zsh): .*: not found)/i

export type ToolEnvironmentHint = 'network' | 'write' | 'gui' | 'package' | 'command'

export function toolEnvironmentHint(text: string, sandboxEnabled: boolean): ToolEnvironmentHint | null {
  if (sandboxEnabled && SANDBOX_GUI_DENIAL.test(text)) return 'gui'
  if (sandboxEnabled && SANDBOX_PACKAGE_WRITE.test(text)) return 'package'
  if (sandboxEnabled && SANDBOX_NETWORK_DENIAL.test(text)) return 'network'
  if (sandboxEnabled && SANDBOX_WRITE_DENIAL.test(text)) return 'write'
  if (COMMAND_NOT_FOUND.test(text)) return 'command'
  return null
}

const OUTPUT_LOCATION_PATTERN = /\[Output location\]\s+(.+?)\s+is in the system temporary directory/g

export function tempDeliverables(text: string | undefined): string[] {
  if (!text) return []
  const paths = new Set<string>()
  for (const match of text.matchAll(OUTPUT_LOCATION_PATTERN)) {
    const candidate = match[1]?.trim()
    if (candidate) paths.add(candidate)
  }
  return [...paths]
}

export function attachmentName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export type Role = 'user' | 'assistant' | 'tool' | 'system' | 'error'

export interface Entry {
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
  toolStartedAt?: number
  diff?: FileEditView
  reverted?: boolean
  subagent?: SubAgentView
  attachments?: string[]
  attachmentViews?: SessionAttachmentView[]
  /** 本地时间戳，仅实时消息有；用于轮次分隔条显示时间。 */
  at?: number
  movedDeliverables?: string[]
}

export type TurnRenderItem =
  | { kind: 'entry'; entry: Entry }
  | { kind: 'toggle'; key: string; count: number; failures: number; collapsed: boolean }
  | { kind: 'divider'; key: string; turn: number; at?: number }

export interface TurnBuildOptions {
  sessionKey: string
  toolDisplayMode: ToolDisplayMode
  toolOverrides: Map<string, boolean>
  /** 只渲染最近 N 轮；省略时渲染全部。 */
  maxTurns?: number
}

export interface TurnBuild {
  items: TurnRenderItem[]
  hiddenTurns: number
  totalTurns: number
  shownEntries: Entry[]
}

/** 把条目切成用户轮次，并为每轮生成工具折叠块与分隔条。
 *  拆分窗口只作用于渲染，不影响会话数据本身。 */
export function buildTurnItems(entries: Entry[], options: TurnBuildOptions): TurnBuild {
  const groups: Entry[][] = []
  let current: Entry[] | undefined
  let currentTurnId: string | undefined
  for (const entry of entries) {
    const startsTurn =
      !current ||
      entry.role === 'user' ||
      (entry.turnId !== undefined && currentTurnId !== undefined && entry.turnId !== currentTurnId)
    if (startsTurn) {
      const group: Entry[] = []
      groups.push(group)
      current = group
      currentTurnId = undefined
    }
    if (!current) continue
    current.push(entry)
    if (entry.turnId) currentTurnId = entry.turnId
  }

  const limit = options.maxTurns === undefined ? groups.length : Math.max(1, options.maxTurns)
  const hiddenTurns = Math.max(0, groups.length - limit)
  const shown = groups.slice(hiddenTurns)
  const items: TurnRenderItem[] = []
  const shownEntries: Entry[] = []
  const showDivider = groups.length > 1

  shown.forEach((group, index) => {
    const absoluteTurn = hiddenTurns + index + 1
    const entryKey = group.find((entry) => entry.role === 'user')?.id ?? group[0]?.id ?? 'turn'
    const key = `${options.sessionKey}:${entryKey}`
    if (showDivider) {
      const at = group.find((entry) => entry.role === 'user')?.at
      items.push({ kind: 'divider', key: `divider-${key}`, turn: absoluteTurn, ...(at ? { at } : {}) })
    }
    const tools = group.filter((entry) => entry.role === 'tool')
    const collapsed = !(options.toolOverrides.get(key) ?? options.toolDisplayMode !== 'minimal')
    const failures = tools.filter((entry) => entry.toolStatus === 'error' || entry.toolStatus === 'denied').length
    let toggleAdded = false
    for (const entry of group) {
      shownEntries.push(entry)
      if (entry.role === 'tool') {
        if (!toggleAdded) {
          items.push({ kind: 'toggle', key, count: tools.length, failures, collapsed })
          toggleAdded = true
        }
        if (collapsed) continue
      }
      items.push({ kind: 'entry', entry })
    }
  })

  return { items, hiddenTurns, totalTurns: groups.length, shownEntries }
}

export const TOOL_DISPLAY_MODES = ['minimal', 'balanced', 'full'] as const
export type ToolDisplayMode = (typeof TOOL_DISPLAY_MODES)[number]

export const TOOL_DISPLAY_LABEL: Record<ToolDisplayMode, string> = {
  minimal: '极简',
  balanced: '适中',
  full: '全面',
}

export const TOOL_DISPLAY_HINT: Record<ToolDisplayMode, string> = {
  minimal: '默认收起工具调用',
  balanced: '展开工具调用，单个工具收起',
  full: '全部展开',
}

export function normalizeToolDisplayMode(value: string | null | undefined): ToolDisplayMode {
  return value === 'minimal' || value === 'full' ? value : 'balanced'
}

export const ROLE_LABEL: Record<Role, string> = {
  user: '你',
  assistant: 'X-CODE',
  tool: '工具',
  system: '系统',
  error: '错误',
}

export const TASK_MODES = ['coding', 'writing', 'research', 'office'] as const
export type TaskMode = (typeof TASK_MODES)[number]

export const TASK_MODE_LABEL: Record<TaskMode, string> = {
  coding: '编程',
  writing: '写作',
  research: '科研',
  office: '办公',
}

export const TASK_MODE_DESCRIPTION: Record<TaskMode, string> = {
  coding: '代码、测试与 diff 优先',
  writing: '结构、语气与文稿优先',
  research: '资料、引用与不确定性优先',
  office: '文档、表格与导出优先',
}

export const TASK_MODE_TEMPLATE: Record<TaskMode, { hint: string; suggestions: string[] }> = {
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

export function normalizeTaskMode(value: string | undefined): TaskMode {
  return (TASK_MODES as readonly string[]).includes(value ?? '') ? (value as TaskMode) : 'coding'
}

/** A task-scoped branch name. ASCII slug when possible, plus a short time
 * suffix so two tasks with the same description never collide. */
export function taskBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  // 只用 Date.now() 的 5 位 base36 后缀时周期约 16.8 小时：同一天隔一个周期的
  // 相同描述任务（或同毫秒并发创建）会得到完全相同的分局名而冲突。时间戳保留
  // 2 位作为可读线索，再混入一段随机，把碰撞空间拉到千万级。
  const suffix = `${Date.now().toString(36).slice(-2)}${Math.random().toString(36).slice(2, 5)}`
  return `x-code/${slug || 'task'}-${suffix}`
}

export const STATUS_LABEL = {
  starting: '初启',
  ready: '运转中',
  offline: '离线',
} as const

export const TOOL_STATUS_LABEL: Record<NonNullable<Entry['toolStatus']>, string> = {
  pending: '等待',
  running: '执行中',
  completed: '完成',
  denied: '已拒绝',
  error: '失败',
}

export function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  // `??` 短路链会在第一个「存在但为空」的字段上停住——流式渲染时 `filePath`
  // 常先以空串出现，标题就会渲染成空、后面的 command/pattern 全被吞掉。
  // `as string` 断言也不校验运行时类型：`limit: 50` / `paths: [...]` 这类字段
  // 会让 `.length`、`.slice` 与 `string` 返回类型对不上。
  const candidates = [input.filePath, input.command, input.pattern, input.query, input.path, input.url]
  const value = candidates.find((item): item is string => typeof item === 'string' && item.trim() !== '')?.trim() ?? ''
  return value.length > 90 ? `${value.slice(0, 87)}…` : value
}

export function sessionTitle(item: SessionListItem): string {
  return item.name || item.title || item.firstPrompt || item.sessionId
}

export function sessionTime(item: SessionListItem): string {
  // `new Date(...)` 对非法输入不抛异常，只在后续 toLocaleString 时给出
  // "Invalid Date"——所以 try/catch 过去是死代码。显式判空才拦得住
  // mtime 为 0 / undefined / NaN 的旧会话索引。
  const date = new Date(item.mtime)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type SessionDayGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier'

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 侧栏按最近活动给会话分组；置顶会话单独成组，不按日期拆散。 */
export function sessionDayGroup(mtime: number, now = Date.now(), pinned = false): SessionDayGroup {
  if (pinned) return 'pinned'
  const day = startOfDay(now)
  const target = startOfDay(mtime)
  const diff = Math.round((day - target) / 86_400_000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff < 7) return 'week'
  return 'earlier'
}

export function extractSourceUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []
  const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => url.startsWith('https://'))
  return [...new Set(cleaned)].slice(0, 8)
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
