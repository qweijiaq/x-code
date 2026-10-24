import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import enManual from '../../../../docs/desktop-manual.en.md?raw'
import zhManual from '../../../../docs/desktop-manual.md?raw'
import { MarkdownView } from './MarkdownView.js'
import i18n from './i18n.js'

interface Section {
  id: string
  title: string
  body: string
}

interface ManualPanelProps {
  onClose(): void
}

const shots = import.meta.glob('./manual-assets/*.{png,jpg,jpeg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function shotUrl(name: string): string {
  const match = Object.entries(shots).find(([file]) => file.endsWith(`/${name}.png`) || file.endsWith(`/${name}.jpg`))
  return match?.[1] ?? ''
}

function withShots(markdown: string): string {
  return markdown.replace(/\(shot:([a-z0-9-]+)\)/g, (_match, name: string) => {
    const url = shotUrl(name)
    return url ? `(${url})` : '()'
  })
}

function parseManual(markdown: string): { title: string; sections: Section[] } {
  const lines = markdown.split('\n')
  const title =
    lines
      .find((line) => line.startsWith('# '))
      ?.slice(2)
      .trim() ?? ''
  const sections: Section[] = []
  let current: Section | null = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current)
      const heading = line.slice(3).trim()
      current = { id: `section-${sections.length}`, title: heading, body: '' }
      continue
    }
    if (!current || line.startsWith('# ')) continue
    current.body += `${line}\n`
  }
  if (current) sections.push(current)
  return { title, sections }
}

export function ManualPanel({ onClose }: ManualPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const english = i18n.language === 'en'
  const { title, sections } = useMemo(() => parseManual(english ? enManual : zhManual), [english])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '')
  const contentRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sections
    return sections.filter(
      (section) => section.title.toLowerCase().includes(needle) || section.body.toLowerCase().includes(needle),
    )
  }, [query, sections])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const timer = setTimeout(() => searchRef.current?.focus(), 30)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      clearTimeout(timer)
    }
  }, [onClose])

  const active = filtered.find((section) => section.id === activeId) ?? filtered[0]

  const selectSection = (id: string): void => {
    setActiveId(id)
    contentRef.current?.scrollTo({ top: 0 })
  }

  return (
    <div className="manual-scrim" onClick={onClose}>
      <div
        className="manual-card"
        data-testid="manual-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('用户手册')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="manual-head">
          <div className="manual-heading">
            <span className="manual-title">{t('用户手册')}</span>
            <span className="manual-sub">{title}</span>
          </div>
          <input
            ref={searchRef}
            className="settings-input manual-search"
            data-testid="manual-search"
            value={query}
            placeholder={t('搜索手册')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="manual-count">{t('共 {{count}} 章', { count: filtered.length })}</span>
          <button className="btn btn-quiet" onClick={onClose} title={t('关闭')} aria-label={t('关闭')}>
            ×
          </button>
        </header>
        <div className="manual-layout">
          <nav className="manual-toc" aria-label={t('手册目录')}>
            {filtered.map((section) => (
              <button
                key={section.id}
                className={`manual-toc-item ${section.id === active?.id ? 'active' : ''}`}
                data-testid="manual-toc-item"
                onClick={() => selectSection(section.id)}
              >
                {section.title}
              </button>
            ))}
            {filtered.length === 0 ? <div className="settings-empty">{t('没有匹配的章节')}</div> : null}
          </nav>
          <div className="manual-content" ref={contentRef}>
            {active ? <MarkdownView text={withShots(`## ${active.title}\n\n${active.body}`)} /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
