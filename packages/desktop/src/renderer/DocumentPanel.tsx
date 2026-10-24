import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DocumentDiffView, DocumentRecentItem, DocumentView } from '../shared/protocol.js'
import { MarkdownView } from './MarkdownView.js'

interface DocumentPanelProps {
  view: DocumentView | null
  loading: boolean
  error: string | null
  onClose(): void
  onReload(): void
  onAttach(path: string): void
  onAsk(prompt: string, path: string): void
  onSummarize(path: string): void
  onOcrPage(page: number): Promise<string>
  onLoadMore(): void
  loadingMore: boolean
  onForgetOcr(): void
  documents: DocumentRecentItem[]
  onSwitchDocument(path: string): void
  onPickDocument(): void
  onDiff(): Promise<DocumentDiffView | null>
  onApplyHunks(accepted: number[], hash: string): Promise<boolean>
  onSaveBaseline(): Promise<void>
  focusPage: number | null
  /** Render inside the unified inspector instead of a fixed drawer. */
  embedded?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function DocumentPanel({
  view,
  loading,
  error,
  onClose,
  onReload,
  onAttach,
  onAsk,
  onSummarize,
  onOcrPage,
  onLoadMore,
  loadingMore,
  onForgetOcr,
  documents,
  onSwitchDocument,
  onPickDocument,
  onDiff,
  onApplyHunks,
  onSaveBaseline,
  focusPage,
  embedded = false,
}: DocumentPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [sheetIndex, setSheetIndex] = useState(0)
  const [question, setQuestion] = useState('')
  const [ocrBusy, setOcrBusy] = useState<{ done: number; total: number } | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const [diff, setDiff] = useState<DocumentDiffView | null>(null)
  const [selectedHunks, setSelectedHunks] = useState<Set<number>>(new Set())
  const [applyingHunks, setApplyingHunks] = useState(false)
  const [diffNotice, setDiffNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!focusPage) return
    document.getElementById(`doc-page-${focusPage}`)?.scrollIntoView({ block: 'start' })
  }, [focusPage, view?.pages])

  const sheet = view?.sheets?.[Math.min(sheetIndex, Math.max(0, (view.sheets?.length ?? 1) - 1))]

  // Runtime notes are emitted in English by core; map the known ones so the
  // panel follows the UI language.
  const localizeNote = (note: string): string => {
    let match = /^OCR skipped for (\d+) page\(s\)/.exec(note)
    if (match) return t('已跳过 {{count}} 页无文字层的 OCR（预览模式）', { count: Number(match[1]) })
    match = /^Applied local OCR to (\d+) page\(s\)/.exec(note)
    if (match) return t('已对 {{count}} 页缺少文字层的内容执行本地 OCR。', { count: Number(match[1]) })
    match = /^Only the first (\d+) of (\d+) pages were read\./.exec(note)
    if (match)
      return t('仅读取了前 {{shown}} 页，共 {{total}} 页。', { shown: Number(match[1]), total: Number(match[2]) })
    match = /^Rendered the first (\d+) of (\d+) pages\./.exec(note)
    if (match)
      return t('仅渲染了前 {{shown}} 页，共 {{total}} 页。', { shown: Number(match[1]), total: Number(match[2]) })
    match = /^Page images could not be rendered: (.*)$/.exec(note)
    if (match) return t('页面图片渲染失败：{{message}}', { message: match[1] })
    if (note === 'This PDF has little or no extractable text; it may be a scanned document.') {
      return t('此 PDF 几乎没有可提取文本，可能是扫描件。')
    }
    if (
      note ===
      'This PDF has little or no extractable text, and local OCR produced nothing usable; it may be image-only or encrypted.'
    ) {
      return t('此 PDF 几乎没有可提取文本，本地 OCR 也没有得到可用内容；可能是纯图片或已加密。')
    }
    if (note === 'OCR is local and may miss layout, diagrams, or photos.') {
      return t('OCR 在本地执行，可能遗漏版式、图表或照片内容。')
    }
    if (note.startsWith('For visual understanding, call readFile')) {
      return t('需要理解图片本身时，可让 Agent 用 readFile 打开同一路径。')
    }
    if (note === 'File changed while the review was open; reload the document and review again') {
      return t('审核期间文件已被修改，请重新读取后再审核。')
    }
    if (note === 'No baseline stored for this document') {
      return t('这个文档还没有基线，请重新读取后再试。')
    }
    if (note === 'This file type does not support edit review') {
      return t('这种文件类型不支持修改审核。')
    }
    return note
  }

  const missingTextPages = (view?.pages ?? []).filter((page) => !page.text)
  const ocrOne = async (page: number): Promise<void> => {
    setOcrBusy({ done: 0, total: 1 })
    try {
      await onOcrPage(page)
    } finally {
      setOcrBusy(null)
    }
  }
  const ocrAll = async (): Promise<void> => {
    const targets = (view?.pages ?? []).filter((page) => !page.text).map((page) => page.page)
    if (targets.length === 0) return
    setOcrBusy({ done: 0, total: targets.length })
    try {
      for (const [index, page] of targets.entries()) {
        setOcrBusy({ done: index, total: targets.length })
        await onOcrPage(page)
      }
    } finally {
      setOcrBusy(null)
    }
  }

  const fullText = view?.text
    ? view.text.replace(/\.\.\. \[preview truncated at (\d+) chars\]$/, (_match, count: string) =>
        t('… [文本已截断至 {{count}} 字符]', { count }),
      )
    : ''
  const pageTextMap = new Map<number, string>()
  for (const entry of view?.pageTexts ?? []) pageTextMap.set(entry.page, entry.text)
  for (const entry of view?.pages ?? []) {
    if (entry.text) pageTextMap.set(entry.page, entry.text)
  }
  const openDiff = async (): Promise<void> => {
    setDiffNotice(null)
    const next = await onDiff()
    if (!next) {
      setDiffNotice(t('没有可显示的差异，文件可能已经是最新基线。'))
      return
    }
    setDiff(next)
    setSelectedHunks(new Set(next.hunks.map((_, index) => index)))
  }

  const toggleHunk = (index: number): void => {
    setSelectedHunks((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const applySelected = async (): Promise<void> => {
    if (!diff) return
    setApplyingHunks(true)
    const ok = await onApplyHunks(
      [...selectedHunks].sort((a, b) => a - b),
      diff.hash,
    )
    setApplyingHunks(false)
    if (ok) {
      setDiff(null)
      setSelectedHunks(new Set())
      setDiffNotice(null)
    }
  }

  const combinedText =
    pageTextMap.size > 0
      ? [...pageTextMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([page, text]) => `--- ${t('第 {{page}} 页', { page })} ---\n${text || t('（本页无文本）')}`)
          .join('\n\n')
      : fullText
  const switcherOpen = docsOpen || (!view && !loading)

  return (
    <>
      {!embedded ? <div className="drawer-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <aside
        className={`document-drawer${embedded ? ' embedded' : ''}`}
        data-testid="document-drawer"
        aria-label={t('文档面板')}
      >
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            阅
          </span>
          <div className="drawer-title">
            {view?.name ?? t('文档面板')}
            {view ? (
              <span className="document-path" title={view.path}>
                {view.path}
              </span>
            ) : null}
          </div>
          <button className="btn" onClick={() => setDocsOpen((open) => !open)}>
            {t('切换文档')}
          </button>
          <button className="btn" onClick={onReload} disabled={!view || loading}>
            {t('重新读取')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('关闭')}
          </button>
        </header>

        {documents.length > 0 ? (
          <div className="document-tabs" data-testid="document-tabs">
            {documents.slice(0, 6).map((item) => (
              <button
                key={item.path}
                className={`document-tab ${item.path === view?.path ? 'active' : ''}`}
                disabled={!item.exists}
                title={item.path}
                onClick={() => onSwitchDocument(item.path)}
              >
                {item.name}
                {item.hasOcr ? <span className="document-switch-tag">OCR</span> : null}
              </button>
            ))}
            <button
              className="document-tab document-tab-more"
              onClick={() => setDocsOpen((open) => !open)}
              title={t('全部最近文档')}
            >
              {t('全部…')}
            </button>
          </div>
        ) : null}

        {switcherOpen ? (
          <div className="document-switcher">
            <button
              className="settings-btn primary"
              onClick={() => {
                setDocsOpen(false)
                onPickDocument()
              }}
            >
              {t('打开其他文件…')}
            </button>
            {documents.length === 0 ? <div className="settings-empty">{t('暂无最近文档')}</div> : null}
            {documents.map((item) => (
              <button
                key={item.path}
                className={`settings-btn ${item.path === view?.path ? 'active' : ''}`}
                disabled={!item.exists}
                title={item.path}
                onClick={() => {
                  setDocsOpen(false)
                  onSwitchDocument(item.path)
                }}
              >
                <span className="document-switch-name">{item.name}</span>
                {item.hasOcr ? <span className="document-switch-tag">OCR</span> : null}
                {!item.exists ? <span className="document-switch-tag">{t('文件不存在')}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="document-body">
          {loading ? <div className="settings-empty">{t('加载中…')}</div> : null}
          {error ? <div className="settings-warn">{localizeNote(error)}</div> : null}
          {!loading && !error && view ? (
            <>
              {view.editable && view.changed && !diff ? (
                <div className="document-review-bar">
                  <span>{t('文档在打开后被修改')}</span>
                  <button className="settings-btn primary" onClick={() => void openDiff()}>
                    {t('查看改动')}
                  </button>
                  <button className="settings-btn" onClick={() => void onSaveBaseline()}>
                    {t('以当前内容为新基线')}
                  </button>
                  {diffNotice ? <span className="document-review-note">{diffNotice}</span> : null}
                </div>
              ) : null}

              {diff ? (
                <section className="document-diff">
                  <div className="document-diff-head">
                    <span className="document-diff-title">
                      {t('变更 +{{added}} −{{removed}}', { added: diff.additions, removed: diff.removals })}
                    </span>
                    <button
                      className="settings-btn"
                      onClick={() => setSelectedHunks(new Set(diff.hunks.map((_, index) => index)))}
                    >
                      {t('全选')}
                    </button>
                    <button className="settings-btn" onClick={() => setSelectedHunks(new Set())}>
                      {t('全不选')}
                    </button>
                    <button
                      className="settings-btn primary"
                      disabled={applyingHunks}
                      onClick={() => void applySelected()}
                    >
                      {applyingHunks ? t('应用中…') : t('应用所选')}
                    </button>
                    <button className="settings-btn" onClick={() => setDiff(null)}>
                      {t('取消')}
                    </button>
                  </div>
                  <div className="document-diff-hunks">
                    {diff.hunks.map((hunk, index) => (
                      <label key={index} className={`document-hunk ${selectedHunks.has(index) ? 'selected' : ''}`}>
                        <input type="checkbox" checked={selectedHunks.has(index)} onChange={() => toggleHunk(index)} />
                        <span className="document-hunk-body">
                          <span className="document-hunk-head">
                            {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                          </span>
                          <span className="document-hunk-lines">
                            {hunk.lines.map((line, lineIndex) => (
                              <span
                                key={lineIndex}
                                className={`diff-line ${
                                  line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''
                                }`}
                              >
                                {line || ' '}
                              </span>
                            ))}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ) : null}
              <div className="document-meta">
                <span>{view.format.toUpperCase()}</span>
                {typeof view.metadata.pages === 'number' ? (
                  <span>{t('共 {{count}} 页', { count: view.metadata.pages })}</span>
                ) : null}
                {typeof view.metadata.bytes === 'number' ? <span>{formatBytes(view.metadata.bytes)}</span> : null}
                {view.sheets ? <span>{t('{{count}} 个工作表', { count: view.sheets.length })}</span> : null}
              </div>

              {view.dataUrl ? (
                <div className="document-image">
                  <img src={view.dataUrl} alt={view.name} />
                </div>
              ) : null}

              {view.sheets && view.sheets.length > 0 ? (
                <>
                  {view.sheets.length > 1 ? (
                    <div className="document-sheet-tabs">
                      {view.sheets.map((entry, index) => (
                        <button
                          key={entry.name}
                          className={`settings-tab-inline ${index === sheetIndex ? 'active' : ''}`}
                          onClick={() => setSheetIndex(index)}
                        >
                          {entry.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {sheet ? (
                    <div className="document-table-wrap">
                      <table className="document-table">
                        <tbody>
                          {sheet.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((cell, columnIndex) => (
                                <td key={columnIndex} className={rowIndex === 0 ? 'header' : ''}>
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="document-table-note">
                        {t('显示前 {{rows}} 行 × {{columns}} 列（共 {{totalRows}} × {{totalColumns}}）', {
                          rows: sheet.rows.length,
                          columns: sheet.rows[0]?.length ?? 0,
                          totalRows: sheet.totalRows,
                          totalColumns: sheet.totalColumns,
                        })}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {view.pages && view.pages.length > 0 ? (
                <div className="document-pages">
                  {missingTextPages.length > 0 || (view.ocrPages?.length ?? 0) > 0 ? (
                    <div className="document-ocr-bar">
                      {missingTextPages.length > 0 ? (
                        <button className="settings-btn" disabled={ocrBusy !== null} onClick={() => void ocrAll()}>
                          {ocrBusy
                            ? t('识别中 {{done}}/{{total}}…', { done: ocrBusy.done, total: ocrBusy.total })
                            : t('识别无文字页（{{count}} 页）', { count: missingTextPages.length })}
                        </button>
                      ) : null}
                      {(view.ocrPages?.length ?? 0) > 0 ? (
                        <button className="settings-btn" onClick={onForgetOcr}>
                          {t('清除 OCR（{{count}} 页）', { count: view.ocrPages?.length ?? 0 })}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {view.pages.map((page) => (
                    <details key={page.page} id={`doc-page-${page.page}`} className="document-page" open>
                      <summary className="document-page-summary">
                        <span className="document-page-title">{t('第 {{page}} 页', { page: page.page })}</span>
                        {page.ocr ? <span className="document-ocr-tag">{t('OCR')}</span> : null}
                        <span className="document-page-hint">
                          {page.text ? page.text.replace(/\s+/g, ' ').slice(0, 48) : t('本页没有可提取的文本。')}
                        </span>
                      </summary>
                      <img src={page.dataUrl} alt={`${view.name} — ${page.page}`} />
                      {page.text ? (
                        <pre className="document-page-text">{page.text}</pre>
                      ) : (
                        <div className="document-page-empty">
                          <span>{t('本页没有可提取的文本。')}</span>
                          <button
                            className="session-action"
                            disabled={ocrBusy !== null}
                            onClick={() => void ocrOne(page.page)}
                          >
                            {t('识别本页')}
                          </button>
                        </div>
                      )}
                    </details>
                  ))}
                  {view.hasMore ? (
                    <button className="settings-btn document-load-more" disabled={loadingMore} onClick={onLoadMore}>
                      {loadingMore
                        ? t('渲染中…')
                        : t('继续渲染（第 {{from}}–{{to}} 页，共 {{total}} 页）', {
                            from: (view.pages?.at(-1)?.page ?? 0) + 1,
                            to: Math.min(
                              (view.pages?.at(-1)?.page ?? 0) + 20,
                              view.totalPages ?? (view.pages?.at(-1)?.page ?? 0) + 20,
                            ),
                            total: view.totalPages ?? 0,
                          })}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {(view.pages?.length ?? 0) > 0 || (view.pageTexts?.length ?? 0) > 0 ? (
                <details className="document-fulltext">
                  <summary>
                    {t('全部页面文本（{{count}} 页）', {
                      count: view.pages?.length ?? view.pageTexts?.length ?? 0,
                    })}
                  </summary>
                  <pre>{combinedText}</pre>
                </details>
              ) : null}

              {view.text && (view.pages?.length ?? 0) === 0 && (view.pageTexts?.length ?? 0) === 0 ? (
                view.format === 'md' || view.format === 'markdown' ? (
                  <div className="document-text markdown-scroll">
                    <MarkdownView text={fullText} />
                  </div>
                ) : (
                  <details className="document-text" open={!view.sheets && !view.dataUrl}>
                    <summary>{t('提取的文本')}</summary>
                    <pre>{fullText}</pre>
                  </details>
                )
              ) : null}

              {view.notes.length > 0 ? (
                <ul className="document-notes">
                  {view.notes.map((note, index) => (
                    <li key={index}>{localizeNote(note)}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>

        {view ? (
          <footer className="document-actions">
            <div className="document-action-row">
              <button className="settings-btn primary" onClick={() => onSummarize(view.path)}>
                {t('总结文档')}
              </button>
              <button className="settings-btn" onClick={() => onAttach(view.path)}>
                {t('作为附件')}
              </button>
            </div>
            <div className="document-ask">
              <input
                className="settings-input"
                value={question}
                placeholder={t('针对这篇文档提问…')}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && question.trim()) {
                    event.preventDefault()
                    onAsk(question.trim(), view.path)
                    setQuestion('')
                  }
                }}
              />
              <button
                className="settings-btn"
                disabled={!question.trim()}
                onClick={() => {
                  onAsk(question.trim(), view.path)
                  setQuestion('')
                }}
              >
                {t('提问')}
              </button>
            </div>
          </footer>
        ) : null}
      </aside>
    </>
  )
}
