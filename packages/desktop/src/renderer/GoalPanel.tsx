import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  GoalCreateInput,
  GoalStatusView,
  GoalView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const STATUS_LABEL: Record<GoalStatusView, string> = {
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

function isTerminal(status: GoalStatusView): boolean {
  return ['complete', 'cancelled', 'budget_limited', 'usage_limited', 'max_turns', 'failed'].includes(status)
}

function formatTime(ts: string | undefined): string {
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

function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString('en-US')
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

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="goal-card" data-testid="goal-panel" onClick={(event) => event.stopPropagation()}>
        <header className="goal-head">
          <div>
            <div className="goal-title">{t('目标循环')}</div>
            <div className="goal-sub">{t('让 Agent 持续执行，直到验证通过或预算耗尽')}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose} aria-label={t('关闭面板')}>
            {t('关闭面板')}
          </button>
        </header>

        {loading ? <div className="goal-empty">{t('读取目标状态…')}</div> : null}
        {error ? <div className="goal-error">{error}</div> : null}

        {goal ? (
          <>
            <section className="goal-summary">
              <div className="goal-summary-top">
                <span className={statusClass}>{t(STATUS_LABEL[goal.status])}</span>
                <span className="goal-time">{t('更新于 {{time}}', { time: formatTime(goal.updatedAt) })}</span>
              </div>
              <div className="goal-objective">{goal.objective}</div>
              <div className="goal-metrics">
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
              <button className="btn" disabled={busy} onClick={() => void run('goal:verify', {})}>
                {t('立即验证')}
              </button>
              <button className="btn" disabled={busy || !isTerminal(goal.status)} onClick={() => setShowForm(true)}>
                {t('新建目标')}
              </button>
              <span className="spacer" />
              {isTerminal(goal.status) ? (
                <button className="btn danger" disabled={busy} onClick={() => void run('goal:clear', {})}>
                  {t('清除')}
                </button>
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

            <section className="goal-columns">
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
              <div className="goal-column">
                <div className="goal-section-title">{t('最近验证')}</div>
                {goal.verificationResults.length === 0 ? (
                  <div className="goal-muted">{t('还没有验证记录。')}</div>
                ) : (
                  <ul className="goal-list">
                    {goal.verificationResults
                      .slice()
                      .reverse()
                      .map((result, index) => (
                        <li key={`${result.at}-${index}`} className={result.ok ? 'goal-ok' : 'goal-fail'}>
                          <strong>
                            {result.ok ? '✓' : '✕'} {t(result.kind)}
                          </strong>
                          <span>{result.summary}</span>
                          {result.requiredFixes?.length ? (
                            <span className="goal-fixes">{result.requiredFixes.join(' · ')}</span>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="goal-attempts">
              <div className="goal-section-title">{t('执行记录')}</div>
              {goal.attempts.length === 0 ? (
                <div className="goal-muted">{t('还没有执行记录。')}</div>
              ) : (
                <div className="goal-attempt-row">
                  {goal.attempts.map((attempt) => (
                    <span key={`${attempt.turn}-${attempt.startedAt}`} className="goal-attempt">
                      #{attempt.turn} · {attempt.inputKind} · {attempt.finish}
                    </span>
                  ))}
                </div>
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
