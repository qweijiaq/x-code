import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  GoalCreateInput,
  GoalVerificationView,
  GoalView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'
import { PanelSkeleton } from './Skeleton.js'
import {
  type EntryCategory,
  FINISH_LABEL,
  INPUT_LABEL,
  STATUS_LABEL,
  type TimelineEntry,
  attemptCategory,
  buildGoalMarkdown,
  countCategories,
  dayKey,
  dayLabel,
  dayStats,
  entryCategory,
  flattenTimeline,
  formatClock,
  formatDuration,
  formatNumber,
  formatTime,
  goalElapsedMs,
  goalReportFilename,
  groupByDay,
  isTerminal,
  verificationKey,
} from './goal-report.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

type ResultFilter = 'all' | EntryCategory

// 搜索结果里把命中片段标出来，避免用户逐行比对。
function highlightMatches(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let index = lowerText.indexOf(lowerNeedle)
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(<mark key={`${index}-${parts.length}`}>{text.slice(index, index + needle.length)}</mark>)
    cursor = index + needle.length
    index = lowerText.indexOf(lowerNeedle, cursor)
  }
  parts.push(text.slice(cursor))
  return parts
}

interface Props {
  goal: GoalView | null
  onGoal: (goal: GoalView | null) => void
  onClose: () => void
}

type VerifierKind = 'auto' | 'shell' | 'file' | 'subagent'

