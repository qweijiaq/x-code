import type { GoalAttemptView, GoalStatusView, GoalVerificationView, GoalView } from '../shared/protocol.js'

export const STATUS_LABEL: Record<GoalStatusView, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
  cancelled: '已取消',
  budget_limited: '预算用尽',
  usage_limited: '用量受限',
  max_turns: '轮数用尽',
  failed: '失败',
}

export const INPUT_LABEL: Record<string, string> = {
  initial: '初始目标',
  continuation: '自动续跑',
  user_steering: '你的指导',
  verifier_failure: '验证重试',
  final_summary: '收尾总结',
}

export const FINISH_LABEL: Record<string, string> = {
  stop: '结束本轮',
  aborted: '已中止',
  error: '出错',
  max_turns: '轮数用尽',
  budget_limited: '预算用尽',
  verification_failed: '验证未过',
  complete: '完成',
  blocked: '受阻',
}

export type EntryCategory = 'ok' | 'verify' | 'error'

export type TimelineEntry =
  | { kind: 'attempt'; at: string; attempt: GoalAttemptView }
  | { kind: 'verify'; at: string; result: GoalVerificationView }

export function isTerminal(status: GoalStatusView): boolean {
  return ['complete', 'cancelled', 'budget_limited', 'usage_limited', 'max_turns', 'failed'].includes(status)
}

export function attemptCategory(attempt: GoalAttemptView): EntryCategory {
  if (attempt.finish === 'error' || attempt.finish === 'aborted' || attempt.finish === 'blocked') return 'error'
  if (attempt.finish === 'verification_failed') return 'verify'
  return 'ok'
}

export function entryCategory(entry: TimelineEntry): EntryCategory {
  if (entry.kind === 'verify') return entry.result.ok ? 'ok' : 'verify'
  return attemptCategory(entry.attempt)
}

export function flattenTimeline(goal: GoalView, order: 'asc' | 'desc' = 'desc'): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...goal.attempts.map((attempt) => ({ kind: 'attempt' as const, at: attempt.startedAt, attempt })),
    ...goal.verificationResults.map((result) => ({ kind: 'verify' as const, at: result.at, result })),
  ]
  const direction = order === 'asc' ? 1 : -1
  return entries.sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) * direction)
}

export interface TimelineGroup {
  key: string
  label: string
  items: TimelineEntry[]
}

