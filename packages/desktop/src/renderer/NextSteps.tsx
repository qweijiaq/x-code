import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type NextStep, composeNextStepPrompt } from './next-steps.js'

interface Props {
  steps: NextStep[]
  onRun: (prompt: string, labels: string[]) => void
  onDismiss: () => void
}

/** 一轮结束后可勾选的下一步建议；默认不勾选，避免误触直接开跑。 */
export function NextSteps({ steps, onRun, onDismiss }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (steps.length === 0) return null

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = steps.filter((step) => selected.has(step.id))
  const allSelected = chosen.length === steps.length

  return (
    <section className="next-steps" data-testid="next-steps">
      <div className="next-steps-head">
        <span className="next-steps-title">{t('下一步')}</span>
        <button
          className="next-steps-link"
          onClick={() => setSelected(allSelected ? new Set() : new Set(steps.map((step) => step.id)))}
        >
          {allSelected ? t('全不选') : t('全选')}
        </button>
        <span className="spacer" />
        <button
          className="next-steps-link"
          title={t('不再显示建议')}
          aria-label={t('不再显示建议')}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <div className="next-steps-list">
        {steps.map((step) => (
          <label key={step.id} className={`next-step${selected.has(step.id) ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={selected.has(step.id)} onChange={() => toggle(step.id)} />
            <span>{t(step.label)}</span>
          </label>
        ))}
      </div>
      <div className="next-steps-actions">
        <button
          className="btn solid"
          disabled={chosen.length === 0}
          onClick={() =>
            onRun(
              composeNextStepPrompt(chosen),
              chosen.map((step) => step.label),
            )
          }
        >
          {chosen.length > 1 ? t('执行所选 {{count}} 项', { count: chosen.length }) : t('执行所选')}
        </button>
      </div>
    </section>
  )
}
