// @x-code-cli/desktop — composer 的展示条
//
// 输入框本身仍留在 App（IME、mention、快捷键都依赖它的 ref 和局部状态），
// 这里只拆出围绕输入框的纯展示块：palette、编辑徽标、后台提示、队列、录音、
// 附件和 Markdown 工具栏。组件全部通过 props 驱动。
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkspaceFileItem } from '../shared/protocol.js'
import { MarkdownView } from './MarkdownView.js'
import { isImageAttachment } from './media.js'
import type { SlashCommand } from './slash-commands.js'
import { AttachmentImage } from './transcript-components.js'
import { formatDuration } from './transcript-model.js'

export function MentionPalette({
  items,
  index,
  onPick,
}: {
  items: WorkspaceFileItem[]
  index: number
  onPick: (file: WorkspaceFileItem) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="slash-palette mention-palette" data-testid="mention-palette">
      {items.map((file, itemIndex) => (
        <button
          key={file.path}
          className={`slash-item ${itemIndex === index ? 'active' : ''}`}
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(file)
          }}
        >
          <span className="slash-name">
            {file.relative}
            {file.isDirectory ? '/' : ''}
          </span>
          <span className="slash-desc">{file.isDirectory ? t('目录') : ''}</span>
        </button>
      ))}
    </div>
  )
}

export function SlashPalette({
  commands,
  index,
  paletteRef,
  onRun,
}: {
  commands: SlashCommand[]
  index: number
  paletteRef: RefObject<HTMLDivElement | null>
  onRun: (command: SlashCommand) => void
}): React.JSX.Element {
  return (
    <div className="slash-palette" data-testid="slash-palette" ref={paletteRef}>
      {commands.map((command, commandIndex) => (
        <button
          key={command.name}
          className={`slash-item ${commandIndex === index ? 'active' : ''}`}
          onMouseDown={(event) => {
            event.preventDefault()
            onRun(command)
          }}
        >
          <span className="slash-name">{command.name}</span>
          <span className="slash-desc">{command.description}</span>
        </button>
      ))}
    </div>
  )
}

export function EditBadge({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="edit-badge" data-testid="edit-badge">
      <span>{t('编辑模式：发送后将重写上一轮，文件改动会保留')}</span>
      <button className="attachment-remove" title={t('取消')} onClick={onCancel}>
        ×
      </button>
    </div>
  )
}

export function BackgroundWait({
  count,
  queued,
  onStop,
}: {
  count: number
  queued: number
  onStop: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="background-wait" data-testid="background-wait">
      <span>{t('{{count}} 个后台任务运行中；当前回复仍在等待。', { count })}</span>
      <button className="btn btn-quiet" onClick={onStop}>
        {queued > 0 ? t('停止等待并执行排队') : t('停止等待')}
      </button>
    </div>
  )
}

export function BackgroundIdle({ count, onOpen }: { count: number; onOpen: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="background-wait idle" data-testid="background-idle">
      <span>{t('{{count}} 个后台任务运行中，可以继续提问；完成后会通知。', { count })}</span>
      <button className="btn btn-quiet" onClick={onOpen}>
        {t('查看')}
      </button>
    </div>
  )
}

