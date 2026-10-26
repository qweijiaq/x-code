import { useMemo } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'

export interface OutlineEntry {
  id: string
  role: string
  text: string
}

interface OutlinePanelProps {
  entries: OutlineEntry[]
  onJump(id: string): void
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return '…'
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat
}

/** Conversation outline: a compact list of each question and answer with a
 *  jump target. Rebuilt only when the transcript entries change. */
export function OutlinePanel({ entries, onJump }: OutlinePanelProps): JSX.Element {
  const { t } = useTranslation()
  const items = useMemo(() => {
    let questions = 0
    let answers = 0
    return entries
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => {
        const role = entry.role === 'user' ? 'user' : 'assistant'
        const label = entry.role === 'user' ? t('提问 {{n}}', { n: ++questions }) : t('回答 {{n}}', { n: ++answers })
        return { ...entry, role, label, summary: summarize(entry.text) }
      })
  }, [entries, t])

  return (
    <div className="outline-panel" data-testid="outline-panel">
      <div className="outline-head">
        <span className="outline-title">{t('对话目录')}</span>
        <span className="outline-count">{t('共 {{count}} 条', { count: items.length })}</span>
      </div>
      {items.length === 0 ? <div className="outline-empty">{t('当前会话还没有提问')}</div> : null}
      <div className="outline-list">
        {items.map((item) => (
          <button
            type="button"
            className={`outline-item ${item.role}`}
            data-testid="outline-item"
            key={item.id}
            title={item.summary}
            onClick={() => onJump(item.id)}
          >
            <span className="outline-role">{item.label}</span>
            <span className="outline-text">{item.summary}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
