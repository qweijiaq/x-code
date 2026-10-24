import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AppState,
  ProjectSettingsView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
  SettingsActionResult,
  SettingsSnapshot,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const TASK_MODES = [
  ['coding', '编码'],
  ['writing', '写作'],
  ['research', '研究'],
  ['office', '办公'],
] as const

interface Props {
  settings: SettingsSnapshot
  onSettings: (settings: SettingsSnapshot) => void
  onState: (state: AppState) => void
  onNotice: (message: string | null) => void
}

export function ProjectSettings({ onSettings, onState, onNotice }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<ProjectSettingsView | null>(null)
  const [state, setLocalState] = useState<AppState | null>(null)
  const [modelId, setModelId] = useState('')
  const [taskMode, setTaskMode] = useState('coding')
  const [autoChecks, setAutoChecks] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [projectResponse, stateResponse] = await Promise.all([
        request('project:settings', {}),
        request('app:state', {}),
      ])
      if (projectResponse.ok) {
        const next = projectResponse.result as ProjectSettingsView
        setView(next)
        setModelId(next.overrides.modelId ?? next.effective.modelId)
        setTaskMode(next.overrides.taskMode ?? next.effective.taskMode)
        setAutoChecks(next.overrides.autoChecks ?? next.effective.autoChecks)
      } else {
        setError(projectResponse.error.message)
      }
      if (stateResponse.ok) setLocalState(stateResponse.result as AppState)
    })()
  }, [])

  const save = async (): Promise<void> => {
    setBusy('save')
    setError(null)
    onNotice(null)
    try {
      const response = await request('project:save', { modelId, taskMode, autoChecks })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as SettingsActionResult
      onSettings(result.settings)
      onState(result.state)
      const refreshed = await request('project:settings', {})
      if (refreshed.ok) setView(refreshed.result as ProjectSettingsView)
      onNotice(t('项目设置已保存。'))
    } finally {
      setBusy(null)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy('clear')
    setError(null)
    try {
      const response = await request('project:save', { modelId: null, taskMode: null, autoChecks: null })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as SettingsActionResult
      onSettings(result.settings)
      onState(result.state)
      const refreshed = await request('project:settings', {})
      if (refreshed.ok) {
        const next = refreshed.result as ProjectSettingsView
        setView(next)
        setModelId(next.effective.modelId)
        setTaskMode(next.effective.taskMode)
        setAutoChecks(next.effective.autoChecks)
      }
      onNotice(t('已清除项目覆盖，恢复全局设置。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="settings-section-title">{t('项目设置')}</div>
      <p className="settings-note">{t('这些设置只对当前工作区生效，切换项目时自动应用。没有覆盖的项沿用全局设置。')}</p>
      <p className="settings-note" data-testid="project-workspace">
        {view?.workspace ?? '…'}
      </p>

      <div className="setting-row">
        <div className="setting-main">
          <div className="setting-name">{t('默认模型')}</div>
          <div className="setting-desc">
            {t('进入这个项目时自动切换到所选模型。')}
            {view?.overrides.modelId ? ` · ${t('已覆盖')}` : ` · ${t('跟随全局')}`}
          </div>
        </div>
        <div className="setting-actions-col">
          <select className="settings-input" value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {(state?.models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.provider}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-main">
          <div className="setting-name">{t('默认任务模式')}</div>
          <div className="setting-desc">
            {t('编码 / 写作 / 研究 / 办公对应不同的提示与示例。')}
            {view?.overrides.taskMode ? ` · ${t('已覆盖')}` : ` · ${t('跟随全局')}`}
          </div>
        </div>
        <div className="setting-actions-col">
          <div className="settings-segments">
            <div className="settings-segment">
              {TASK_MODES.map(([value, label]) => (
                <button
                  key={value}
                  className={`settings-tab-inline ${taskMode === value ? 'active' : ''}`}
                  onClick={() => setTaskMode(value)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-main">
          <div className="setting-name">{t('自动项目检查')}</div>
          <div className="setting-desc">
            {t('每轮完成后自动运行类型检查 / 测试。')}
            {view?.overrides.autoChecks !== undefined ? ` · ${t('已覆盖')}` : ` · ${t('跟随全局')}`}
          </div>
        </div>
        <div className="setting-actions-col">
          <button
            className={`settings-toggle ${autoChecks ? 'on' : ''}`}
            onClick={() => setAutoChecks((value) => !value)}
          >
            {autoChecks ? t('已开启（点击关闭）') : t('开启')}
          </button>
        </div>
      </div>

      <div className="settings-actions">
        <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void clear()}>
          {busy === 'clear' ? t('清除中…') : t('清除项目覆盖')}
        </button>
        <button className="btn" disabled={busy !== null} onClick={() => void save()}>
          {busy === 'save' ? t('保存中…') : t('保存项目设置')}
        </button>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </>
  )
}
