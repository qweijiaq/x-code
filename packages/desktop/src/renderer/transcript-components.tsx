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
    // 状态里带上文件路径。只存 src 时，同一个组件实例被复用（列表 key 用
    // `${name}-${index}` 或 index，name/index 不变而 path 变了）就会命中
    // 「已有 src」的早退分支，界面一直显示上一张图。
    const [loaded, setLoaded] = useState<{ file: string; src?: string; failed?: boolean } | null>(() => {
      const cached = imagePreviewCache.get(file)
      return cached ? { file, src: cached } : null
    })
    const current = loaded && loaded.file === file ? loaded : null
    const src = current?.src ?? null
    const failed = current?.failed === true
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
            setLoaded({ file, failed: true })
            return
          }
          const dataUrl = (response.result as { dataUrl: string }).dataUrl
          imagePreviewCache.set(file, dataUrl)
          setLoaded({ file, src: dataUrl })
        })
        .catch(() => {
          if (!cancelled) setLoaded({ file, failed: true })
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
  // `onOpen` 必须参与比较：调用点既传稳定的 `onOpenImage`，也传内联箭头函数。
  // 漏掉它时，点击缩略图会执行捕获了旧 state/ref 的旧闭包（打开到错误的预览态）。
  (prev, next) => prev.file === next.file && prev.variant === next.variant && prev.onOpen === next.onOpen,
)

/** diff 行前缀 → 渲染样式。`isCreate` 时 `content` 是文件原文而不是 diff 行：
 *  原文里以 `-` 开头的 Markdown 列表、以 `+` 开头的字符串会被误标成 del/add，
 *  所以整段按新增渲染（也与「新建文件全是 +」的统计口径一致）。 */
function diffLineSigil(line: string, isCreate: boolean): 'add' | 'del' | 'ctx' {
  if (isCreate) return 'add'
  if (line[0] === '+') return 'add'
  if (line[0] === '-') return 'del'
  return 'ctx'
}

export function DiffView({
  diff,
  reverted,
  expanded,
  onRevert,
  onOpenEditor,
}: {
  diff: FileEditView
  reverted?: boolean
  expanded?: boolean
  onRevert?: () => void
  onOpenEditor?: (path: string, line?: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 默认只给几行预览：一次编辑可能长达几十行，整段铺开会把对话挤出屏幕。
  // 局部展开/收起覆盖模式默认值；模式切换后自动回到默认。
  const baseOpen = expanded === true
  const [override, setOverride] = useState<{ base: boolean; open: boolean } | null>(null)
  const open = override && override.base === baseOpen ? override.open : baseOpen
  const setOpen = (next: boolean): void => setOverride({ base: baseOpen, open: next })
  const allLines = diff.isCreate && diff.content ? diff.content.split('\n') : diff.hunks.flatMap((hunk) => hunk.lines)
  // 折叠时只给 4 行预览；展开时渲染全部内容。过去展开被硬截断在 80 行，按钮却按
  // `lines.length - preview.length` 报数——"展开剩余 76 行"点开后 80 行之后的
  // 内容被永久丢弃且没有任何提示。
  const preview = allLines.slice(0, 4)
  const hidden = allLines.length - preview.length
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
        <button type="button" className="diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('收起') : t('展开')}
        </button>
        {onRevert && !reverted ? (
          <button className="session-action" onClick={onRevert}>
            {t('回退这次编辑')}
          </button>
        ) : null}
      </div>
      <div className={`diff-body ${open ? 'open' : 'collapsed'}`}>
        {(open ? allLines : preview).map((line, index) => (
          <div key={index} className={`diff-line ${diffLineSigil(line, diff.isCreate === true)}`}>
            {line}
          </div>
        ))}
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
  const [openError, setOpenError] = useState<string | null>(null)
  const urls = extractSourceUrls(text)
  if (urls.length === 0) return null
  // 与开放外部链接的其他调用点一致：IPC 可能 reject，返回值也可能 `ok: false`。
  // 不接住的话，用户点了来源标签什么都不会发生（还有一条 unhandled rejection）。
  const openExternal = (url: string): void => {
    void window.xcode
      .request({ id: crypto.randomUUID(), method: 'app:open-external', params: { url } })
      .then((response) => setOpenError(response.ok ? null : response.error.message))
      .catch((error: unknown) => setOpenError(error instanceof Error ? error.message : String(error)))
  }
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
          <button key={url} type="button" className="source-chip" title={url} onClick={() => openExternal(url)}>
            {label}
          </button>
        )
      })}
      {openError ? (
        <span className="tool-sources-error" title={openError}>
          {t('失败')}
        </span>
      ) : null}
    </div>
  )
})

export const SubAgentBlock = memo(function SubAgentBlock({
  agent,
  expanded,
}: {
  agent: SubAgentView
  expanded?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const baseOpen = expanded === true
  const [override, setOverride] = useState<{ base: boolean; open: boolean } | null>(null)
  const open = override && override.base === baseOpen ? override.open : baseOpen
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
      <button className="subagent-head" onClick={() => setOverride({ base: baseOpen, open: !open })}>
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
