// @x-code-cli/desktop — composer 输入框与动作按钮
//
// 富文本编辑器负责输入与格式；这里只负责输入区和附件/截图/语音/发送按钮的
// JSX，避免 App 继续内联两百行结构。
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { CaptureScreenView } from '../shared/protocol.js'
import { ComposerEditor } from './ComposerEditor.js'
import type { ComposerChange, ComposerEditorHandle } from './ComposerEditor.js'
import { AttachIcon, CaptureIcon, DocumentIcon, MicIcon, RegionIcon, SendIcon, StopIcon } from './icons.js'

export interface ComposerBoxProps {
  value: string
  editorRef: RefObject<ComposerEditorHandle | null>
  placeholder: string
  busy: boolean
  canSend: boolean
  recording: boolean
  voiceBusy: boolean
  backgroundActive: number
  captureMenuOpen: boolean
  screens: CaptureScreenView[]
  onComposerChange: (change: ComposerChange) => void
  onComposerKeyDown: (event: KeyboardEvent) => boolean
  onOpenDocumentPanel: () => void
  onPickDocument: () => void
  onToggleCaptureMenu: () => void
  onCaptureRegion: () => void
  onCaptureScreen: (displayId?: number) => void
  onToggleRecording: () => void
  onAbort: () => void
  onSubmit: () => void
}

export function ComposerBox({
  value,
  editorRef,
  placeholder,
  busy,
  canSend,
  recording,
  voiceBusy,
  backgroundActive,
  captureMenuOpen,
  screens,
  onComposerChange,
  onComposerKeyDown,
  onOpenDocumentPanel,
  onPickDocument,
  onToggleCaptureMenu,
  onCaptureRegion,
  onCaptureScreen,
  onToggleRecording,
  onAbort,
  onSubmit,
}: ComposerBoxProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="composer-box">
      <ComposerEditor
        value={value}
        placeholder={placeholder}
        editorRef={editorRef}
        onChange={onComposerChange}
        onKeyDown={onComposerKeyDown}
      />
      <button
        className="btn attach"
        data-testid="document-button"
        title={t('文档面板')}
        aria-label={t('文档面板')}
        onClick={onOpenDocumentPanel}
      >
        <DocumentIcon />
      </button>
      <button className="btn attach" title={t('选择文档或媒体文件')} onClick={onPickDocument}>
        <AttachIcon />
      </button>
      <div className="menu-anchor capture-anchor">
        <button
          className={`btn attach ${captureMenuOpen ? 'active' : ''}`}
          title={t('截图')}
          data-testid="capture-button"
          onClick={onToggleCaptureMenu}
        >
          <CaptureIcon />
        </button>
        {captureMenuOpen ? (
          <>
            <div className="capture-scrim" onClick={onToggleCaptureMenu} aria-hidden="true" />
            <div className="capture-menu" role="menu" data-testid="capture-menu">
              <button className="capture-item" data-testid="capture-region" onClick={onCaptureRegion}>
                <RegionIcon />
                <span>{t('框选区域')}</span>
              </button>
              {screens.length > 1 ? (
                screens.map((screen) => (
                  <button
                    className="capture-item"
                    key={screen.id}
                    data-testid={screen.primary ? 'capture-screen' : `capture-screen-${screen.id}`}
                    onClick={() => onCaptureScreen(screen.id)}
                  >
                    <CaptureIcon />
                    <span>
                      {screen.name}
                      <span className="capture-item-meta">
                        {screen.primary ? ` · ${t('主屏幕')}` : ''} · {screen.width}×{screen.height}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <button className="capture-item" data-testid="capture-screen" onClick={() => onCaptureScreen()}>
                  <CaptureIcon />
                  <span>{t('整个屏幕')}</span>
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
      <button
        className={`btn attach ${recording ? 'recording' : ''}`}
        data-testid="mic-button"
        title={recording ? t('停止录音并转写') : t('语音输入')}
        disabled={voiceBusy}
        onClick={onToggleRecording}
      >
        {recording ? <StopIcon /> : <MicIcon />}
      </button>
      {busy ? (
        <button
          className="send stop"
          title={backgroundActive > 0 ? t('停止当前回复；后台任务会继续运行') : t('停止当前回复')}
          onClick={onAbort}
        >
          {t('停止')}
        </button>
      ) : (
        <button className="send" title={t('落笔')} aria-label={t('落笔')} disabled={!canSend} onClick={onSubmit}>
          <SendIcon />
        </button>
      )}
    </div>
  )
}
