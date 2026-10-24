import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { HooksView, RequestMap, RequestMethod, RuntimeRequest, RuntimeResponse } from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const EMPTY_CONFIG = '{\n  "PreToolUse": []\n}'

export function HooksSettings({ onNotice }: { onNotice: (message: string | null) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<HooksView | null>(null)
  const [userDraft, setUserDraft] = useState('')
  const [projectDraft, setProjectDraft] = useState('')
  const [busy, setBusy] = useState<'user' | 'project' | 'trust' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyView = (next: HooksView): void => {
    setView(next)
    setUserDraft(JSON.stringify(next.configs.user ?? {}, null, 2))
    setProjectDraft(JSON.stringify(next.configs.project ?? {}, null, 2))
  }

  useEffect(() => {
    void (async () => {
      const response = await request('hooks:get', {})
      if (response.ok) applyView(response.result as HooksView)
      else setError(response.error.message)
    })()
  }, [])

  const setTrust = async (trusted: boolean): Promise<void> => {
    setBusy('trust')
    setError(null)
    onNotice(null)
    try {
      const response = await request('hooks:trust-project', { trusted })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      applyView(response.result as HooksView)
      onNotice(trusted ? t('已信任此项目的 hooks。') : t('已撤销此项目的 hooks 信任。'))
    } finally {
      setBusy(null)
    }
  }

  const save = async (scope: 'user' | 'project'): Promise<void> => {
    setBusy(scope)
    setError(null)
    onNotice(null)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(scope === 'user' ? userDraft : projectDraft) as unknown
      } catch (parseError) {
        setError(
          t('JSON 格式错误：{{message}}', {
            message: parseError instanceof Error ? parseError.message : String(parseError),
          }),
        )
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError(t('hooks 配置必须是 JSON 对象'))
        return
      }
      const response = await request('hooks:save', { scope, config: parsed as Record<string, unknown> })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      applyView(response.result as HooksView)
      onNotice(scope === 'user' ? t('已保存用户级 hooks。') : t('已保存项目级 hooks。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="settings-section-title">{t('Hooks')}</div>
      <p className="settings-note">
        {t(
          'Hook 是在对话生命周期（工具调用前后、压缩、子代理、轮次结束等）执行的本地 shell 命令，可通过 stdout 返回 JSON 决策来允许、拒绝或修改参数。此处配置会立即重新加载。',
        )}
      </p>
      <div className="settings-warn">
        {t('Hooks 会以你的用户权限执行任意命令。只填写你理解并信任的脚本；项目级 hooks 同样适用于当前工作区。')}
      </div>

      {view?.projectHooksPresent ? (
        view.projectTrusted ? (
          <div className="settings-note">
            {t('项目 hooks 已信任，当前正在生效。')}{' '}
            <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void setTrust(false)}>
              {busy === 'trust' ? t('处理中…') : t('撤销信任')}
            </button>
          </div>
        ) : (
          <div className="settings-warn">
            {t('此项目包含 hooks，但尚未被信任，因此不会执行。只有在你确认该工作区来源可信时才开启。')}
            <div className="settings-actions">
              <button className="btn" disabled={busy !== null} onClick={() => void setTrust(true)}>
                {busy === 'trust' ? t('处理中…') : t('信任此项目的 hooks')}
              </button>
            </div>
          </div>
        )
      ) : null}

      <div className="settings-section-title">{t('当前生效')}</div>
      {view && view.active.length === 0 ? <div className="settings-note">{t('当前没有生效的 hook。')}</div> : null}
      {view ? (
        <div className="hook-list">
          {view.active.map((hook, index) => (
            <div className="hook-row" key={`${hook.pluginId}:${hook.event}:${index}`}>
              <span className="hook-event">{hook.event}</span>
              <span className="hook-source">{hook.source}</span>
              <span className="hook-matcher">{hook.matcher ?? '*'}</span>
              <code className="hook-command">{hook.command}</code>
            </div>
          ))}
        </div>
      ) : null}
      {view && view.errors.length > 0 ? <div className="settings-warn">{view.errors.join('\n')}</div> : null}

      <div className="settings-section-title">{t('用户级 hooks.json')}</div>
      <p className="settings-note">{view?.paths.user}</p>
      <textarea
        className="settings-input settings-textarea settings-mono"
        rows={8}
        value={userDraft}
        placeholder={EMPTY_CONFIG}
        onChange={(event) => setUserDraft(event.target.value)}
      />
      <div className="settings-actions">
        <button className="btn" disabled={busy !== null} onClick={() => void save('user')}>
          {busy === 'user' ? t('保存中…') : t('保存用户级')}
        </button>
      </div>

      <div className="settings-section-title">{t('项目级 hooks.json')}</div>
      <p className="settings-note">{view?.paths.project}</p>
      <textarea
        className="settings-input settings-textarea settings-mono"
        rows={8}
        value={projectDraft}
        placeholder={EMPTY_CONFIG}
        onChange={(event) => setProjectDraft(event.target.value)}
      />
      <div className="settings-actions">
        <button className="btn" disabled={busy !== null} onClick={() => void save('project')}>
          {busy === 'project' ? t('保存中…') : t('保存项目级')}
        </button>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </>
  )
}
