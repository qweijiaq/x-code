import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ProviderSettingsView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
  SettingsSnapshot,
  TestConnectionResult,
} from '../shared/protocol.js'
import type { ThemeSetting } from './theme.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

interface Props {
  settings: SettingsSnapshot
  theme: ThemeSetting
  language: 'zh' | 'en'
  onTheme: (value: ThemeSetting) => void
  onLanguage: (value: 'zh' | 'en') => void
  onSettings: (settings: SettingsSnapshot) => void
  onDone: () => void
  onSkip: () => void
}

const STEPS = ['选择项目', '连接模型', '偏好'] as const

export function Onboarding({
  settings,
  theme,
  language,
  onTheme,
  onLanguage,
  onSettings,
  onDone,
  onSkip,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [workspace, setWorkspace] = useState(settings.workspace)
  const [provider, setProvider] = useState<ProviderSettingsView>(
    settings.providers.find((entry) => entry.available) ?? settings.providers[0],
  )
  const [keyDraft, setKeyDraft] = useState('')
  const [modelDraft, setModelDraft] = useState(provider.modelId ?? '')
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? '')
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pickWorkspace = async (): Promise<void> => {
    try {
      const picked = await request('app:pick-path', { kind: 'project' })
      if (!picked.ok) {
        setError(picked.error.message)
        return
      }
      const path = (picked.result as { path: string | null }).path
      if (!path) return
      setBusy('workspace')
      setError(null)
      const switched = await request('workspace:switch', { path })
      if (!switched.ok) {
        setError(switched.error.message)
        return
      }
      const result = switched.result as { settings: SettingsSnapshot }
      setWorkspace(path)
      onSettings(result.settings)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const saveProvider = async (): Promise<void> => {
    if (busy !== null) return
    if (provider.name === 'custom') {
      if (!modelDraft.trim()) {
        setError(t('请填写模型 ID'))
        return
      }
      if (!baseUrlDraft.trim()) {
        setError(t('请填写 Base URL'))
        return
      }
      if (!keyDraft.trim() && provider.source === 'none') {
        setError(t('请填写 API Key'))
        return
      }
    } else if (!keyDraft.trim()) {
      // An already stored/env key needs no re-entry: advancing is the save.
      if (provider.source !== 'none') {
        setStep(2)
        return
      }
      setError(t('请填写 API Key，或点击“稍后配置”继续'))
      return
    }
    setBusy('save')
    setError(null)
    try {
      const response =
        provider.name === 'custom'
          ? await request('settings:set-custom-model', {
              modelId: modelDraft.trim(),
              key: keyDraft.trim() || undefined,
              baseUrl: baseUrlDraft.trim() || undefined,
            })
          : await request('settings:set-api-key', {
              provider: provider.name,
              key: keyDraft.trim(),
            })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as { settings: SettingsSnapshot }
      onSettings(result.settings)
      setStep(2)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    if (busy !== null) return
    if (!keyDraft.trim() && provider.source === 'none') {
      setTestResult({
        ok: false,
        modelId: '',
        latencyMs: 0,
        message:
          provider.name === 'custom' ? t('请先填写 Base URL 与 API Key') : t('请先填写 API Key，或使用已保存的 Key'),
      })
      return
    }
    if (provider.name === 'custom' && !baseUrlDraft.trim() && !provider.baseUrl) {
      setTestResult({ ok: false, modelId: '', latencyMs: 0, message: t('请填写 Base URL') })
      return
    }
    setBusy('test')
    setTestResult(null)
    setError(null)
    try {
      const response = await request('settings:test-api-key', {
        provider: provider.name,
        key: keyDraft.trim() || undefined,
        baseUrl: provider.name === 'custom' ? baseUrlDraft.trim() || undefined : undefined,
      })
      setTestResult(
        response.ok
          ? (response.result as TestConnectionResult)
          : { ok: false, modelId: '', latencyMs: 0, message: response.error.message },
      )
    } catch (error) {
      setTestResult({
        ok: false,
        modelId: '',
        latencyMs: 0,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const finish = async (): Promise<void> => {
    setBusy('finish')
    try {
      await request('settings:set-onboarded', { value: true })
    } catch {
      // Onboarding state is only a local preference; never block entry on it.
    } finally {
      setBusy(null)
      onDone()
    }
  }

  const available = settings.providers.find((entry) => entry.available)

  return (
    <div className="modal-scrim onboarding-scrim">
      <div className="onboarding-card" data-testid="onboarding">
        <header className="onboarding-head">
          <div className="onboarding-brand">X-CODE</div>
          <div className="onboarding-steps" aria-hidden="true">
            {STEPS.map((label, index) => (
              <span key={label} className={`onboarding-dot ${index === step ? 'active' : ''}`} title={t(label)} />
            ))}
          </div>
          <button className="btn btn-quiet" onClick={onSkip} disabled={busy !== null}>
            {t('跳过')}
          </button>
        </header>

        {step === 0 ? (
          <section className="onboarding-body">
            <h2 className="onboarding-title">{t('先选择一个工作目录')}</h2>
            <p className="onboarding-text">
              {t('X-Code 会在这个目录里读写文件、运行命令。你可以随时在侧边栏切换项目。')}
            </p>
            <div className="onboarding-field">
              <span className="onboarding-label">{t('当前目录')}</span>
              <code className="onboarding-path">{workspace}</code>
            </div>
            <div className="onboarding-actions">
              <button className="btn btn-quiet" onClick={() => void pickWorkspace()} disabled={busy !== null}>
                {busy === 'workspace' ? t('切换中…') : t('选择文件夹')}
              </button>
              <button className="btn" onClick={() => setStep(1)} disabled={busy !== null}>
                {t('下一步')}
              </button>
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding-body">
            <h2 className="onboarding-title">{t('连接一个模型')}</h2>
            {available ? (
              <p className="onboarding-text">
                {t('已经检测到可用的模型服务：{{name}}。你也可以重新配置或直接继续。', {
                  name: available.name,
                })}
              </p>
            ) : (
              <p className="onboarding-text">
                {t('API Key 只保存在本机，优先使用系统钥匙串加密。没有 Key 也可以先用演示模型浏览界面。')}
              </p>
            )}
            <div className="onboarding-field">
              <span className="onboarding-label">{t('服务商')}</span>
              <div className="onboarding-providers">
                {settings.providers.map((entry) => (
                  <button
                    key={entry.name}
                    className={`onboarding-provider ${provider.name === entry.name ? 'active' : ''}`}
                    onClick={() => {
                      setProvider(entry)
                      setKeyDraft('')
                      setModelDraft(entry.modelId ?? '')
                      setBaseUrlDraft(entry.baseUrl ?? '')
                      setTestResult(null)
                    }}
                  >
                    <span>{entry.name}</span>
                    {entry.available ? <span className="onboarding-available">{t('已配置')}</span> : null}
                  </button>
                ))}
              </div>
            </div>
            {provider.name === 'custom' ? (
              <>
                <div className="onboarding-field">
                  <span className="onboarding-label">Base URL</span>
                  <input
                    className="settings-input"
                    value={baseUrlDraft}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => setBaseUrlDraft(event.target.value)}
                  />
                </div>
                <div className="onboarding-field">
                  <span className="onboarding-label">{t('模型 ID')}</span>
                  <input
                    className="settings-input"
                    value={modelDraft}
                    placeholder="your-model-id"
                    onChange={(event) => setModelDraft(event.target.value)}
                  />
                </div>
              </>
            ) : null}
            <div className="onboarding-field">
              <span className="onboarding-label">API Key</span>
              <input
                className="settings-input"
                type="password"
                value={keyDraft}
                placeholder={provider.source === 'stored' ? (provider.hint ?? '••••') : provider.envKey}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
            </div>
            {testResult ? (
              <div className={`onboarding-test ${testResult.ok ? 'ok' : 'fail'}`}>
                {testResult.ok
                  ? t('连接成功 · {{model}} · {{ms}}ms', { model: testResult.modelId, ms: testResult.latencyMs })
                  : testResult.message}
              </div>
            ) : null}
            {error ? <div className="settings-warn">{error}</div> : null}
            <div className="onboarding-actions">
              <button className="btn btn-quiet" onClick={() => setStep(0)} disabled={busy !== null}>
                {t('上一步')}
              </button>
              <button className="btn btn-quiet" onClick={() => void testConnection()} disabled={busy !== null}>
                {busy === 'test' ? t('测试中…') : t('测试连接')}
              </button>
              <button className="btn btn-quiet" onClick={() => setStep(2)} disabled={busy !== null}>
                {available && !keyDraft.trim() ? t('继续') : t('稍后配置')}
              </button>
              <button className="btn" onClick={() => void saveProvider()} disabled={busy !== null}>
                {busy === 'save' ? t('保存中…') : t('保存并继续')}
              </button>
            </div>
          </section>
        ) : null}

        {step >= 2 ? (
          <section className="onboarding-body">
            <h2 className="onboarding-title">{t('按你的习惯来')}</h2>
            <div className="onboarding-field">
              <span className="onboarding-label">{t('外观')}</span>
              <div className="onboarding-choices">
                {(
                  [
                    ['system', t('跟随系统')],
                    ['light', t('浅色')],
                    ['dark', t('深色')],
                  ] as Array<[ThemeSetting, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`onboarding-provider ${theme === value ? 'active' : ''}`}
                    onClick={() => onTheme(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="onboarding-field">
              <span className="onboarding-label">{t('语言')}</span>
              <div className="onboarding-choices">
                <button
                  className={`onboarding-provider ${language === 'zh' ? 'active' : ''}`}
                  onClick={() => onLanguage('zh')}
                >
                  中文
                </button>
                <button
                  className={`onboarding-provider ${language === 'en' ? 'active' : ''}`}
                  onClick={() => onLanguage('en')}
                >
                  English
                </button>
              </div>
            </div>
            <p className="onboarding-text">
              {t('之后可以在设置里调整技能、MCP、插件、沙箱和通知。输入 /help 查看所有命令。')}
            </p>
            <div className="onboarding-actions">
              <button className="btn btn-quiet" onClick={() => setStep(1)} disabled={busy !== null}>
                {t('上一步')}
              </button>
              <button className="btn" onClick={() => void finish()} disabled={busy !== null}>
                {busy === 'finish' ? t('准备中…') : t('开始使用')}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
