import { useTranslation } from 'react-i18next'

import type { ProjectCheckResultView, ProjectCheckView } from '../shared/protocol.js'

interface ChecksPanelProps {
  checks: ProjectCheckView[]
  results: ProjectCheckResultView[]
  autoChecks: boolean
  loading: boolean
  error: string | null
  onRefresh(): void
  onRun(): void
  onToggleAuto(): void
  onFix(): void
  onClose(): void
  /** Render inside the unified inspector instead of a fixed drawer. */
  embedded?: boolean
}

const STATUS_LABEL: Record<ProjectCheckResultView['status'], string> = {
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
  timeout: '超时',
}

export function ChecksPanel({
  checks,
  results,
  autoChecks,
  loading,
  error,
  onRefresh,
  onRun,
  onToggleAuto,
  onFix,
  onClose,
  embedded = false,
}: ChecksPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const hasFailures = results.some((result) => result.status === 'failed' || result.status === 'timeout')

  return (
    <>
      {!embedded ? <div className="drawer-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <aside
        className={`checks-drawer${embedded ? ' embedded' : ''}`}
        data-testid="checks-drawer"
        aria-label={t('项目检查')}
      >
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            检
          </span>
          <div className="drawer-title">
            {t('项目检查')}
            <span className="document-path">{t('{{count}} 项检查', { count: checks.length })}</span>
          </div>
          <button className={`btn ${autoChecks ? 'solid' : ''}`} onClick={onToggleAuto}>
            {t('自动检查')}：{autoChecks ? t('开') : t('关')}
          </button>
          <button className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? t('加载中…') : t('刷新')}
          </button>
          <button className="btn solid" onClick={onRun} disabled={loading || checks.length === 0}>
            {loading ? t('运行中…') : t('运行全部')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('关闭')}
          </button>
        </header>

        <div className="checks-body">
          {error ? <div className="settings-warn">{error}</div> : null}
          {checks.length === 0 ? (
            <div className="settings-empty">{t('未检测到可运行的项目检查')}</div>
          ) : (
            <div className="checks-list">
              {checks.map((check) => {
                const result = results.find((entry) => entry.id === check.id)
                return (
                  <div key={check.id} className="check-item">
                    <span className={`check-status ${result?.status ?? 'idle'}`}>
                      {result ? t(STATUS_LABEL[result.status]) : t('等待')}
                    </span>
                    <span className="check-label">{check.label}</span>
                    <span className="check-command">{check.commandLine}</span>
                    {result ? (
                      <span className="check-duration">
                        {result.durationMs > 0 ? `${(result.durationMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    ) : null}
                    {result?.output ? (
                      <details className="check-output">
                        <summary>{t('输出')}</summary>
                        <pre>{result.output}</pre>
                      </details>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          {hasFailures ? (
            <div className="checks-actions">
              <button className="settings-btn primary" onClick={onFix}>
                {t('交给 Agent 修复')}
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}
