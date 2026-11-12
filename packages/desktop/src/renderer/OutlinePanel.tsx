import { useMemo, useState } from 'react'
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

interface OutlineGroup {
  id: string
  question: OutlineEntry
  questionLabel: string
  answers: Array<{ entry: OutlineEntry; label: string }>
}

/** 对话大纲：按提问分组，回答默认折叠，便于在很长的会话里快速找到问题。 */
export function OutlinePanel({ entries, onJump }: OutlinePanelProps): JSX.Element {
  const { t } = useTranslation()
  const groups = useMemo(() => {
    let questions = 0
    let answers = 0
    const result: OutlineGroup[] = []
    let current: OutlineGroup | null = null
    for (const entry of entries) {
      if (entry.role !== 'user' && entry.role !== 'assistant') continue
      if (entry.role === 'user' || !current) {
        current = {
          id: entry.id,
          question: entry,
          questionLabel: t('提问 {{n}}', { n: ++questions }),
          answers: [],
        }
        result.push(current)
        continue
      }
      current.answers.push({ entry, label: t('回答 {{n}}', { n: ++answers }) })
    }
    return result
  }, [entries, t])

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const total = groups.reduce((count, group) => count + 1 + group.answers.length, 0)
  const allExpanded = groups.length > 0 && groups.every((group) => group.answers.length === 0 || expanded.has(group.id))

  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = (): void => {
    setExpanded(allExpanded ? new Set() : new Set(groups.map((group) => group.id)))
  }

  return (
    <div className="outline-panel" data-testid="outline-panel">
      <div className="outline-head">
        <span className="outline-title">{t('对话目录')}</span>
        <span className="outline-count">{t('共 {{count}} 条', { count: total })}</span>
        {groups.some((group) => group.answers.length > 0) ? (
          <button type="button" className="outline-toggle-all" data-testid="outline-toggle-all" onClick={toggleAll}>
            {allExpanded ? t('收起所有回答') : t('展开所有回答')}
          </button>
        ) : null}
      </div>
      {groups.length === 0 ? <div className="outline-empty">{t('当前会话还没有提问')}</div> : null}
      <div className="outline-list">
        {groups.map((group) => {
          const open = expanded.has(group.id)
          return (
            <div className="outline-group" key={group.id}>
              <div className="outline-row">
                <button
                  type="button"
                  className="outline-item user"
                  data-testid="outline-item"
                  data-outline-role="question"
                  title={summarize(group.question.text)}
                  onClick={() => onJump(group.question.id)}
                >
                  <span className="outline-role">{group.questionLabel}</span>
                  <span className="outline-text">{summarize(group.question.text)}</span>
                </button>
                {group.answers.length > 0 ? (
                  <button
                    type="button"
                    className="outline-toggle"
                    data-testid="outline-answer-toggle"
                    aria-expanded={open}
                    onClick={() => toggle(group.id)}
                  >
                    {open ? t('收起') : t('回答 {{count}}', { count: group.answers.length })}
                  </button>
                ) : null}
              </div>
              {open
                ? group.answers.map((answer) => (
                    <button
                      type="button"
                      className="outline-item assistant answer"
                      data-testid="outline-answer"
                      key={answer.entry.id}
                      title={summarize(answer.entry.text)}
                      onClick={() => onJump(answer.entry.id)}
                    >
                      <span className="outline-role">{answer.label}</span>
                      <span className="outline-text">{summarize(answer.entry.text)}</span>
                    </button>
                  ))
                : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
