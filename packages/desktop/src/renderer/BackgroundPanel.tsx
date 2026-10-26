import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  BackgroundShellView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const STATUS_LABEL: Record<BackgroundShellView['status'], string> = {
  starting: '启动中',
  running: '运行中',
  'root-exited': '主进程已退出',
  terminating: '终止中',
  'termination-failed': '终止失败',
  finalizing: '收尾中',
  exited: '已结束',
  failed: '失败',
}

function isActive(status: BackgroundShellView['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'terminating' || status === 'finalizing'
}

function formatElapsed(ms: number | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatBytes(bytes: number | undefined): string {
  const value = Math.max(0, bytes ?? 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** 从会打印百分比的工具（npm、pip、ffmpeg、curl 等）尽力提取进度。
 *  shell 命令没有结构化的进度通道，因此退回由耗时计时器驱动的
 *  不确定进度条。 */
function lastPercent(text: string): number | null {
  let found: number | null = null
  for (const match of text.matchAll(/(\d{1,3})\s*%/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 0 && value <= 100) found = value
  }
  return found
}

export function BackgroundPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<BackgroundShellView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const response = await request('background:list', {})
    if (response.ok) {
      setSessions((response.result as { sessions: BackgroundShellView[] }).sessions)
      setError(null)
    } else {
      setError(response.error.message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    const off = window.xcode.onEvent((event) => {
      if (event.type === 'background:changed') void refresh()
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [refresh])

  const stop = async (shellId: string): Promise<void> => {
    setStopping(shellId)
    try {
      await request('background:stop', { shellId })
      await refresh()
    } finally {
      setStopping(null)
    }
  }

  const activeCount = sessions.filter((session) => isActive(session.status)).length

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="background-drawer" data-testid="background-drawer" aria-label={t('后台任务')}>
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            务
          </span>
          <div className="drawer-titles">
            <div className="drawer-title">{t('后台任务')}</div>
            <div className="drawer-sub">
              {t('自动超出等待时间的 shell 命令')}
              {activeCount > 0 ? ` · ${t('{{count}} 个运行中', { count: activeCount })}` : ''}
            </div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose}>
            {t('关闭')}
          </button>
        </header>
        <div className="background-body">
          {error ? <div className="settings-warn">{error}</div> : null}
          {!error && sessions.length === 0 ? <div className="background-empty">{t('暂无后台任务')}</div> : null}
          {sessions.map((session) => {
            const open = expanded === session.shellId
            const active = isActive(session.status)
            const percent = lastPercent(session.recentOutput)
            const outputBytes = session.outputBytes ?? session.omittedBytes + session.recentOutput.length
            const failed =
              session.status === 'failed' ||
              session.status === 'termination-failed' ||
              (session.exitCode !== undefined && session.exitCode !== 0)
            return (
              <div className="background-item" key={session.shellId}>
                <div className="background-row">
                  <span className={`background-status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
                  <code className="background-command" title={session.command}>
                    {session.command}
                  </code>
                  <span className="background-meta">{session.cwd}</span>
                  {active ? (
                    <button
                      className="btn btn-quiet"
                      disabled={stopping === session.shellId}
                      onClick={() => void stop(session.shellId)}
                    >
                      {stopping === session.shellId ? t('停止中…') : t('停止')}
                    </button>
                  ) : (
                    <span className="background-meta">
                      {session.exitCode !== undefined ? `exit ${session.exitCode}` : ''}
                      {session.timedOut ? ` · ${t('超时')}` : ''}
                    </span>
                  )}
                </div>
                <div className="background-progress">
                  <span
                    className={`background-progress-fill ${active && percent === null ? 'indeterminate' : ''} ${
                      failed ? 'failed' : ''
                    }`}
                    style={percent !== null ? { width: `${percent}%` } : active ? undefined : { width: '100%' }}
                  />
                </div>
                <div className="background-stats">
                  <span>
                    {active ? t('已运行') : t('耗时')} {formatElapsed(session.elapsedMs)}
                  </span>
                  {percent !== null ? <span>{percent}%</span> : null}
                  <span>{t('输出 {{size}}', { size: formatBytes(outputBytes) })}</span>
                </div>
                {session.failure ? <div className="settings-warn">{session.failure}</div> : null}
                <button className="background-toggle" onClick={() => setExpanded(open ? null : session.shellId)}>
                  {open ? t('收起输出') : t('查看输出')}
                  {session.omittedBytes > 0 ? ` · ${t('已省略 {{bytes}} 字节', { bytes: session.omittedBytes })}` : ''}
                </button>
                {open ? <pre className="background-output">{session.recentOutput || t('（没有输出）')}</pre> : null}
              </div>
            )
          })}
        </div>
      </aside>
    </>
  )
}
