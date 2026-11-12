// @x-code-cli/desktop — 单条 transcript 条目
//
// 从 App.tsx 的 turnItems.map 中拆出：工具卡片、消息、diff、附件和操作按钮。
// 组件只通过 props 读取状态和回调，不直接访问 App 的 ref/闭包。
import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton, MarkdownView } from './MarkdownView.js'
import { isImageAttachment } from './media.js'
import { AttachmentImage, DiffView, SourceList, SubAgentBlock } from './transcript-components.js'
import type { Entry, ToolDisplayMode } from './transcript-model.js'
import {
  ROLE_LABEL,
  TOOL_STATUS_LABEL,
  attachmentName,
  formatDuration,
  summarizeInput,
  tempDeliverables,
  toolEnvironmentHint,
} from './transcript-model.js'

export interface TranscriptEntryContextValue {
  busy: boolean
  now: number
  toolDisplayMode: ToolDisplayMode
  movingTempEntry: string | null
  shellSandboxEnabled: boolean
  shellSandboxAllowNetwork: boolean
  activeTextEntryId: string | null
  findMatchIds: readonly string[]
  findActiveId: string | null
  lastAssistantId: string | null
  lastUserId: string | null
  onOpenDocument: (path: string) => void | Promise<void>
  onOpenEditor: (path: string, line?: number) => void
  onRevertEdit: (toolCallId: string, entryId: string) => void | Promise<void>
  onAllowSandboxNetwork: () => void | Promise<void>
  onRefreshEnvironment: () => void | Promise<void>
  onOpenToolsSettings: () => void | Promise<void>
  onMoveTempDeliverables: (entryId: string, files: string[]) => void | Promise<void>
  onOpenImage: (src: string, name: string) => void
  onRunInTerminal: (command: string) => void
  onRegenerate: () => void | Promise<void>
  onEditLast: () => void
}

const TranscriptEntryContext = createContext<TranscriptEntryContextValue | null>(null)

export function TranscriptEntryProvider({
  value,
  children,
}: {
  value: TranscriptEntryContextValue
  children: ReactNode
}): React.JSX.Element {
  return <TranscriptEntryContext.Provider value={value}>{children}</TranscriptEntryContext.Provider>
}

