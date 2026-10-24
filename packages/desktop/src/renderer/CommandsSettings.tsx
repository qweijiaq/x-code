import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  CustomCommandView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const EMPTY_FORM = { name: '', description: '', body: '', scope: 'user' as 'user' | 'project' }

export function CommandsSettings({ onNotice }: { onNotice: (message: string | null) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [commands, setCommands] = useState<CustomCommandView[]>([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const response = await request('commands:list', {})
    if (response.ok) setCommands((response.result as { commands: CustomCommandView[] }).commands)
    else setError(response.error.message)
  }

  useEffect(() => {
    void load()
  }, [])

  const edit = async (command: CustomCommandView): Promise<void> => {
    if (command.source === 'plugin') return
    const response = await request('commands:detail', { name: command.name })
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const detail = response.result as { name: string; description: string; body: string; source: 'user' | 'project' }
    setEditing(detail.name)
    setForm({
      name: detail.name,
      description: detail.description,
      body: detail.body,
      scope: detail.source === 'project' ? 'project' : 'user',
    })
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setError(null)
    onNotice(null)
    try {
      const response = await request('commands:save', {
        name: form.name,
        description: form.description,
        body: form.body,
        scope: form.scope,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setCommands((response.result as { commands: CustomCommandView[] }).commands)
      setEditing(form.name.trim())
      onNotice(t('已保存 /{{name}}。下一轮对话即可在 / 菜单中使用。', { name: form.name.trim() }))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (name: string, scope: 'user' | 'project'): Promise<void> => {
    setBusy(`delete:${name}`)
    setError(null)
    try {
      const response = await request('commands:delete', { name, scope })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setCommands((response.result as { commands: CustomCommandView[] }).commands)
      if (editing === name) {
        setEditing(null)
        setForm(EMPTY_FORM)
      }
      setDeleting(null)
      onNotice(t('已删除 /{{name}}。', { name }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="settings-section-title">{t('自定义命令')}</div>
      <p className="settings-note">
        {t(
          '在 ~/.x-code/commands/ 或项目的 .x-code/commands/ 下放置 Markdown 文件即可新增斜杠命令。$ARGUMENTS 会替换为你输入在命令名后的文字；${CLAUDE_PLUGIN_ROOT} 仅在插件命令中可用。',
        )}
      </p>

      <div className="command-list">
        {commands.length === 0 ? <div className="settings-note">{t('暂无自定义命令。')}</div> : null}
        {commands.map((command) => (
          <div className={`command-row ${editing === command.name ? 'active' : ''}`} key={command.name}>
            <div className="command-main">
              <span className="command-name">/{command.name}</span>
              <span className="command-desc">{command.description || t('（无描述）')}</span>
            </div>
            <span className={`command-source ${command.source}`}>
              {command.source === 'user' ? t('用户') : command.source === 'project' ? t('项目') : t('插件')}
              {command.pluginId ? ` · ${command.pluginId}` : ''}
            </span>
            {command.source !== 'plugin' ? (
              <>
                <button className="btn btn-quiet" onClick={() => void edit(command)} disabled={busy !== null}>
                  {t('编辑')}
                </button>
                {deleting === command.name ? (
                  <button
                    className="btn btn-quiet danger"
                    disabled={busy !== null}
                    onClick={() => void remove(command.name, command.source as 'user' | 'project')}
                  >
                    {t('确认删除')}
                  </button>
                ) : (
                  <button className="btn btn-quiet" onClick={() => setDeleting(command.name)} disabled={busy !== null}>
                    {t('删除')}
                  </button>
                )}
              </>
            ) : null}
          </div>
        ))}
      </div>

      <div className="settings-section-title">{editing ? t('编辑 /{{name}}', { name: editing }) : t('新建命令')}</div>
      <div className="settings-form">
        <div className="settings-actions">
          <input
            className="settings-input"
            placeholder={t('命令名（不含斜杠，如 review-doc）')}
            value={form.name}
            disabled={editing !== null}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
          <input
            className="settings-input"
            placeholder={t('一句话描述')}
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
          <div className="settings-segments">
            {(['user', 'project'] as const).map((scope) => (
              <button
                key={scope}
                className={`settings-tab-inline ${form.scope === scope ? 'active' : ''}`}
                onClick={() => setForm((prev) => ({ ...prev, scope }))}
              >
                {scope === 'user' ? t('用户级') : t('项目级')}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="settings-input settings-textarea settings-mono"
          rows={10}
          placeholder={t('提示词模板，例如：\n请审查 $ARGUMENTS 中的改动，列出风险与缺失测试。')}
          value={form.body}
          onChange={(event) => setForm((prev) => ({ ...prev, body: event.target.value }))}
        />
        <div className="settings-actions">
          <button
            className="btn btn-quiet"
            onClick={() => {
              setEditing(null)
              setForm(EMPTY_FORM)
              setDeleting(null)
            }}
          >
            {t('清空')}
          </button>
          <button
            className="btn"
            disabled={busy !== null || !form.name.trim() || !form.body.trim()}
            onClick={() => void save()}
          >
            {busy === 'save' ? t('保存中…') : t('保存命令')}
          </button>
        </div>
        {error ? <div className="settings-warn">{error}</div> : null}
      </div>
    </>
  )
}
