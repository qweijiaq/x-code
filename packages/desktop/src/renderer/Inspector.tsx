import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type InspectorTab = 'outline' | 'document' | 'git' | 'checks' | 'terminal' | 'file'

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'outline', label: '目录' },
  { id: 'document', label: '文档' },
  { id: 'git', label: 'Git' },
  { id: 'checks', label: '检查' },
  { id: 'terminal', label: '终端' },
  { id: 'file', label: '文件' },
]

const WIDTH_KEY = 'xcode.inspectorWidth'
const MIN_WIDTH = 360
const MAX_WIDTH = 900

interface InspectorProps {
  tab: InspectorTab
  onTab(tab: InspectorTab): void
  onClose(): void
  children: React.ReactNode
}

export function Inspector({ tab, onTab, onClose, children }: InspectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY))
      if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) return stored
    } catch {
      // 回落到默认宽度。
    }
    return 560
  })
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveTab = (delta: number): void => {
    const index = TABS.findIndex((item) => item.id === tab)
    const next = (index + delta + TABS.length) % TABS.length
    const item = TABS[next]
    if (!item) return
    onTab(item.id)
    setTimeout(() => tabRefs.current[next]?.focus(), 0)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    const move = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 360))
      const next = Math.max(MIN_WIDTH, Math.min(max, drag.startWidth + (drag.startX - moveEvent.clientX)))
      setWidth(next)
    }
    const stop = (): void => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setWidth((current) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(current)))
        } catch {
          // 宽度持久化只是便利功能。
        }
        return current
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <aside className="inspector" data-testid="inspector" style={{ width }}>
      <div
        className="inspector-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整侧栏宽度')}
        onPointerDown={startResize}
      />
      <header className="inspector-head">
        <div className="inspector-tabs" role="tablist">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              className={`inspector-tab ${item.id === tab ? 'active' : ''}`}
              data-testid={`inspector-tab-${item.id}`}
              role="tab"
              aria-selected={item.id === tab}
              aria-controls={`inspector-panel-${item.id}`}
              tabIndex={item.id === tab ? 0 : -1}
              onClick={() => onTab(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  moveTab(1)
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  moveTab(-1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  onTab(TABS[0]!.id)
                  setTimeout(() => tabRefs.current[0]?.focus(), 0)
                } else if (event.key === 'End') {
                  event.preventDefault()
                  const last = TABS.length - 1
                  onTab(TABS[last]!.id)
                  setTimeout(() => tabRefs.current[last]?.focus(), 0)
                }
              }}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <button
          className="btn btn-quiet inspector-close"
          data-testid="inspector-close"
          title={t('关闭')}
          aria-label={t('关闭')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div
        className="inspector-body"
        role="tabpanel"
        id={`inspector-panel-${tab}`}
        aria-label={t(TABS.find((item) => item.id === tab)?.label ?? '')}
      >
        {children}
      </div>
    </aside>
  )
}
