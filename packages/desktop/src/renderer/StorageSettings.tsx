import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
  StorageUsageView,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface Props {
  onNotice: (message: string | null) => void
}

export function StorageSettings({ onNotice }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [usage, setUsage] = useState<StorageUsageView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const response = await request('storage:usage', {})
    if (response.ok) setUsage(response.result as StorageUsageView)
    else setError(response.error.message)
  }

  useEffect(() => {
    void (async () => {
      const response = await request('storage:usage', {})
      if (response.ok) setUsage(response.result as StorageUsageView)
      else setError(response.error.message)
    })()
  }, [])

  const run = async (id: string, params: Record<string, unknown>): Promise<void> => {
    setBusy(id)
    setError(null)
    onNotice(null)
    try {
      const response = await request('storage:cleanup', params as never)
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as { deletedFiles: number; freedBytes: number; usage: StorageUsageView }
      setUsage(result.usage)
      setConfirming(null)
      onNotice(
        t('已删除 {{files}} 个文件，释放 {{size}}。', {
          files: result.deletedFiles,
          size: formatBytes(result.freedBytes),
        }),
      )
    } finally {
      setBusy(null)
    }
  }

  const actionRow = (
    id: string,
    label: string,
    params: Record<string, unknown>,
    options: { danger?: boolean; hint?: string } = {},
  ): React.JSX.Element => (
    <div className="setting-row" key={id}>
      <div className="setting-main">
        <div className="setting-name">{label}</div>
        {options.hint ? <div className="setting-desc">{options.hint}</div> : null}
      </div>
      <div className="setting-actions-col">
        {confirming === id ? (
          <>
            <button className="btn btn-quiet" onClick={() => setConfirming(null)}>
              {t('取消')}
            </button>
            <button
              className={`btn ${options.danger ? '' : ''}`}
              disabled={busy !== null}
              onClick={() => void run(id, params)}
            >
              {busy === id ? t('清理中…') : t('确认执行')}
            </button>
          </>
        ) : (
          <button className="btn btn-quiet" onClick={() => setConfirming(id)} disabled={busy !== null}>
            {t('清理')}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div className="settings-section-title">{t('存储')}</div>
      <p className="settings-note">{t('所有数据都在本机。清理操作不会影响进行中的会话；置顶的会话不会被批量删除。')}</p>
      {usage ? (
        <div className="storage-total">
          <span>{t('总计 {{size}}', { size: formatBytes(usage.totalBytes) })}</span>
          <button className="btn btn-quiet" onClick={() => void load()}>
            {t('刷新')}
          </button>
        </div>
      ) : null}
      <div className="storage-list">
        {(usage?.categories ?? []).map((category) => (
          <div className="storage-row" key={category.id}>
            <span className="storage-name">{t(category.label)}</span>
            <span className="storage-size">{formatBytes(category.bytes)}</span>
            <span className="storage-files">{t('{{count}} 个文件', { count: category.files })}</span>
            <span className="storage-path" title={category.path}>
              {category.path}
            </span>
            <button className="btn btn-quiet" onClick={() => void request('app:reveal-path', { path: category.path })}>
              {t('打开')}
            </button>
          </div>
        ))}
      </div>

      <div className="settings-section-title">{t('清理')}</div>
      {actionRow(
        'sessions',
        t('删除 30 天前的会话'),
        { sessionsOlderThanDays: 30 },
        {
          hint: t('置顶会话与当前会话会保留。'),
        },
      )}
      {actionRow('attachments', t('删除 7 天前的截图与录音'), { attachmentsOlderThanDays: 7 })}
      {actionRow(
        'library',
        t('清空文档库索引'),
        { library: true },
        {
          hint: t('原始文档不会被删除，只清除索引与向量。'),
        },
      )}
      {actionRow(
        'whisper',
        t('删除语音模型'),
        { whisperModels: true },
        {
          hint: t('下次语音输入时会重新下载（约 75MB）。'),
          danger: true,
        },
      )}
      {error ? <div className="settings-error">{error}</div> : null}
    </>
  )
}
