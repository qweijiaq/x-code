import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ProjectTrustView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

interface Props {
  onNotice: (message: string | null) => void
}

/** 项目信任中心：把 hooks 与 MCP 的项目级信任放在同一处查看和切换。
 *  用户级配置不受影响，撤销信任只影响下一次加载。 */
export function TrustSettings({ onNotice }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<ProjectTrustView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const response = await request('project:trust-view', {})
      if (response.ok) setView(response.result as ProjectTrustView)
      else setError(response.error.message)
    })()
  }, [])

  const setTrust = async (scope: 'hooks' | 'mcp', trusted: boolean): Promise<void> => {
    const key = `${scope}:${trusted ? 'trust' : 'revoke'}`
    setBusy(key)
    setError(null)
    onNotice(null)
    try {
      const response = await request('project:trust-set', { scope, trusted })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setView(response.result as ProjectTrustView)
      onNotice(trusted ? t('已信任该项目。') : t('已撤销项目信任。'))
    } finally {
      setBusy(null)
    }
  }

  if (!view) {
    return <div className="settings-note">{error ?? t('加载中…')}</div>
  }

  const hooksAction = view.hooks.present && !view.hooks.trusted
  const mcpAction = view.mcp.servers.length > 0 && !view.mcp.trusted
  const bothTrusted = (!view.hooks.present || view.hooks.trusted) && (view.mcp.servers.length === 0 || view.mcp.trusted)
  const anyTrusted = view.hooks.trusted || view.mcp.trusted

  return (
    <>
      <div className="settings-section-title">{t('项目信任')}</div>
      <p className="settings-note">
        {t(
          '项目级 Hooks 和 MCP 配置会在本机执行命令。这里集中查看它们是否被信任；用户级配置不受影响，撤销信任只影响下一次加载。',
        )}
      </p>
      <p className="settings-note">{view.workspace}</p>

      <div className="settings-section-title">{t('Hooks')}</div>
      <div className="settings-note">
        {view.hooks.present
          ? t('项目 hooks：{{count}} 个生效；{{status}}', {
              count: view.hooks.count,
              status: view.hooks.trusted ? t('已信任') : t('未信任'),
            })
          : t('此项目没有项目级 hooks。')}
      </div>
      {hooksAction ? (
        <div className="settings-actions">
          <button className="btn" disabled={busy !== null} onClick={() => void setTrust('hooks', true)}>
            {busy === 'hooks:trust' ? t('处理中…') : t('信任项目 hooks')}
          </button>
        </div>
      ) : null}
      {view.hooks.trusted ? (
        <div className="settings-actions">
          <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void setTrust('hooks', false)}>
            {t('撤销 hooks 信任')}
          </button>
        </div>
      ) : null}

      <div className="settings-section-title">{t('MCP')}</div>
      {view.mcp.servers.length === 0 ? (
        <div className="settings-note">{t('此项目没有项目级 MCP 服务器。')}</div>
      ) : (
        <>
          <div className="settings-note">
            {t('项目 MCP：{{count}} 个服务器；{{status}}', {
              count: view.mcp.servers.length,
              status: view.mcp.trusted ? t('已信任') : t('未信任'),
            })}
          </div>
          <div className="hook-list">
            {view.mcp.servers.map((server) => (
              <div className="hook-row" key={server.name}>
                <span className="hook-event">{server.name}</span>
                <code className="hook-command">{server.preview}</code>
              </div>
            ))}
          </div>
          {mcpAction ? (
            <div className="settings-actions">
              <button className="btn" disabled={busy !== null} onClick={() => void setTrust('mcp', true)}>
                {busy === 'mcp:trust' ? t('处理中…') : t('信任项目 MCP')}
              </button>
            </div>
          ) : null}
          {view.mcp.trusted ? (
            <div className="settings-actions">
              <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void setTrust('mcp', false)}>
                {t('撤销 MCP 信任')}
              </button>
            </div>
          ) : null}
        </>
      )}

      <div className="settings-section-title">{t('全部')}</div>
      <div className="settings-actions">
        <button
          className="btn solid"
          disabled={busy !== null || bothTrusted}
          onClick={() => {
            void (async () => {
              if (view.hooks.present && !view.hooks.trusted) await setTrust('hooks', true)
              if (view.mcp.servers.length > 0 && !view.mcp.trusted) await setTrust('mcp', true)
            })()
          }}
        >
          {t('信任所有项目配置')}
        </button>
        <button
          className="btn"
          disabled={busy !== null || !anyTrusted}
          onClick={() => {
            void (async () => {
              if (view.hooks.trusted) await setTrust('hooks', false)
              if (view.mcp.trusted) await setTrust('mcp', false)
            })()
          }}
        >
          {t('撤销所有项目信任')}
        </button>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </>
  )
}
