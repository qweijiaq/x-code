import { useTranslation } from 'react-i18next'

import type { GitStatusView } from '../shared/protocol.js'

interface GitPanelProps {
  status: GitStatusView | null
  loading: boolean
  error: string | null
  selected: { path: string; staged: boolean } | null
  diff: string | null
  diffTruncated: boolean
  busy: boolean
  onRefresh(): void
  onSelect(path: string, staged: boolean): void
  onUndo(): void
  onOpenEditor?(path: string, line?: number): void
  onClose(): void
  /** 在统一检查器内渲染，而非固定抽屉。 */
  embedded?: boolean
}

function statusLabel(status: string, untracked: boolean, staged: boolean): string {
  if (untracked) return '?'
  const first = status[0] ?? ' '
  const second = status[1] ?? ' '
  if (staged && first !== ' ') return first === 'R' ? 'R' : first
  if (second !== ' ') return second === 'M' ? 'M' : second
  return staged ? first : second
}

function statusClass(status: string, untracked: boolean): string {
  if (untracked) return 'untracked'
  if (status.includes('D')) return 'deleted'
  if (status.includes('A')) return 'added'
  return 'modified'
}

export function GitPanel({
  status,
  loading,
  error,
  selected,
  diff,
  diffTruncated,
  busy,
  onRefresh,
  onSelect,
  onUndo,
  onOpenEditor,
  onClose,
  embedded = false,
}: GitPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const firstChangedLine = (() => {
    const match = diff?.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m)
    return match ? Number(match[1]) : 1
  })()

  return (
    <>
      {!embedded ? <div className="drawer-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <aside className={`git-drawer${embedded ? ' embedded' : ''}`} data-testid="git-drawer" aria-label={t('变更')}>
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            变
          </span>
          <div className="drawer-title">
            {t('变更')}
            {status?.branch ? (
              <span className="document-path">{t('分支 {{branch}}', { branch: status.branch })}</span>
            ) : null}
          </div>
          <button className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? t('加载中…') : t('刷新')}
          </button>
          <button className="btn" onClick={onUndo} disabled={busy || !status?.checkpoint}>
            {busy ? t('撤销中…') : t('撤销本轮')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('关闭')}
          </button>
        </header>

        <div className="git-body">
          {error ? (
            <div className="settings-warn">
              {error === '没有可撤销的 checkpoint（本轮可能尚未产生改动）'
                ? t('没有可撤销的 checkpoint（本轮可能尚未产生改动）')
                : error}
            </div>
          ) : null}
          {!status ? (
            <div className="settings-empty">{t('加载中…')}</div>
          ) : !status.isRepo ? (
            <div className="settings-empty">{t('当前工作区不是 Git 仓库')}</div>
          ) : (
            <>
              <div className="git-summary">
                <span className="git-add">+{status.additions}</span>
                <span className="git-del">−{status.removals}</span>
                <span>{t('{{count}} 个文件变更', { count: status.files.length })}</span>
                {status.ahead ? <span>{t('领先 {{ahead}}', { ahead: status.ahead })}</span> : null}
                {status.behind ? <span>{t('落后 {{behind}}', { behind: status.behind })}</span> : null}
                {status.checkpoint ? (
                  <span className="git-checkpoint">
                    {t('可撤销本轮（{{time}}）', { time: new Date(status.checkpoint.createdAt).toLocaleTimeString() })}
                  </span>
                ) : (
                  <span className="git-checkpoint muted">{t('本轮暂无可撤销的改动')}</span>
                )}
              </div>
              {status.root ? <div className="settings-hint">{status.root}</div> : null}

              <div className="git-files">
                {status.files.length === 0 ? (
                  <div className="settings-empty">{t('工作区没有改动')}</div>
                ) : (
                  status.files.map((file) => {
                    const active = selected?.path === file.path
                    return (
                      <button
                        key={file.path}
                        className={`git-file ${active ? 'active' : ''}`}
                        onClick={() => onSelect(file.path, file.staged)}
                      >
                        <span className={`git-file-status ${statusClass(file.status, file.untracked)}`}>
                          {statusLabel(file.status, file.untracked, file.staged)}
                        </span>
                        <span className="git-file-path">{file.path}</span>
                        <span className="git-file-stage">
                          {file.untracked ? t('未跟踪') : file.staged ? t('已暂存') : t('未暂存')}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>

              <div className="git-diff">
                {selected ? (
                  <>
                    <div className="git-diff-head">
                      <span>{selected.path}</span>
                      {onOpenEditor ? (
                        <button
                          className="session-action"
                          onClick={() => onOpenEditor(selected.path, firstChangedLine)}
                        >
                          {t('在编辑器打开')}
                        </button>
                      ) : null}
                      {diffTruncated ? <span className="settings-warn">{t('diff 已截断')}</span> : null}
                    </div>
                    <pre className="git-diff-body">
                      {(diff ?? '').split('\n').map((line, index) => (
                        <span
                          key={index}
                          className={`diff-line ${
                            line.startsWith('+') && !line.startsWith('+++')
                              ? 'add'
                              : line.startsWith('-') && !line.startsWith('---')
                                ? 'del'
                                : ''
                          }`}
                        >
                          {line || ' '}
                        </span>
                      ))}
                    </pre>
                  </>
                ) : (
                  <div className="settings-empty">{t('选择文件查看 diff')}</div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
