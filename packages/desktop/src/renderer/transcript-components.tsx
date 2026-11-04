// @x-code-cli/desktop — transcript 内的独立展示组件
//
// 这些组件只依赖 props 和 window.xcode，不读取 App 的本地状态；抽出后
// App.tsx 不再需要为每个 diff/来源/子代理块维护 JSX 片段。
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { FileEditView, SubAgentView } from '../shared/protocol.js'
import { attachmentName, extractSourceUrls } from './transcript-model.js'

// 以文件路径为键缓存 data URL；组件被卸载后仍可立即重开同一张图。
const imagePreviewCache = new Map<string, string>()

export const AttachmentImage = memo(
  function AttachmentImage({
    file,
    variant,
    onOpen,
  }: {
    file: string
    variant: 'chip' | 'message'
    onOpen: (src: string, name: string) => void
  }): React.JSX.Element {
    const [src, setSrc] = useState<string | null>(() => imagePreviewCache.get(file) ?? null)
    const [failed, setFailed] = useState(false)
    const name = attachmentName(file)
    useEffect(() => {
      if (src || failed) return
      let cancelled = false
      void window.xcode
        .request({
          id: crypto.randomUUID(),
          method: 'app:image-preview',
          params: { path: file },
        })
        .then((response) => {
          if (cancelled) return
          if (!response.ok) {
            setFailed(true)
            return
          }
          const dataUrl = (response.result as { dataUrl: string }).dataUrl
          imagePreviewCache.set(file, dataUrl)
          setSrc(dataUrl)
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
      return () => {
        cancelled = true
      }
    }, [file, src, failed])
    if (failed) {
      return <span className="attachment-image-fallback">{name}</span>
    }
    if (!src) {
      return <span className={`attachment-image-loading ${variant}`} aria-label={name} />
    }
    if (variant === 'chip') {
      return (
        <button type="button" className="attachment-thumb-button" title={name} onClick={() => onOpen(src, name)}>
          <img className="attachment-thumb" src={src} alt={name} loading="lazy" />
        </button>
      )
    }
    return (
      <button type="button" className="message-attachment" title={name} onClick={() => onOpen(src, name)}>
        <img src={src} alt={name} loading="lazy" />
        <span>{name}</span>
      </button>
    )
  },
  (prev, next) => prev.file === next.file && prev.variant === next.variant,
)

export function DiffView({
  diff,
  reverted,
  onRevert,
  onOpenEditor,
}: {
  diff: FileEditView
  reverted?: boolean
  onRevert?: () => void
  onOpenEditor?: (path: string, line?: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 默认只给几行预览：一次编辑可能长达几十行，整段铺开会把对话挤出屏幕。
  const [open, setOpen] = useState(false)
  const allLines = diff.isCreate && diff.content ? diff.content.split('\n') : diff.hunks.flatMap((hunk) => hunk.lines)
  const lines = allLines.slice(0, 80)
  const preview = lines.slice(0, 4)
  const hidden = lines.length - preview.length
  return (
    <div className="diff">
      <div className="diff-head">
        <button
          type="button"
          className="diff-path diff-path-button"
          title={t('在编辑器中打开')}
          onClick={() => onOpenEditor?.(diff.filePath, diff.hunks[0]?.newStart ?? 1)}
        >
          {diff.filePath}
        </button>
        <span className="diff-counts">
          +{diff.additions} −{diff.removals}
        </span>
        {reverted ? <span className="diff-reverted">{t('已回退')}</span> : null}
        <button type="button" className="diff-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? t('收起') : t('展开')}
        </button>
        {onRevert && !reverted ? (
          <button className="session-action" onClick={onRevert}>
            {t('回退这次编辑')}
          </button>
        ) : null}
      </div>
      <div className={`diff-body ${open ? 'open' : 'collapsed'}`}>
        {(open ? lines : preview).map((line, index) => {
          const sigil = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
          return (
            <div key={index} className={`diff-line ${sigil}`}>
              {line}
            </div>
          )
        })}
      </div>
      {!open && hidden > 0 ? (
        <button type="button" className="diff-more" onClick={() => setOpen(true)}>
          {t('展开剩余 {{count}} 行', { count: hidden })}
        </button>
      ) : null}
    </div>
  )
}

export const SourceList = memo(function SourceList({ text }: { text: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const urls = extractSourceUrls(text)
  if (urls.length === 0) return null
  return (
    <div className="tool-sources" data-testid="tool-sources">
      <span className="tool-sources-label">{t('来源')}</span>
      {urls.map((url) => {
        let label = url
        try {
          const parsed = new URL(url)
          label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 48)
        } catch {
          // 保留原始 URL。
        }
        return (
          <button
            key={url}
            className="source-chip"
            title={url}
            onClick={() =>
              void window.xcode.request({
                id: crypto.randomUUID(),
                method: 'app:open-external',
                params: { url },
              })
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
})

export const SubAgentBlock = memo(function SubAgentBlock({ agent }: { agent: SubAgentView }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const statusLabel =
    agent.status === 'running'
      ? t('运行中')
      : agent.status === 'completed'
        ? t('已完成')
        : agent.status === 'aborted'
          ? t('已中止')
          : t('失败')
  return (
    <div className="subagent" data-testid="subagent">
      <button className="subagent-head" onClick={() => setOpen((value) => !value)}>
        <span className="subagent-name">{agent.agentName}</span>
        <span className={`subagent-status ${agent.status}`}>{statusLabel}</span>
        <span className="subagent-meta">
          {agent.turnCount !== undefined ? t('{{count}} 轮', { count: agent.turnCount }) : ''}
          {agent.durationMs !== undefined ? ` · ${(agent.durationMs / 1000).toFixed(1)}s` : ''}
        </span>
        <span className="spacer" />
        <span className="subagent-toggle">{open ? t('收起') : t('展开')}</span>
      </button>
      {agent.description ? <div className="subagent-desc">{agent.description}</div> : null}
      {open ? (
        <div className="subagent-log">
          {agent.log.map((line, index) => (
            <div key={index} className={`subagent-line ${line.kind}`}>
              {line.text}
            </div>
          ))}
          {agent.finalText ? <div className="subagent-final">{agent.finalText}</div> : null}
          {agent.log.length === 0 && !agent.finalText ? (
            <div className="subagent-line text">{t('等待子代理输出…')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
