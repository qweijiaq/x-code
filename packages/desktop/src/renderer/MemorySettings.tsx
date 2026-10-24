import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { MemoryPanelView, RequestMap, RequestMethod, RuntimeRequest, RuntimeResponse } from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return value
  }
}

export function MemorySettings({ onNotice }: { onNotice: (message: string | null) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [panel, setPanel] = useState<MemoryPanelView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const applyPanel = (next: MemoryPanelView): void => {
    setPanel(next)
  }

  useEffect(() => {
    void (async () => {
      const response = await request('memory:panel', {})
      if (response.ok) setPanel(response.result as MemoryPanelView)
      else setError(response.error.message)
    })()
  }, [])

  const openTopic = async (id: string): Promise<void> => {
    setSelected(id)
    setDeleting(false)
    setError(null)
    const response = await request('memory:topic', { id })
    if (response.ok) setDraft((response.result as { content: string }).content)
    else setError(response.error.message)
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    setBusy('save')
    setError(null)
    onNotice(null)
    try {
      const response = await request('memory:save-topic', { id: selected, content: draft })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      applyPanel(response.result as MemoryPanelView)
      onNotice(t('已保存记忆主题 {{id}}。', { id: selected }))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    setBusy('delete')
    setError(null)
    try {
      const response = await request('memory:delete-topic', { id: selected })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      applyPanel(response.result as MemoryPanelView)
      setSelected(null)
      setDraft('')
      setDeleting(false)
      onNotice(t('已删除记忆主题。'))
    } finally {
      setBusy(null)
    }
  }

  const reload = async (): Promise<void> => {
    setBusy('reload')
    setError(null)
    try {
      const response = await request('memory:reload', {})
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      applyPanel(response.result as MemoryPanelView)
      onNotice(t('已重新加载记忆。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="settings-section-title">{t('用户记忆')}</div>
      <p className="settings-note">
        {t(
          '助手会在对话后自动提炼稳定事实，形成主题文件。这里可以查看、直接编辑或删除主题；修改后会立即重新加载并进入下一轮的系统提示。主题文件里的 x-memory 标记承载事实元数据，请保留其格式。',
        )}
      </p>

      {panel ? (
        <>
          <div className="memory-stats">
            <span>
              {t('{{topics}} 个主题 · {{facts}} 条事实', { topics: panel.status.topics, facts: panel.status.facts })}
            </span>
            <span>
              {t('队列 等待 {{pending}} / 运行 {{running}} / 失败 {{failed}}', {
                pending: panel.status.queue.pending,
                running: panel.status.queue.running,
                failed: panel.status.queue.failed,
              })}
            </span>
            <span className="memory-root" title={panel.root}>
              {panel.root}
            </span>
            <button className="btn btn-quiet" onClick={() => void request('app:reveal-path', { path: panel.root })}>
              {t('打开文件夹')}
            </button>
            <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void reload()}>
              {busy === 'reload' ? t('重新加载中…') : t('重新加载')}
            </button>
          </div>
          {panel.status.error ? <div className="settings-warn">{panel.status.error}</div> : null}
          {panel.status.invalidTopics.length > 0 ? (
            <div className="settings-warn">
              {panel.status.invalidTopics.map((item) => `${item.path}: ${item.error}`).join('\n')}
            </div>
          ) : null}

          <div className="memory-list">
            {panel.topics.length === 0 ? (
              <div className="settings-note">{t('还没有记忆主题。进行几轮对话后会自动生成。')}</div>
            ) : null}
            {panel.topics.map((topic) => (
              <button
                key={topic.id}
                className={`memory-row ${selected === topic.id ? 'active' : ''}`}
                onClick={() => void openTopic(topic.id)}
              >
                <span className="memory-type">{topic.type}</span>
                <span className="memory-summary">{topic.summary || topic.description || topic.id}</span>
                <span className="memory-meta">{t('{{count}} 条', { count: topic.facts })}</span>
                <span className="memory-meta">{formatTime(topic.updatedAt)}</span>
                {topic.pinned ? <span className="memory-pinned">{t('置顶')}</span> : null}
              </button>
            ))}
          </div>

          {selected ? (
            <div className="settings-form">
              <div className="settings-section-title">{t('编辑主题 {{id}}', { id: selected })}</div>
              <textarea
                className="settings-input settings-textarea settings-mono"
                rows={16}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="settings-actions">
                <button
                  className="btn btn-quiet"
                  onClick={() => {
                    setSelected(null)
                    setDeleting(false)
                  }}
                >
                  {t('取消')}
                </button>
                {deleting ? (
                  <button className="btn btn-quiet danger" disabled={busy !== null} onClick={() => void remove()}>
                    {busy === 'delete' ? t('删除中…') : t('确认删除主题')}
                  </button>
                ) : (
                  <button className="btn btn-quiet" disabled={busy !== null} onClick={() => setDeleting(true)}>
                    {t('删除')}
                  </button>
                )}
                <button className="btn" disabled={busy !== null} onClick={() => void save()}>
                  {busy === 'save' ? t('保存中…') : t('保存主题')}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="settings-note">{t('正在读取记忆…')}</div>
      )}
      {error ? <div className="settings-error">{error}</div> : null}
    </>
  )
}
