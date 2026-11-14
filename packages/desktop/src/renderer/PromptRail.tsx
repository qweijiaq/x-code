import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Entry } from './transcript-model.js'

interface Props {
  entries: Entry[]
  scrollRef: React.RefObject<HTMLElement | null>
}

/** 对话右侧的提问刻度：每个提问一个点，点击跳回，滚动时高亮当前所在。 */
export function PromptRail({ entries, scrollRef }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const prompts = entries.filter((entry) => entry.role === 'user' && entry.text.trim())
  const [activeId, setActiveId] = useState<string | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || prompts.length === 0) return
    const update = (): void => {
      frame.current = null
      const top = node.getBoundingClientRect().top + 120
      let current: string | null = prompts[0]?.id ?? null
      for (const prompt of prompts) {
        const element = node.querySelector<HTMLElement>(`[data-entry-id="${prompt.id}"]`)
        if (!element) continue
        if (element.getBoundingClientRect().top <= top) current = prompt.id
      }
      setActiveId(current)
    }
    const onScroll = (): void => {
      if (frame.current !== null) return
      frame.current = window.requestAnimationFrame(update)
    }
    update()
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      node.removeEventListener('scroll', onScroll)
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    }
  }, [scrollRef, prompts])

  if (prompts.length < 2) return null

  const jump = (id: string): void => {
    const node = scrollRef.current
    const target = node?.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className="prompt-rail" role="navigation" aria-label={t('历史提问定位')} data-testid="prompt-rail">
      {prompts.map((prompt, index) => {
        const preview = prompt.text.replace(/\s+/g, ' ').trim().slice(0, 80)
        return (
          <button
            key={prompt.id}
            className={`prompt-tick${activeId === prompt.id ? ' is-active' : ''}`}
            style={{ top: `${((index + 0.5) / prompts.length) * 100}%` }}
            title={preview}
            aria-label={preview}
            onClick={() => jump(prompt.id)}
          />
        )
      })}
    </div>
  )
}