export function QueuedList({
  items,
  onOpenInNewWindow,
  onRemove,
}: {
  items: Array<{ prompt: string; attachments: string[] }>
  onOpenInNewWindow: (index: number) => void
  onRemove: (index: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="queued-list" data-testid="queued-list">
      {items.map((item, index) => (
        <div className="queued-item" key={`${index}-${item.prompt.slice(0, 24)}`}>
          <span className="queued-text">{item.prompt}</span>
          {item.attachments.length === 0 ? (
            <button
              className="queued-background"
              title={t('在新窗口另开任务，使用 fork 时的状态快照，不共享实时进度')}
              onClick={() => onOpenInNewWindow(index)}
            >
              {t('在新窗口另开')}
            </button>
          ) : null}
          <button className="attachment-remove" title={t('移出队列')} onClick={() => onRemove(index)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export function RecordingBar({
  recording,
  voiceBusy,
  seconds,
  level,
  onCancel,
  onFinish,
}: {
  recording: boolean
  voiceBusy: boolean
  seconds: number
  level: number
  onCancel: () => void
  onFinish: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={`recording-bar ${voiceBusy ? 'busy' : ''}`} data-testid="recording-bar">
      <span className="recording-dot" aria-hidden="true" />
      <span className="recording-time">{formatDuration(seconds)}</span>
      {recording ? (
        <span className="recording-level" aria-hidden="true">
          <span style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      ) : null}
      <span className="recording-hint">{voiceBusy ? t('正在转写…') : t('正在录音…')}</span>
      <span className="spacer" />
      {recording ? (
        <>
          <button className="btn btn-quiet" onClick={onCancel}>
            {t('取消')}
          </button>
          <button className="btn" onClick={onFinish}>
            {t('完成并转写')}
          </button>
        </>
      ) : null}
    </div>
  )
}

export function AttachmentsStrip({
  files,
  onRemove,
  onOpenImage,
}: {
  files: string[]
  onRemove: (file: string) => void
  onOpenImage: (src: string, name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="composer-attachments" data-testid="attachments" hidden={files.length === 0}>
      {files.map((file) => (
        <span className="attachment-chip" key={file} title={file}>
          {isImageAttachment(file) ? <AttachmentImage file={file} variant="chip" onOpen={onOpenImage} /> : null}
          <span className="attachment-name">{file.split(/[\\/]/).pop() ?? file}</span>
          <button className="attachment-remove" title={t('移除附件')} onClick={() => onRemove(file)}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export type MarkdownFormat = 'bold' | 'italic' | 'code' | 'codeBlock' | 'link' | 'list' | 'quote'

export function MarkdownBar({
  open,
  preview,
  content,
  onToggleOpen,
  onTogglePreview,
  onFormat,
}: {
  open: boolean
  preview: boolean
  content: string
  onToggleOpen: () => void
  onTogglePreview: () => void
  onFormat: (kind: MarkdownFormat) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const stopMouseDown = (event: React.MouseEvent): void => event.preventDefault()
  const buttons: Array<{ kind: MarkdownFormat; title: string; label: React.ReactNode; testId?: string }> = [
    { kind: 'bold', title: `${t('粗体')} (⌘B)`, label: <strong>B</strong>, testId: 'markdown-bold' },
    { kind: 'italic', title: `${t('斜体')} (⌘I)`, label: <em>I</em> },
    { kind: 'code', title: `${t('行内代码')} (⌘E)`, label: '</>' },
    { kind: 'codeBlock', title: t('代码块'), label: '{ }' },
    { kind: 'link', title: t('链接'), label: t('链接') },
    { kind: 'list', title: t('列表'), label: t('列表') },
    { kind: 'quote', title: t('引用'), label: t('引用') },
  ]
  return (
    <>
      <div className="markdown-bar">
        <button
          type="button"
          className={`btn btn-quiet markdown-toggle ${open ? 'active' : ''}`}
          data-testid="markdown-toggle"
          title={t('Markdown 格式')}
          aria-label={t('Markdown 格式')}
          onClick={onToggleOpen}
        >
          MD
        </button>
        {open ? (
          <div className="markdown-toolbar" data-testid="markdown-toolbar">
            {buttons.map((button) => (
              <button
                key={button.kind}
                type="button"
                data-testid={button.testId}
                title={button.title}
                onMouseDown={stopMouseDown}
                onClick={() => onFormat(button.kind)}
              >
                {button.label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="spacer" />
        {open ? (
          <button
            type="button"
            className={`btn btn-quiet markdown-preview-toggle ${preview ? 'active' : ''}`}
            data-testid="markdown-preview-toggle"
            onClick={onTogglePreview}
          >
            {t('预览')}
          </button>
        ) : null}
      </div>
      {open && preview ? (
        <div className="markdown-preview" data-testid="markdown-preview">
          {content.trim() ? <MarkdownView text={content} /> : <div className="menu-hint">{t('暂无内容')}</div>}
        </div>
      ) : null}
    </>
  )
}
