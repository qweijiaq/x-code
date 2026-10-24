import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  BackupExportView,
  BackupImportView,
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
  onSessionsChanged?: () => void
}

export function StorageSettings({ onNotice, onSessionsChanged }: Props): React.JSX.Element {
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

  const pickFolder = async (): Promise<string | null> => {
    const response = await request('app:pick-path', { kind: 'folder' })
    if (!response.ok) {
      setError(response.error.message)
      return null
    }
    return (response.result as { path: string | null }).path
  }

  const exportBackup = async (): Promise<void> => {
    const destination = await pickFolder()
    if (!destination) return
    setBusy('backup-export')
    setError(null)
    onNotice(null)
    try {
      const response = await request('backup:export', { destination })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as BackupExportView
      onNotice(
        t('备份已导出到 {{path}}（会话 {{sessions}}、技能 {{skills}}）', {
          path: result.path,
          sessions: result.counts.sessions,
          skills: result.counts.skills,
        }),
      )
    } finally {
      setBusy(null)
    }
  }

  const importBackup = async (): Promise<void> => {
    const source = await pickFolder()
    if (!source) return
    setBusy('backup-import')
    setError(null)
    onNotice(null)
    try {
      const response = await request('backup:import', { source })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as BackupImportView
      onNotice(
        t('恢复完成：新增 {{imported}} 项，跳过 {{skipped}} 项（已存在的文件不会被覆盖）', {
          imported: Object.values(result.imported).reduce((sum, count) => sum + count, 0),
          skipped: Object.values(result.skipped).reduce((sum, count) => sum + count, 0),
        }),
      )
      onSessionsChanged?.()
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

      <div className="settings-section-title">{t('备份与恢复')}</div>
      <p className="settings-note">
        {t('备份会话、技能、命令、记忆和子代理；不包含密钥、插件、附件和日志。恢复只补充缺失文件，不会覆盖现有数据。')}
      </p>
      <div className="settings-actions">
        <button
          className="btn solid"
          data-testid="backup-export"
          disabled={busy !== null}
          onClick={() => void exportBackup()}
        >
          {busy === 'backup-export' ? t('导出中…') : t('导出备份')}
        </button>
        <button
          className="btn"
          data-testid="backup-import"
          disabled={busy !== null}
          onClick={() => void importBackup()}
        >
          {busy === 'backup-import' ? t('恢复中…') : t('从备份恢复')}
        </button>
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