export function GoalPanel({ goal, onGoal, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [objective, setObjective] = useState('')
  const [verifierKind, setVerifierKind] = useState<VerifierKind>('auto')
  const [verifierValue, setVerifierValue] = useState('')
  const [verifierContains, setVerifierContains] = useState('')
  const [verifierPrompt, setVerifierPrompt] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const [tokenBudget, setTokenBudget] = useState('')
  const [confirmCompletion, setConfirmCompletion] = useState(false)
  const [steerDraft, setSteerDraft] = useState('')
  const [, setTick] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [prompts, setPrompts] = useState<Record<string, { status: 'loading' | 'ready' | 'missing'; text?: string }>>({})
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [dayFilter, setDayFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [promptHits, setPromptHits] = useState<string[]>([])
  const [verificationHits, setVerificationHits] = useState<string[]>([])
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [expandedVerify, setExpandedVerify] = useState<string | null>(null)
  const [verifyOutputs, setVerifyOutputs] = useState<Record<string, string | null | 'loading'>>({})
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [objectiveCopied, setObjectiveCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await request('goal:state', {})
      if (cancelled) return
      if (response.ok) onGoal(response.result as GoalView | null)
      else setError(response.error.message)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [onGoal])

  useEffect(() => {
    if (goal && !isTerminal(goal.status)) setShowForm(false)
    if (!goal) setShowForm(true)
  }, [goal])

  // 切换目标后，筛选与展开状态属于上一个目标，必须清掉以免看起来像「记录丢了」。
  useEffect(() => {
    setExpandedId(null)
    setPrompts({})
    setResultFilter('all')
    setDayFilter('all')
    setQuery('')
    setPromptHits([])
    setVerificationHits([])
    setConfirmClear(false)
    setConfirmClose(false)
    setExpandedVerify(null)
    setVerifyOutputs({})
    setExportNotice(null)
    setExportPath(null)
  }, [goal?.id])

  // 完整提示词不在面板数据里，搜索要回到会话中查原文；稍作停顿避免逐字往返。
  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setPromptHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const response = await request('goal:search-prompts', { query: needle })
        if (cancelled) return
        if (!response.ok) {
          setPromptHits([])
          setVerificationHits([])
          return
        }
        const hits = response.result as { attemptIds: string[]; verificationKeys: string[] }
        setPromptHits(hits.attemptIds)
        setVerificationHits(hits.verificationKeys)
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, goal?.id])

  // 运行中的目标没有事件时，靠定时刷新让「已运行」与时长保持可信。
  useEffect(() => {
    if (!goal || isTerminal(goal.status)) return
    const id = window.setInterval(() => setTick((value) => value + 1), 30000)
    return () => window.clearInterval(id)
  }, [goal])

  const run = async <T extends RequestMethod>(
    method: T,
    params: RequestMap[T]['params'],
  ): Promise<GoalView | null | undefined> => {
    setBusy(true)
    setError(null)
    try {
      const response = await request(method, params)
      if (!response.ok) {
        setError(response.error.message)
        return undefined
      }
      const next = response.result as GoalView | null
      onGoal(next)
      return next
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    const trimmed = objective.trim()
    if (!trimmed) {
      setError(t('请填写目标描述。'))
      return
    }
    if (verifierKind !== 'auto' && !verifierValue.trim()) {
      setError(t('请填写验证条件。'))
      return
    }
    const input: GoalCreateInput = {
      objective: trimmed,
      verifierKind,
      ...(verifierKind !== 'auto' ? { verifierValue: verifierValue.trim() } : {}),
      ...(verifierKind === 'file' && verifierContains.trim() ? { verifierContains: verifierContains.trim() } : {}),
      ...(verifierKind === 'subagent' && verifierPrompt.trim() ? { verifierPrompt: verifierPrompt.trim() } : {}),
      ...(Number(maxTurns) > 0 ? { maxTurns: Math.floor(Number(maxTurns)) } : {}),
      ...(Number(tokenBudget) > 0 ? { tokenBudget: Math.floor(Number(tokenBudget)) } : {}),
      requiresUserConfirmation: confirmCompletion,
    }
    const next = await run('goal:create', input)
    if (next) {
      setObjective('')
      setVerifierValue('')
      setVerifierContains('')
      setVerifierPrompt('')
      setMaxTurns('')
      setTokenBudget('')
      setConfirmCompletion(false)
      setShowForm(false)
    }
  }

  const steer = async (): Promise<void> => {
    const instruction = steerDraft.trim()
    if (!instruction) return
    const next = await run('goal:steer', { instruction })
    if (next) setSteerDraft('')
  }

  const statusClass = goal ? `goal-status goal-status-${goal.status}` : ''
  const allEntries = goal ? flattenTimeline(goal) : []
  const normalizedQuery = query.trim().toLowerCase()
  const matchesQuery = (entry: TimelineEntry): boolean => {
    if (!normalizedQuery) return true
    if (entry.kind === 'attempt') {
      const attempt = entry.attempt
      const haystack = `${attempt.promptPreview} 第 ${attempt.turn} 轮 ${INPUT_LABEL[attempt.inputKind] ?? ''} ${
        FINISH_LABEL[attempt.finish] ?? ''
      }`
      return haystack.toLowerCase().includes(normalizedQuery) || promptHits.includes(attempt.id)
    }
    const haystack = `${entry.result.summary} ${(entry.result.requiredFixes ?? []).join(' ')} ${entry.result.kind}`
    return haystack.toLowerCase().includes(normalizedQuery) || verificationHits.includes(verificationKey(entry.result))
  }
  const queryEntries = allEntries.filter(matchesQuery)
  const counts = countCategories(queryEntries)
  const days = groupByDay(
    queryEntries.filter((entry) => resultFilter === 'all' || entryCategory(entry) === resultFilter),
  ).map((group) => ({ key: group.key, label: dayLabel(group.key), count: group.items.length }))
  const filteredEntries = queryEntries.filter(
    (entry) =>
      (resultFilter === 'all' || entryCategory(entry) === resultFilter) &&
      (dayFilter === 'all' || dayKey(entry.at) === dayFilter),
  )
  const timeline = groupByDay(filteredEntries)
  const elapsedMs = goal ? goalElapsedMs(goal) : 0
  const resultOptions: { value: ResultFilter; label: string; count: number }[] = [
    { value: 'all', label: '全部', count: allEntries.length },
    { value: 'error', label: '出错', count: counts.error },
    { value: 'verify', label: '验证未过', count: counts.verify },
    { value: 'ok', label: '正常', count: counts.ok },
  ]
  const stats = dayStats(allEntries)
  const filtersActive = resultFilter !== 'all' || dayFilter !== 'all' || normalizedQuery !== ''
  const scopeParts: string[] = []
  if (resultFilter !== 'all') {
    const option = resultOptions.find((item) => item.value === resultFilter)
    if (option) scopeParts.push(option.label)
  }
  if (dayFilter !== 'all') scopeParts.push(dayLabel(dayFilter))
  if (normalizedQuery) scopeParts.push(`关键词「${query.trim()}」`)
  const exportScope = scopeParts.length > 0 ? scopeParts.join(' · ') : '全部记录'

  const loadPrompt = async (attemptId: string): Promise<void> => {
    setPrompts((prev) => ({ ...prev, [attemptId]: { status: 'loading' } }))
    const response = await request('goal:attempt-prompt', { attemptId })
    if (!response.ok) {
      setPrompts((prev) => ({ ...prev, [attemptId]: { status: 'missing' } }))
      return
    }
    const result = response.result as { prompt: string | null }
    setPrompts((prev) => ({
      ...prev,
      [attemptId]: result.prompt ? { status: 'ready', text: result.prompt } : { status: 'missing' },
    }))
  }

  const toggleAttempt = (attemptId: string): void => {
    if (expandedId === attemptId) {
      setExpandedId(null)
      return
    }
    setExpandedId(attemptId)
    if (!prompts[attemptId]) void loadPrompt(attemptId)
  }

  const exportReport = async (): Promise<void> => {
    if (!goal) return
    setExporting(true)
    setExportNotice(null)
    try {
      const attemptIds = filteredEntries
        .filter((entry): entry is Extract<TimelineEntry, { kind: 'attempt' }> => entry.kind === 'attempt')
        .map((entry) => entry.attempt.id)
      let prompts: Record<string, string> | undefined
      if (attemptIds.length > 0) {
        const promptResponse = await request('goal:attempt-prompts', { attemptIds })
        if (promptResponse.ok) prompts = promptResponse.result as Record<string, string>
      }
      const failedVerifications = filteredEntries.filter(
        (entry): entry is Extract<TimelineEntry, { kind: 'verify' }> => entry.kind === 'verify' && !entry.result.ok,
      )
      const verificationOutputs: Record<string, string | null> = {}
      await Promise.all(
        failedVerifications.map(async (entry) => {
          const detail = await request('goal:verification-output', {
            at: entry.result.at,
            kind: entry.result.kind,
            summary: entry.result.summary,
          })
          if (detail.ok) {
            verificationOutputs[verificationKey(entry.result)] = (detail.result as { output: string | null }).output
          }
        }),
      )
      const response = await request('app:save-text', {
        content: buildGoalMarkdown(goal, {
          entries: filteredEntries,
          scope: exportScope,
          ...(prompts ? { prompts } : {}),
          ...(failedVerifications.length > 0 ? { verificationOutputs } : {}),
        }),
        suggestedName: goalReportFilename(goal),
      })
      if (!response.ok) {
        setExportNotice({ kind: 'error', text: response.error.message })
        return
      }
      const path = (response.result as { path: string | null }).path
      if (path) {
        setExportPath(path)
        setExportNotice({ kind: 'ok', text: t('已导出到 {{path}}', { path }) })
      }
    } finally {
      setExporting(false)
    }
  }

  const draftDirty =
    Boolean(objective.trim() || verifierValue.trim() || verifierContains.trim() || verifierPrompt.trim()) ||
    Boolean(maxTurns.trim() || tokenBudget.trim()) ||
    confirmCompletion ||
    Boolean(steerDraft.trim())

  const requestClose = (): void => {
    if (draftDirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  // 面板关闭会丢掉未提交的草稿，Esc 要先在捕获阶段拦一下，避免直接穿透到应用级关闭。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirmClose) {
        setConfirmClose(false)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (draftDirty) {
        setConfirmClose(true)
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [confirmClose, draftDirty])

  // 面板是模态层，打开后焦点留在内部，Tab 不跑到背景界面。
  useEffect(() => {
    const node = panelRef.current
    if (!node) return
    node.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusable = [
        ...node.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ].filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => node.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggleVerify = (result: GoalVerificationView): void => {
    const key = verificationKey(result)
    if (expandedVerify === key) {
      setExpandedVerify(null)
      return
    }
    setExpandedVerify(key)
    if (verifyOutputs[key] !== undefined) return
    setVerifyOutputs((prev) => ({ ...prev, [key]: 'loading' }))
    void (async () => {
      const response = await request('goal:verification-output', {
        at: result.at,
        kind: result.kind,
        summary: result.summary,
      })
      setVerifyOutputs((prev) => ({
        ...prev,
        [key]: response.ok ? ((response.result as { output: string | null }).output ?? '') : null,
      }))
    })()
  }

  const clearFilters = (): void => {
    setResultFilter('all')
    setDayFilter('all')
    setQuery('')
  }

  return (
    <div className="modal-scrim" onClick={requestClose}>
      <div
        className="goal-card"
        data-testid="goal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('目标循环')}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const typing =
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            (event.target instanceof HTMLElement && event.target.isContentEditable)
          if (event.key === '/' && !typing) {
            event.preventDefault()
            searchRef.current?.focus()
            return
          }
          if (event.key === 'Escape' && event.target === searchRef.current && query) {
            event.preventDefault()
            event.stopPropagation()
            setQuery('')
          }
        }}
      >
        <header className="goal-head">
          <div>
            <div className="goal-title">{t('目标循环')}</div>
            <div className="goal-sub">{t('让 Agent 持续执行，直到验证通过或预算耗尽')}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={requestClose} aria-label={t('关闭面板')}>
            {t('关闭面板')}
          </button>
        </header>

        {confirmClose ? (
          <div className="goal-confirm" role="alert">
            <span>{t('还有未提交的内容，确定关闭面板？')}</span>
            <button className="btn danger" onClick={onClose}>
              {t('仍然关闭')}
            </button>
            <button className="btn" onClick={() => setConfirmClose(false)}>
              {t('继续编辑')}
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="goal-empty" aria-busy="true">
            <PanelSkeleton rows={4} />
          </div>
        ) : null}
        {error ? <div className="goal-error">{error}</div> : null}

        {goal ? (
          <>
            <section className="goal-summary">
              <div className="goal-summary-top">
                <span className={statusClass}>{t(STATUS_LABEL[goal.status])}</span>
                <span className="goal-time">{t('更新于 {{time}}', { time: formatTime(goal.updatedAt) })}</span>
                <span className="spacer" />
                <button
                  className="copy-btn"
                  onClick={() => {
                    window.xcode.copyText(goal.objective)
                    setObjectiveCopied(true)
                    setTimeout(() => setObjectiveCopied(false), 1_200)
                  }}
                >
                  {objectiveCopied ? t('已复制') : t('复制目标')}
                </button>
              </div>
              <div className="goal-objective">{goal.objective}</div>
              {goal.currentActivity ? (
                <div className="goal-activity" data-testid="goal-activity">
                  {goal.currentActivity}
                </div>
              ) : null}
              <div className="goal-metrics">
                <span>
                  {t('开始')} {formatTime(goal.createdAt)}
                </span>
                <span>
                  {t('已运行')} {formatDuration(elapsedMs)}
                </span>
                <span>
                  {t('轮次')} {goal.turnCount}
                  {goal.maxTurns ? ` / ${goal.maxTurns}` : ''}
                </span>
                <span>
                  {t('Token')} {formatNumber(goal.tokensUsed)}
                  {goal.tokenBudget ? ` / ${formatNumber(goal.tokenBudget)}` : ''}
                </span>
                {goal.remainingTokens !== undefined ? (
                  <span>
                    {t('剩余')} {formatNumber(goal.remainingTokens)}
                  </span>
                ) : null}
                {goal.failedAttempts > 0 ? (
                  <span className="goal-metric-fail">
                    {t('失败')} {goal.failedAttempts}
                  </span>
                ) : null}
                {goal.requiresUserConfirmation ? <span>{t('完成前需确认')}</span> : null}
              </div>
              {goal.finalSummary ? <div className="goal-final">{goal.finalSummary}</div> : null}
              {goal.lastBlocker ? (
                <div className="goal-blocker">
                  {t('最近阻塞')}：{goal.lastBlocker}
                </div>
              ) : null}
              {goal.pendingTransition ? (
                <div className="goal-pending">
                  {goal.pendingTransition === 'complete_requested'
                    ? t('已请求完成，等待验证')
                    : t('已请求阻塞，等待确认')}
                </div>
              ) : null}
            </section>

            <section className="goal-controls">
              {goal.status === 'active' ? (
                <button className="btn" disabled={busy} onClick={() => void run('goal:pause', {})}>
                  {t('暂停')}
                </button>
              ) : null}
              {['paused', 'blocked', 'max_turns'].includes(goal.status) ? (
                <button className="btn solid" disabled={busy} onClick={() => void run('goal:resume', {})}>
                  {t('继续')}
                </button>
              ) : null}
              <button
                className="btn"
                disabled={busy || goal.status === 'active' || Boolean(goal.currentActivity)}
                title={goal.status === 'active' || goal.currentActivity ? t('目标正在执行，结束后再验证') : undefined}
                onClick={() => void run('goal:verify', {})}
              >
                {t('立即验证')}
              </button>
              <button className="btn" disabled={busy || !isTerminal(goal.status)} onClick={() => setShowForm(true)}>
                {t('新建目标')}
              </button>
              <span className="spacer" />
              {isTerminal(goal.status) ? (
                confirmClear ? (
                  <>
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirmClear(false)
                        void run('goal:clear', {})
                      }}
                    >
                      {t('确认清除')}
                    </button>
                    <button className="btn" onClick={() => setConfirmClear(false)}>
                      {t('取消')}
                    </button>
                  </>
                ) : (
                  <button className="btn danger" disabled={busy} onClick={() => setConfirmClear(true)}>
                    {t('清除')}
                  </button>
                )
              ) : (
                <button className="btn danger" disabled={busy} onClick={() => void run('goal:cancel', {})}>
                  {t('取消目标')}
                </button>
              )}
            </section>

            {!isTerminal(goal.status) ? (
              <section className="goal-steer">
                <input
                  className="settings-input"
                  value={steerDraft}
                  placeholder={t('给下一轮注入指导，例如：先修登录测试，不要动 UI')}
                  onChange={(event) => setSteerDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void steer()
                  }}
                />
                <button className="btn" disabled={busy || !steerDraft.trim()} onClick={() => void steer()}>
                  {t('注入')}
                </button>
              </section>
            ) : null}

            <section className="goal-columns goal-columns-single">
              <div className="goal-column">
                <div className="goal-section-title">{t('验证条件')}</div>
                {goal.verifiers.length === 0 ? (
                  <div className="goal-muted">{t('无显式验证器，使用自动语义验证。')}</div>
                ) : (
                  <ul className="goal-list">
                    {goal.verifiers.map((verifier, index) => (
                      <li key={`${verifier.kind}-${index}`}>
                        <strong>{verifier.label}</strong>
                        <span>{verifier.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="goal-timeline-section">
              <div className="goal-timeline-head">
                <div className="goal-section-title">{t('执行记录')}</div>
                {goal.totalAttempts > 0 ? (
                  <span className="goal-timeline-count">
                    {goal.totalAttempts > goal.attempts.length
                      ? t('最近 {{shown}} 轮 / 共 {{total}} 轮', {
                          shown: goal.attempts.length,
                          total: goal.totalAttempts,
                        })
                      : t('共 {{total}} 轮', { total: goal.totalAttempts })}
                  </span>
                ) : null}
                <span className="spacer" />
                <button
                  className="btn btn-quiet"
                  disabled={exporting || filteredEntries.length === 0}
                  onClick={() => void exportReport()}
                >
                  {exporting ? t('导出中…') : t('导出复盘')}
                </button>
              </div>

              {allEntries.length > 0 ? (
                <div className="goal-filters">
                  <div className="goal-search">
                    <input
                      ref={searchRef}
                      className="settings-input goal-search-input"
                      value={query}
                      placeholder={t('搜索摘要、验证结论或待修项')}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    {query ? (
                      <button className="btn btn-quiet" onClick={() => setQuery('')}>
                        {t('清空搜索')}
                      </button>
                    ) : null}
                    {normalizedQuery ? (
                      <span className="goal-search-count">
                        {t('命中 {{count}} 条', { count: filteredEntries.length })}
                      </span>
                    ) : null}
                  </div>
                  <div className="goal-filter-row" role="group" aria-label={t('按结果筛选')}>
                    {resultOptions.map((option) => (
                      <button
                        key={option.value}
                        className={`goal-chip${resultFilter === option.value ? ' is-active' : ''}`}
                        aria-pressed={resultFilter === option.value}
                        onClick={() => setResultFilter(option.value)}
                      >
                        {t(option.label)} {option.count}
                      </button>
                    ))}
                  </div>
                  {days.length > 1 ? (
                    <div className="goal-filter-row" role="group" aria-label={t('按日期筛选')}>
                      <button
                        className={`goal-chip${dayFilter === 'all' ? ' is-active' : ''}`}
                        aria-pressed={dayFilter === 'all'}
                        onClick={() => setDayFilter('all')}
                      >
                        {t('全部日期')}
                      </button>
                      {days.map((day) => (
                        <button
                          key={day.key}
                          className={`goal-chip${dayFilter === day.key ? ' is-active' : ''}`}
                          aria-pressed={dayFilter === day.key}
                          onClick={() => setDayFilter(day.key)}
                        >
                          {t(day.label)} {day.count}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {stats.length > 0 ? (
                <div className="goal-day-stats" role="group" aria-label={t('按天汇总')}>
                  {stats.map((day) => (
                    <button
                      key={day.key}
                      className={`goal-day-stat${dayFilter === day.key ? ' is-active' : ''}`}
                      aria-pressed={dayFilter === day.key}
                      onClick={() => setDayFilter(dayFilter === day.key ? 'all' : day.key)}
                    >
                      <span className="goal-day-stat-label">{t(day.label)}</span>
                      <span className="goal-day-stat-meta">
                        {t('{{count}} 轮', { count: day.attempts })}
                        {day.failed > 0 ? ` · ${t('失败 {{count}}', { count: day.failed })}` : ''}
                        {day.verifyTotal > 0
                          ? ` · ${t('验证 {{passed}}/{{total}}', { passed: day.verifyPassed, total: day.verifyTotal })}`
                          : ''}
                        {` · ${formatDuration(day.durationMs)}`}
                        {` · +${formatNumber(day.tokens)}`}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {exportNotice ? (
                <div className={`goal-export-note is-${exportNotice.kind}`} title={exportNotice.text}>
                  <span>{exportNotice.text}</span>
                  {exportPath ? (
                    <button
                      className="btn btn-quiet"
                      onClick={() =>
                        void window.xcode.request({
                          id: crypto.randomUUID(),
                          method: 'app:reveal-path',
                          params: { path: exportPath },
                        })
                      }
                    >
                      {window.xcode.platform === 'win32' ? t('打开所在文件夹') : t('在访达中显示')}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {timeline.length === 0 ? (
                <div className="goal-muted">
                  {allEntries.length === 0
                    ? goal.status === 'active'
                      ? t('第一轮开始后会记录在这里。')
                      : t('还没有执行记录。')
                    : t('当前筛选下没有记录。')}
                  {allEntries.length > 0 && filtersActive ? (
                    <button className="btn btn-quiet goal-clear-filter" onClick={clearFilters}>
                      {normalizedQuery ? t('清除筛选与搜索') : t('清除筛选')}
                    </button>
                  ) : null}
                </div>
              ) : (
                timeline.map((group) => (
                  <div key={group.key} className="goal-day-group">
                    <div className="goal-day">{group.label}</div>
                    <ol className="goal-timeline">
                      {group.items.map((entry, index) => {
                        if (entry.kind === 'verify') {
                          const result = entry.result
                          return (
                            <li
                              key={`v-${entry.at}-${index}`}
                              className={`goal-entry is-${result.ok ? 'ok' : 'verify'}`}
                            >
                              <span className="goal-entry-dot" aria-hidden="true" />
                              <div className="goal-entry-main">
                                <div className="goal-entry-head">
                                  <span className="goal-entry-time">{formatClock(entry.at)}</span>
                                  <span className="goal-entry-title">
                                    {result.ok ? '✓' : '✕'} {t('验证')}
                                  </span>
                                  <span className="goal-tag">{t(result.kind)}</span>
                                  <span className={`goal-tag is-${result.ok ? 'ok' : 'verify'}`}>
                                    {result.ok ? t('通过') : t('未通过')}
                                  </span>
                                  <span className="goal-entry-meta">{formatDuration(result.durationMs ?? 0)}</span>
                                  {normalizedQuery && verificationHits.includes(verificationKey(result)) ? (
                                    <span className="goal-tag is-hit">{t('命中日志')}</span>
                                  ) : null}
                                  <button
                                    className="goal-entry-toggle"
                                    aria-expanded={expandedVerify === verificationKey(result)}
                                    onClick={() => toggleVerify(result)}
                                  >
                                    {expandedVerify === verificationKey(result) ? t('收起') : t('原始输出')}
                                  </button>
                                </div>
                                <p className="goal-entry-text">{highlightMatches(result.summary, query)}</p>
                                {result.requiredFixes?.length ? (
                                  <p className="goal-entry-fixes">
                                    {highlightMatches(result.requiredFixes.join(' · '), query)}
                                  </p>
                                ) : null}
                                {expandedVerify === verificationKey(result) ? (
                                  <div className="goal-entry-prompt">
                                    {verifyOutputs[verificationKey(result)] === 'loading' ? (
                                      <div className="goal-prompt-muted">{t('读取原始输出…')}</div>
                                    ) : verifyOutputs[verificationKey(result)] ? (
                                      <>
                                        <pre>
                                          {highlightMatches(verifyOutputs[verificationKey(result)] ?? '', query)}
                                        </pre>
                                        <button
                                          className="btn btn-quiet"
                                          onClick={() =>
                                            window.xcode.copyText(verifyOutputs[verificationKey(result)] ?? '')
                                          }
                                        >
                                          {t('复制原始输出')}
                                        </button>
                                      </>
                                    ) : (
                                      <div className="goal-prompt-muted">{t('没有可用的原始输出。')}</div>
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            </li>
                          )
                        }
                        const attempt = entry.attempt
                        const category = attemptCategory(attempt)
                        const prompt = prompts[attempt.id]
                        const expanded = expandedId === attempt.id
                        return (
                          <li key={`a-${attempt.id}`} className={`goal-entry is-${category}`}>
                            <span className="goal-entry-dot" aria-hidden="true" />
                            <div className="goal-entry-main">
                              <div className="goal-entry-head">
                                <span className="goal-entry-time">{formatClock(attempt.startedAt)}</span>
                                <span className="goal-entry-title">{t('第 {{turn}} 轮', { turn: attempt.turn })}</span>
                                <span className="goal-tag">
                                  {t(INPUT_LABEL[attempt.inputKind] ?? attempt.inputKind)}
                                </span>
                                <span className={`goal-tag is-${category}`}>
                                  {t(FINISH_LABEL[attempt.finish] ?? attempt.finish)}
                                </span>
                                {normalizedQuery && promptHits.includes(attempt.id) ? (
                                  <span className="goal-tag is-hit">{t('命中提示词')}</span>
                                ) : null}
                                <span className="goal-entry-meta">
                                  {formatDuration(attempt.durationMs)} ·{' '}
                                  {t('{{tokens}} token', { tokens: `+${formatNumber(attempt.tokens)}` })}
                                </span>
                                <button
                                  className="goal-entry-toggle"
                                  aria-expanded={expanded}
                                  onClick={() => toggleAttempt(attempt.id)}
                                >
                                  {expanded ? t('收起') : t('展开')}
                                </button>
                              </div>
                              <p className="goal-entry-text">
                                {attempt.promptPreview
                                  ? highlightMatches(attempt.promptPreview, query)
                                  : t('（无摘要）')}
                              </p>
                              {expanded ? (
                                <div className="goal-entry-prompt">
                                  {prompt?.status === 'ready' ? (
                                    <>
                                      <pre>{highlightMatches(prompt.text ?? '', query)}</pre>
                                      <button
                                        className="btn btn-quiet"
                                        onClick={() => window.xcode.copyText(prompt.text ?? '')}
                                      >
                                        {t('复制完整提示词')}
                                      </button>
                                    </>
                                  ) : prompt?.status === 'loading' ? (
                                    <div className="goal-prompt-muted">{t('读取完整提示词…')}</div>
                                  ) : (
                                    <div className="goal-prompt-muted">
                                      {t('完整输入已不在会话记录中，以上为摘要。')}
                                    </div>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                ))
              )}
            </section>
          </>
        ) : null}

        {showForm ? (
          <section className="goal-form">
            <div className="goal-section-title">{t('新建目标')}</div>
            <label className="goal-field">
              <span>{t('目标')}</span>
              <textarea
                className="settings-input goal-textarea"
                value={objective}
                placeholder={t('例如：把这个模块的测试修到全绿，不要改公开 API')}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <div className="goal-examples">
              <span className="goal-examples-hint">{t('试试这些：')}</span>
              {[t('把测试修到全绿，不要改公开 API'), t('补齐 README 与运行说明'), t('重构重复代码并保持行为不变')].map(
                (example) => (
                  <button key={example} type="button" className="goal-example" onClick={() => setObjective(example)}>
                    {example}
                  </button>
                ),
              )}
            </div>
            <div className="goal-form-grid">
              <label className="goal-field">
                <span>{t('验证方式')}</span>
                <select
                  className="settings-input"
                  value={verifierKind}
                  onChange={(event) => setVerifierKind(event.target.value as VerifierKind)}
                >
                  <option value="auto">{t('自动语义验证')}</option>
                  <option value="shell">{t('Shell 命令')}</option>
                  <option value="file">{t('文件检查')}</option>
                  <option value="subagent">{t('子代理验证')}</option>
                </select>
              </label>
              {verifierKind !== 'auto' ? (
                <label className="goal-field">
                  <span>
                    {verifierKind === 'shell'
                      ? t('验证命令')
                      : verifierKind === 'file'
                        ? t('文件路径')
                        : t('子代理名称')}
                  </span>
                  <input
                    className="settings-input"
                    value={verifierValue}
                    placeholder={
                      verifierKind === 'shell'
                        ? 'pnpm test -- foo'
                        : verifierKind === 'file'
                          ? 'dist/report.md'
                          : 'code-reviewer'
                    }
                    onChange={(event) => setVerifierValue(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
            {verifierKind === 'file' ? (
              <label className="goal-field">
                <span>{t('文件需包含（可选）')}</span>
                <input
                  className="settings-input"
                  value={verifierContains}
                  onChange={(event) => setVerifierContains(event.target.value)}
                />
              </label>
            ) : null}
            {verifierKind === 'subagent' ? (
              <label className="goal-field">
                <span>{t('验证提示词（可选）')}</span>
                <textarea
                  className="settings-input goal-textarea"
                  value={verifierPrompt}
                  onChange={(event) => setVerifierPrompt(event.target.value)}
                />
              </label>
            ) : null}
            <div className="goal-form-grid">
              <label className="goal-field">
                <span>{t('最大轮数（可选）')}</span>
                <input
                  className="settings-input"
                  type="number"
                  min={1}
                  value={maxTurns}
                  onChange={(event) => setMaxTurns(event.target.value)}
                />
              </label>
              <label className="goal-field">
                <span>{t('Token 预算（可选）')}</span>
                <input
                  className="settings-input"
                  type="number"
                  min={1}
                  value={tokenBudget}
                  onChange={(event) => setTokenBudget(event.target.value)}
                />
              </label>
            </div>
            <label className="goal-check">
              <input
                type="checkbox"
                checked={confirmCompletion}
                onChange={(event) => setConfirmCompletion(event.target.checked)}
              />
              <span>{t('完成前需要我确认')}</span>
            </label>
            <div className="goal-form-actions">
              <button className="btn solid" disabled={busy} onClick={() => void create()}>
                {t('开始目标')}
              </button>
              {goal ? (
                <button className="btn" disabled={busy} onClick={() => setShowForm(false)}>
                  {t('取消')}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
