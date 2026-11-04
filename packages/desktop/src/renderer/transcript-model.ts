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
  /(Log files were not written due to an error writing|npm error code (?:EACCES|EPERM)|EACCES: permission denied.*(?:\.npm|\.cache)|Cache (?:directory|folder).*permission denied)/i
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
  movedDeliverables?: string[]
}

export type TurnRenderItem =
  | { kind: 'entry'; entry: Entry }
  | { kind: 'toggle'; key: string; count: number; failures: number; collapsed: boolean }

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
  return `x-code/${slug || 'task'}-${Date.now().toString(36).slice(-5)}`
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

export function sessionTitle(item: SessionListItem): string {
  return item.name || item.title || item.firstPrompt || item.sessionId
}

export function sessionTime(item: SessionListItem): string {
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

export function extractSourceUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []
  const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => url.startsWith('https://'))
  return [...new Set(cleaned)].slice(0, 8)
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
