import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { UsageKey } from './preferences.js'

interface UsageChecklistProps {
  progress: Record<UsageKey, boolean>
  open: boolean
  onToggle(): void
  onDismiss(): void
  onRun(key: UsageKey): void
}

const KEYS: UsageKey[] = ['attach', 'screenshot', 'document', 'palette', 'skill']

export function UsageChecklist({ progress, open, onToggle, onDismiss, onRun }: UsageChecklistProps): React.JSX.Element {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) onToggle()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onToggle])

  const done = KEYS.filter((key) => progress[key]).length
  const labels: Record<UsageKey, string> = {
    attach: t('附加一个文件或图片'),
    screenshot: t('截一张图'),
    document: t('打开文档面板'),
    palette: t('用 {{key}} 搜索能力', {
      key: window.xcode.platform === 'darwin' ? '⌘K' : 'Ctrl+K',
    }),
    skill: t('从技能市场安装技能'),
  }
  const items = KEYS.map((key) => ({ key, label: labels[key] }))

  return (
    <div ref={rootRef} className={`usage-footer${open ? ' open' : ''}`} data-testid="usage-checklist">
      {open ? (
        <div className="usage-popover" role="dialog" aria-label={t('上手清单')} data-testid="usage-popover">
          <div className="usage-popover-head">
            <span className="usage-popover-title">{t('上手清单')}</span>
            <span className="usage-progress">
              {done}/{KEYS.length}
            </span>
            <span className="spacer" />
            <button
              className="usage-dismiss"
              data-testid="usage-dismiss"
              title={t('不再显示')}
              aria-label={t('不再显示')}
              onClick={onDismiss}
            >
              ×
            </button>
          </div>
          <div className="usage-list">
            {items.map((item) => (
              <button
                key={item.key}
                className={`usage-item ${progress[item.key] ? 'done' : ''}`}
                data-testid={`usage-item-${item.key}`}
                onClick={() => onRun(item.key)}
              >
                <span className="usage-check" aria-hidden="true">
                  {progress[item.key] ? '✓' : '○'}
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="usage-bar" data-testid="usage-bar" aria-expanded={open} onClick={onToggle}>
        <span className="usage-bar-label">{t('上手清单')}</span>
        <span className="usage-bar-progress">
          {done}/{KEYS.length}
        </span>
        <span className={`usage-bar-caret ${open ? 'open' : ''}`} aria-hidden="true">
          ▴
        </span>
      </button>
    </div>
  )
}
