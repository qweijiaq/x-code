import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  LoadedSessionView,
  RequestMap,
  RequestMethod,
  RewindCheckpointView,
  RewindResultView,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

type RewindMode = 'both' | 'code' | 'conversation'

interface Props {
  onClose: () => void
  onRewound: (view: LoadedSessionView, mode: RewindMode) => void
}

function formatTime(ts: string): string {
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

export function RewindPanel({ onClose, onRewound }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [checkpoints, setCheckpoints] = useState<RewindCheckpointView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [stats, setStats] = useState<{ filesChanged: string[]; insertions: number; deletions: number } | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const response = await request('session:checkpoints', {})
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const list = (response.result as { checkpoints: RewindCheckpointView[] }).checkpoints
      setCheckpoints(list)
      setSelected(list.length > 0 ? list[list.length - 1].ckptId : null)
    })()
  }, [])

  useEffect(() => {
    if (!selected) {
      setStats(null)
      return
    }
    void (async () => {
      const response = await request('session:checkpoint-diff', { ckptId: selected })
      setStats(response.ok ? (response.result as typeof stats) : null)
    })()
  }, [selected])

  const restore = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const response = await request('session:rewind', { ckptId: selected, mode })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as RewindResultView
      onRewound(result.view, mode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim">
      <div className="rewind-card" data-testid="rewind-panel">
        <div className="approval-head">
          <span className="drawer-seal" aria-hidden="true">
            回
          </span>
          <div>
            <div className="approval-title">{t('回退到检查点')}</div>
            <div className="approval-sub">{t('每一轮对话开始时都会记录一次工作区快照')}</div>
          </div>
        </div>

        {checkpoints.length === 0 ? (
          <div className="rewind-empty">{t('还没有回退点。发送一条消息后，这里会出现在检查点。')}</div>
        ) : (
          <div className="rewind-list">
            {checkpoints.map((checkpoint) => (
              <button
                key={checkpoint.ckptId}
                className={`rewind-item ${selected === checkpoint.ckptId ? 'active' : ''}`}
                onClick={() => setSelected(checkpoint.ckptId)}
              >
                <span className="rewind-time">{formatTime(checkpoint.ts)}</span>
                <span className="rewind-prompt">{checkpoint.userPrompt || checkpoint.ckptId}</span>
              </button>
            ))}
          </div>
        )}

        {selected ? (
          <div className="rewind-summary">
            {stats
              ? t('{{files}} 个文件 · +{{insertions}} −{{deletions}}', {
                  files: stats.filesChanged.length,
                  insertions: stats.insertions,
                  deletions: stats.deletions,
                })
              : t('正在读取检查点…')}
          </div>
        ) : null}

        <div className="rewind-modes">
          {(
            [
              ['both', t('代码与对话')],
              ['code', t('仅代码')],
              ['conversation', t('仅对话')],
            ] as Array<[RewindMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              className={`rewind-mode ${mode === value ? 'active' : ''}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {error ? <div className="settings-warn">{error}</div> : null}

        <div className="rewind-actions">
          <button className="btn btn-quiet" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button className="btn" onClick={() => void restore()} disabled={!selected || busy}>
            {busy ? t('回退中…') : t('回退')}
          </button>
        </div>
      </div>
    </div>
  )
}