export function TranscriptEntry({ entry }: { entry: Entry }): React.JSX.Element {
  const context = useContext(TranscriptEntryContext)
  if (!context) throw new Error('TranscriptEntry must be rendered inside TranscriptEntryProvider')
  const {
    busy,
    now,
    toolDisplayMode,
    movingTempEntry,
    shellSandboxEnabled,
    shellSandboxAllowNetwork,
    activeTextEntryId,
    findMatchIds,
    findActiveId,
    lastAssistantId,
    lastUserId,
    onOpenDocument,
    onOpenEditor,
    onRevertEdit,
    onAllowSandboxNetwork,
    onRefreshEnvironment,
    onOpenToolsSettings,
    onMoveTempDeliverables,
    onOpenImage,
    onRunInTerminal,
    onRegenerate,
    onEditLast,
  } = context
  const activeStreaming = busy && entry.id === activeTextEntryId
  const { t } = useTranslation()
  const toolGuidance =
    entry.role === 'tool' && entry.toolOutput ? toolEnvironmentHint(entry.toolOutput, shellSandboxEnabled) : null
  const toolCommand =
    entry.role === 'tool' && typeof entry.toolInput?.command === 'string' ? entry.toolInput.command : null
  const tempOutputs =
    entry.role === 'tool' && !entry.reverted && !entry.movedDeliverables?.length
      ? tempDeliverables(entry.toolOutput)
      : []
  const runningSeconds =
    entry.toolStatus === 'running' && entry.toolStartedAt && now > 0
      ? Math.max(0, Math.floor((now - entry.toolStartedAt) / 1000))
      : null
  // 适中模式只保留卡片头部；全面模式默认展开全部内容。
  // 手动展开/收起只对当前模式生效，切换模式后回到该模式的默认值。
  const [cardOverride, setCardOverride] = useState<{ mode: ToolDisplayMode; open: boolean } | null>(null)
  const cardOpen =
    cardOverride && cardOverride.mode === toolDisplayMode ? cardOverride.open : toolDisplayMode === 'full'
  const toggleCard = (): void => setCardOverride({ mode: toolDisplayMode, open: !cardOpen })
  const hasBody = entry.role === 'tool' && Boolean(entry.diff || entry.toolOutput || entry.subagent)
  return entry.role === 'tool' ? (
    <article key={entry.id} className={`tool-card ${entry.toolStatus ?? 'running'}`}>
      <div className="tool-head">
        <span className="tool-name">{entry.toolName ?? 'tool'}</span>
        <span className={`tool-state ${entry.toolStatus ?? 'running'}`}>
          {t(TOOL_STATUS_LABEL[entry.toolStatus ?? 'running'])}
          {runningSeconds !== null ? ` · ${formatDuration(runningSeconds)}` : ''}
        </span>
        <span className="spacer" />
        <span className="tool-target">{summarizeInput(entry.toolInput)}</span>
        {entry.toolName === 'readDocument' && typeof entry.toolInput?.filePath === 'string' ? (
          <button className="session-action" onClick={() => void onOpenDocument(String(entry.toolInput?.filePath))}>
            {t('预览')}
          </button>
        ) : null}
        {hasBody ? (
          <button
            type="button"
            className="tool-toggle"
            data-testid="tool-card-toggle"
            aria-expanded={cardOpen}
            onClick={toggleCard}
          >
            {cardOpen ? t('收起') : t('展开')}
          </button>
        ) : null}
      </div>
      {entry.toolProgress ? <div className="tool-progress">{entry.toolProgress}</div> : null}
      {cardOpen && entry.subagent ? (
        <SubAgentBlock agent={entry.subagent} expanded={toolDisplayMode === 'full'} />
      ) : null}
      {cardOpen && entry.diff ? (
        <DiffView
          diff={entry.diff}
          reverted={entry.reverted}
          expanded={toolDisplayMode === 'full'}
          onOpenEditor={(path, line) => onOpenEditor(path, line)}
          onRevert={
            entry.diff.revertible && entry.toolCallId ? () => void onRevertEdit(entry.toolCallId!, entry.id) : undefined
          }
        />
      ) : null}
      {cardOpen && entry.toolOutput ? (
        <details className="tool-output" {...(toolDisplayMode === 'full' ? { open: true } : {})}>
          <summary>{t('结果')}</summary>
          <pre>{entry.toolOutput}</pre>
        </details>
      ) : null}
      {toolGuidance ? (
        <div className="tool-guidance" data-testid="tool-environment-hint">
          <span>
            {toolGuidance === 'gui'
              ? t(
                  'Electron / Chromium 这类 GUI 程序无法在 X-Code 的 Shell 沙箱里启动（嵌套沙箱被系统拒绝），也写不了 ~/Library。请在终端里运行，或临时关闭 Shell 沙箱。',
                )
              : toolGuidance === 'package'
                ? t(
                    'npm / pip 需要写入用户缓存目录（如 ~/.npm），沙箱只允许写工作区和临时目录。请在终端里运行，或临时关闭 Shell 沙箱。',
                  )
                : toolGuidance === 'network'
                  ? shellSandboxAllowNetwork
                    ? t('命令没能联网；如果本机网络正常，请检查命令使用的代理或地址。')
                    : t('命令没能联网。Shell 沙箱当前禁止网络访问；如果本机网络正常，允许网络后重试。')
                  : toolGuidance === 'write'
                    ? t('命令被 Shell 沙箱拦截：只能写入工作区和临时目录。可以在终端里运行，终端不受沙箱限制。')
                    : t('命令找不到。如果刚在电脑终端安装了它，刷新登录 shell 环境后重试。')}
          </span>
          <span className="spacer" />
          {toolCommand ? (
            <button
              className="btn btn-quiet"
              data-testid="tool-run-in-terminal"
              title={t('在右侧终端里执行这条命令（终端不受 Shell 沙箱限制）')}
              onClick={() => onRunInTerminal(toolCommand)}
            >
              {t('在终端执行')}
            </button>
          ) : null}
          {toolGuidance === 'network' && !shellSandboxAllowNetwork ? (
            <button className="btn btn-quiet" onClick={() => void onAllowSandboxNetwork()}>
              {t('允许网络')}
            </button>
          ) : null}
          {toolGuidance === 'command' ? (
            <button className="btn btn-quiet" onClick={() => void onRefreshEnvironment()}>
              {t('刷新环境')}
            </button>
          ) : null}
          {toolGuidance !== 'command' ? (
            <button className="btn btn-quiet" onClick={() => void onOpenToolsSettings()}>
              {t('沙箱设置')}
            </button>
          ) : null}
        </div>
      ) : null}
      {tempOutputs.length > 0 ? (
        <div className="tool-guidance" data-testid="temp-deliverable-hint">
          <span>
            {t('交付物写到了系统临时目录：{{files}}', {
              files: tempOutputs.map((item) => item.split(/[\\/]/).pop() || item).join('、'),
            })}
          </span>
          <span className="spacer" />
          <button
            className="btn btn-quiet"
            disabled={busy || movingTempEntry === entry.id}
            title={busy ? t('当前回复结束后可以移动') : undefined}
            onClick={() => void onMoveTempDeliverables(entry.id, tempOutputs)}
          >
            {movingTempEntry === entry.id ? t('移动中…') : t('移动到工作区')}
          </button>
        </div>
      ) : null}
      {entry.movedDeliverables?.length ? (
        <div className="tool-guidance success" data-testid="temp-deliverable-moved">
          <span>
            {t('已移动到工作区：{{files}}', {
              files: entry.movedDeliverables.map((item) => item.split(/[\\/]/).pop() || item).join('、'),
            })}
          </span>
        </div>
      ) : null}
      {cardOpen && entry.toolOutput && (entry.toolName === 'webSearch' || entry.toolName === 'webFetch') ? (
        <SourceList text={entry.toolOutput} />
      ) : null}
    </article>
  ) : (
    <article
      key={entry.id}
      id={`entry-${entry.id}`}
      data-entry-id={entry.id}
      className={`message ${entry.role} ${findMatchIds.includes(entry.id) ? 'find-hit' : ''} ${
        entry.id === findActiveId ? 'find-current' : ''
      }`}
    >
      <span className="role">{t(ROLE_LABEL[entry.role])}</span>
      {entry.role === 'assistant' || entry.role === 'user' ? (
        <MarkdownView text={entry.text} streaming={activeStreaming} />
      ) : (
        <span className="message-text">{entry.text}</span>
      )}
      {entry.attachments?.length ? (
        <div className="message-attachments">
          {entry.attachments.map((file) =>
            isImageAttachment(file) ? (
              <AttachmentImage
                key={file}
                file={file}
                variant="message"
                onOpen={(src, name) => onOpenImage(src, name)}
              />
            ) : (
              <span className="message-attachment-file" key={file} title={file}>
                {attachmentName(file)}
              </span>
            ),
          )}
        </div>
      ) : null}
      {entry.attachmentViews?.length ? (
        <div className="message-attachments">
          {entry.attachmentViews.map((attachment, index) => {
            const dataUrl = attachment.dataUrl
            return dataUrl ? (
              <button
                key={`${attachment.name}-${index}`}
                type="button"
                className="message-attachment"
                title={attachment.name}
                onClick={() => onOpenImage(dataUrl, attachment.name)}
              >
                <img src={dataUrl} alt={attachment.name} loading="lazy" />
                <span>{attachment.name}</span>
              </button>
            ) : attachment.path && isImageAttachment(attachment.path) ? (
              <AttachmentImage
                key={`${attachment.name}-${index}`}
                file={attachment.path}
                variant="message"
                onOpen={(src, name) => onOpenImage(src, name)}
              />
            ) : (
              <span key={`${attachment.name}-${index}`} className="message-attachment-file" title={attachment.name}>
                {attachment.name}
              </span>
            )
          })}
        </div>
      ) : null}
      {entry.text ? (
        <span className="message-actions">
          {entry.role === 'assistant' || entry.role === 'user' ? <CopyButton text={entry.text} /> : null}
          {entry.role === 'assistant' && entry.id === lastAssistantId && !busy ? (
            <button type="button" className="copy-btn" onClick={() => void onRegenerate()}>
              {t('重新生成')}
            </button>
          ) : null}
          {entry.role === 'user' && entry.id === lastUserId && !busy ? (
            <button type="button" className="copy-btn" onClick={onEditLast}>
              {t('编辑并重发')}
            </button>
          ) : null}
        </span>
      ) : null}
    </article>
  )
}