export function groupByDay(entries: TimelineEntry[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  for (const entry of entries) {
    const key = dayKey(entry.at)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(entry)
    else groups.push({ key, label: dayLabel(key), items: [entry] })
  }
  return groups
}

export function countCategories(entries: TimelineEntry[]): Record<EntryCategory, number> {
  const counts: Record<EntryCategory, number> = { ok: 0, verify: 0, error: 0 }
  for (const entry of entries) counts[entryCategory(entry)] += 1
  return counts
}

export function formatTime(ts: string | undefined): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

export function formatClock(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatStamp(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString('en-US')
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

export function dayKey(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayLabel(key: string): string {
  const today = new Date()
  const todayKey = dayKey(today.toISOString())
  if (key === todayKey) return '今天'
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  if (key === dayKey(yesterday.toISOString())) return '昨天'
  return key.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日')
}

function dayTitle(key: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return key
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
}

export function goalElapsedMs(goal: GoalView): number {
  const created = Date.parse(goal.createdAt)
  const end = Date.parse(isTerminal(goal.status) ? goal.updatedAt : new Date().toISOString())
  if (!Number.isFinite(created) || !Number.isFinite(end)) return 0
  return Math.max(0, end - created)
}

export function goalReportFilename(goal: GoalView): string {
  const end = isTerminal(goal.status) ? goal.updatedAt : new Date().toISOString()
  return `目标复盘-${dayKey(end)}.md`
}

export function verificationKey(result: GoalVerificationView): string {
  return `${result.at}|${result.kind}|${result.summary}`
}

export interface DayStat {
  key: string
  label: string
  attempts: number
  failed: number
  verifyPassed: number
  verifyTotal: number
  durationMs: number
  tokens: number
}

export function dayStats(entries: TimelineEntry[]): DayStat[] {
  const byDay = new Map<string, DayStat>()
  for (const entry of entries) {
    const key = dayKey(entry.at)
    let stat = byDay.get(key)
    if (!stat) {
      stat = {
        key,
        label: dayLabel(key),
        attempts: 0,
        failed: 0,
        verifyPassed: 0,
        verifyTotal: 0,
        durationMs: 0,
        tokens: 0,
      }
      byDay.set(key, stat)
    }
    if (entry.kind === 'attempt') {
      stat.attempts += 1
      if (attemptCategory(entry.attempt) !== 'ok') stat.failed += 1
      stat.durationMs += entry.attempt.durationMs
      stat.tokens += entry.attempt.tokens
    } else {
      stat.verifyTotal += 1
      if (entry.result.ok) stat.verifyPassed += 1
    }
  }
  return [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key))
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

const MAX_OUTPUT_CHARS = 6000

function trimOutput(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { body: text, truncated: false }
  return { body: text.slice(-MAX_OUTPUT_CHARS), truncated: true }
}

export interface GoalReportOptions {
  /** 面板当前筛选后的条目；缺省时导出全部。 */
  entries?: TimelineEntry[]
  /** 导出范围说明，例如「出错 · 11月14日 · 关键词「login」」。 */
  scope?: string
  /** attemptId → 完整输入；缺失的轮次退回摘要并标注。 */
  prompts?: Record<string, string>
  /** verificationKey(result) → 原始输出；仅用于未通过的验证。 */
  verificationOutputs?: Record<string, string | null>
}

export function buildGoalMarkdown(goal: GoalView, options: GoalReportOptions = {}): string {
  const entries = (options.entries ?? flattenTimeline(goal, 'asc'))
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const attemptCount = entries.filter((entry) => entry.kind === 'attempt').length
  const verifyCount = entries.length - attemptCount
  const lines: string[] = [`# 目标复盘：${goal.objective}`, '']
  lines.push(`- 状态：${STATUS_LABEL[goal.status] ?? goal.status}`)
  lines.push(`- 开始：${formatStamp(goal.createdAt)}`)
  if (isTerminal(goal.status)) lines.push(`- 结束：${formatStamp(goal.updatedAt)}`)
  lines.push(`- 耗时：${formatDuration(goalElapsedMs(goal))}`)
  lines.push(`- 轮次：${goal.turnCount}${goal.maxTurns ? ` / ${goal.maxTurns}` : ''}（失败 ${goal.failedAttempts}）`)
  lines.push(`- 导出范围：${options.scope ?? '全部记录'}（${attemptCount} 轮 · ${verifyCount} 次验证）`)
  lines.push(
    `- Token：${formatNumber(goal.tokensUsed)}${goal.tokenBudget ? ` / ${formatNumber(goal.tokenBudget)}` : ''}`,
  )
  if (goal.verifiers.length > 0) {
    lines.push(`- 验证条件：${goal.verifiers.map((verifier) => `${verifier.label}（${verifier.detail}）`).join('；')}`)
  } else {
    lines.push('- 验证条件：自动语义验证')
  }
  if (goal.finalSummary) {
    lines.push('', '## 最终总结', '', goal.finalSummary)
  }
  if (goal.lastBlocker) {
    lines.push('', '## 最近阻塞', '', goal.lastBlocker)
  }

  for (const group of groupByDay(entries)) {
    const attempts = group.items.filter((item) => item.kind === 'attempt').length
    const verifications = group.items.length - attempts
    lines.push('', `## ${dayTitle(group.key)} · ${attempts} 轮 · ${verifications} 次验证`, '')
    for (const entry of group.items) {
      if (entry.kind === 'attempt') {
        const attempt = entry.attempt
        const input = INPUT_LABEL[attempt.inputKind] ?? attempt.inputKind
        const finish = FINISH_LABEL[attempt.finish] ?? attempt.finish
        lines.push(
          `- ${formatClock(attempt.startedAt)} · 第 ${attempt.turn} 轮 · ${input} · ${finish} · ${formatDuration(attempt.durationMs)} · +${formatNumber(attempt.tokens)} token`,
        )
        const fullPrompt = options.prompts?.[attempt.id]
        if (fullPrompt) {
          lines.push('  > **完整输入**', '  >')
          for (const line of fullPrompt.split('\n')) lines.push(line ? `  > ${line}` : '  >')
        } else if (attempt.promptPreview) {
          lines.push(`  > ${attempt.promptPreview}`)
          if (options.prompts) lines.push('  >（完整输入不可用，以上为摘要）')
        }
      } else {
        const result = entry.result
        lines.push(
          `- ${formatClock(entry.at)} · 验证（${result.kind}）· ${result.ok ? '通过' : '未通过'} · ${formatDuration(result.durationMs ?? 0)}`,
        )
        if (result.summary) lines.push(`  > ${result.summary}`)
        if (result.requiredFixes?.length) lines.push(`  - 待修：${result.requiredFixes.join('；')}`)
        if (!result.ok && options.verificationOutputs) {
          const raw = options.verificationOutputs[verificationKey(result)]
          if (raw === null) {
            lines.push('  - 原始输出：不可用（可能已被会话清理）')
          } else if (!raw) {
            lines.push('  - 原始输出：无')
          } else {
            const { body, truncated } = trimOutput(raw)
            if (truncated) lines.push(`  - 原始输出（已截断，仅保留末尾 ${MAX_OUTPUT_CHARS} 字符）：`)
            else lines.push('  - 原始输出：')
            const fence = fenceFor(body)
            lines.push(`  ${fence}text`)
            for (const line of body.split('\n')) lines.push(line ? `  ${line}` : '')
            lines.push(`  ${fence}`)
          }
        }
      }
    }
  }

  if (entries.length === 0) lines.push('', '还没有执行记录。')
  return `${lines.join('\n')}\n`
}
