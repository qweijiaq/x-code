import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  FileReadView,
  FileTreeEntryView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'
import { MarkdownView } from './MarkdownView.js'

hljs.registerLanguage('dockerfile', dockerfile)

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

function previewKind(path: string): 'html' | 'markdown' | null {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'html' || extension === 'htm' || extension === 'svg') return 'html'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  return null
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xml: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
}

function highlightLanguage(path: string): string | null {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile' || base === 'containerfile') return 'dockerfile'
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile'
  if (!base.includes('.')) return null
  const extension = base.split('.').pop() ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? null
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  workspace: string
  initialPath?: string | null
  onOpenEditor?: (path: string, line?: number) => void
  onClose: () => void
  /** 在统一检查器内渲染，而非固定抽屉。 */
  embedded?: boolean
}

export function FilePanel({
  workspace,
  initialPath,
  onOpenEditor,
  onClose,
  embedded = false,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [children, setChildren] = useState<Record<string, FileTreeEntryView[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [selected, setSelected] = useState<FileTreeEntryView | null>(null)
  const [read, setRead] = useState<FileReadView | null>(null)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [preview, setPreview] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 })
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const [newPath, setNewPath] = useState('')
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const dirty = read !== null && !read.binary && !read.truncated && draft !== original
  const kind = selected ? previewKind(selected.path) : null
  const canPreview = kind !== null && read !== null && !read.binary && !read.truncated
  const highlightRef = useRef<HTMLPreElement | null>(null)
  const language = selected ? highlightLanguage(selected.path) : null
  const highlighted = useMemo(() => {
    if (!language || draft.length === 0 || draft.length > 300_000) return null
    try {
      return hljs.highlight(draft, { language, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [draft, language])
  const totalLines = draft.length === 0 ? 1 : draft.split('\n').length
  const showGutter = totalLines <= 3_000
  const gutterWidth = Math.max(2, String(totalLines).length) * 8 + 18

  const updateCursor = (textarea: HTMLTextAreaElement): void => {
    const value = textarea.value
    const start = textarea.selectionStart
    const before = value.slice(0, start)
    const line = before.split('\n').length
    setCursor({
      line,
      column: start - before.lastIndexOf('\n'),
      selected: Math.max(0, textarea.selectionEnd - start),
    })
  }

  const loadDir = async (dir: string): Promise<boolean> => {
    const response = await request('files:list', { path: dir })
    if (!response.ok) {
      setError(response.error.message)
      return false
    }
    const result = response.result as { path: string; entries: FileTreeEntryView[] }
    setChildren((prev) => ({ ...prev, [dir]: result.entries }))
    return true
  }

  useEffect(() => {
    void loadDir('.')
  }, [])

  useEffect(() => {
    if (!initialPath) return
    let cancelled = false
    void (async () => {
      const response = await request('files:read', { path: initialPath })
      if (cancelled || !response.ok) return
      const result = response.result as FileReadView
      setSelected({
        name: initialPath.split('/').pop() ?? initialPath,
        path: initialPath,
        type: 'file',
        size: result.size,
      })
      setRead(result)
      setDraft(result.binary ? '' : result.content)
      setOriginal(result.binary ? '' : result.content)
      setPreview(false)
      setCursor({ line: 1, column: 1, selected: 0 })
    })()
    return () => {
      cancelled = true
    }
  }, [initialPath])

  const toggleDir = async (entry: FileTreeEntryView): Promise<void> => {
    setError(null)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!children[entry.path]) await loadDir(entry.path)
  }

  const openFile = async (entry: FileTreeEntryView): Promise<void> => {
    if (dirty && !window.confirm(t('有未保存的修改，放弃并切换文件？'))) return
    setSelected(entry)
    setPreview(false)
    setCursor({ line: 1, column: 1, selected: 0 })
    setLoading(true)
    setError(null)
    try {
      const response = await request('files:read', { path: entry.path })
      if (!response.ok) {
        setError(response.error.message)
        setRead(null)
        return
      }
      const result = response.result as FileReadView
      setRead(result)
      setDraft(result.binary ? '' : result.content)
      setOriginal(result.binary ? '' : result.content)
    } finally {
      setLoading(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!selected || !read || read.binary || read.truncated || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const response = await request('files:write', { path: selected.path, content: draft })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as { size: number }
      setOriginal(draft)
      setRead({ ...read, size: result.size })
      setChildren((prev) => {
        const parent = selected.path.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/')) : '.'
        const entries = prev[parent]
        if (!entries) return prev
        return {
          ...prev,
          [parent]: entries.map((entry) => (entry.path === selected.path ? { ...entry, size: result.size } : entry)),
        }
      })
    } finally {
      setSaving(false)
    }
  }

  const create = async (): Promise<void> => {
    const target = newPath.trim()
    if (!target) return
    setSaving(true)
    setError(null)
    try {
      const response = await request('files:create', { path: target })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setShowNew(false)
      setNewPath('')
      const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '.'
      await loadDir(parent)
      setExpanded((prev) => new Set(prev).add(parent === '.' ? '.' : parent))
      const created = response.result as { path: string; size: number }
      await openFile({
        name: created.path.split('/').pop() ?? created.path,
        path: created.path,
        type: 'file',
        size: created.size,
      })
      editorRef.current?.focus()
    } finally {
      setSaving(false)
    }
  }

  const close = (): void => {
    if (dirty && !window.confirm(t('有未保存的修改，确定关闭？'))) return
    onClose()
  }

  const renderTree = (dir: string, depth: number): React.JSX.Element[] => {
    const entries = children[dir] ?? []
    const nodes: React.JSX.Element[] = []
    for (const entry of entries) {
      const isOpen = entry.type === 'directory' && expanded.has(entry.path)
      nodes.push(
        <button
          key={entry.path}
          className={`file-row ${selected?.path === entry.path ? 'active' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          title={entry.path}
          onClick={() => (entry.type === 'directory' ? void toggleDir(entry) : void openFile(entry))}
        >
          <span className="file-row-icon">{entry.type === 'directory' ? (isOpen ? '▾' : '▸') : '·'}</span>
          <span className="file-row-name">{entry.name}</span>
          {entry.type === 'file' ? <span className="file-row-size">{formatSize(entry.size)}</span> : null}
        </button>,
      )
      if (isOpen) nodes.push(...renderTree(entry.path, depth + 1))
    }
    return nodes
  }

  return (
    <>
      {!embedded ? <div className="drawer-scrim" onClick={close} aria-hidden="true" /> : null}
      <aside className={`file-drawer${embedded ? ' embedded' : ''}`} data-testid="file-drawer" aria-label={t('文件')}>
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            档
          </span>
          <div className="drawer-titles">
            <div className="drawer-title">{t('文件')}</div>
            <div className="drawer-sub">{workspace}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={() => setShowNew((value) => !value)} disabled={saving}>
            {t('新建文件')}
          </button>
          <button
            className="btn btn-quiet"
            onClick={() =>
              void loadDir(
                selected?.type === 'directory'
                  ? selected.path
                  : selected
                    ? selected.path.includes('/')
                      ? selected.path.slice(0, selected.path.lastIndexOf('/'))
                      : '.'
                    : '.',
              )
            }
            title={t('刷新当前目录')}
          >
            {t('刷新')}
          </button>
          <button className="btn btn-quiet" onClick={close}>
            {t('关闭')}
          </button>
        </header>

        <div className="file-body">
          <div className="file-tree">
            <button
              className="file-row root"
              onClick={() => void toggleDir({ name: '.', path: '.', type: 'directory' })}
            >
              <span className="file-row-icon">{expanded.has('.') ? '▾' : '▸'}</span>
              <span className="file-row-name">{t('工作区')}</span>
            </button>
            {renderTree('.', 1)}
          </div>

          <div className="file-editor">
            {showNew ? (
              <div className="file-new">
                <input
                  className="settings-input"
                  placeholder={t('相对路径，如 notes/todo.md')}
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void create()
                    if (event.key === 'Escape') setShowNew(false)
                  }}
                />
                <button className="btn" disabled={saving || !newPath.trim()} onClick={() => void create()}>
                  {t('创建')}
                </button>
              </div>
            ) : null}

            {error ? <div className="settings-warn">{error}</div> : null}
            {loading ? <div className="settings-note">{t('正在读取…')}</div> : null}

            {!selected ? (
              <div className="file-placeholder">{t('从左侧选择一个文件开始编辑。')}</div>
            ) : read?.binary ? (
              <div className="file-placeholder">
                {t('这是一个二进制文件，编辑器只支持文本。')}
                <div className="settings-note">{selected.path}</div>
              </div>
            ) : (
              <>
                <div className="file-editor-head">
                  <code className="file-editor-path">{selected.path}</code>
                  <span className="file-editor-meta">
                    {formatSize(read?.size)} {dirty ? `· ${t('未保存')}` : ''}
                    {read?.truncated ? ` · ${t('文件过大，只读预览')}` : ''}
                  </span>
                  <span className="spacer" />
                  {onOpenEditor ? (
                    <button className="btn btn-quiet" onClick={() => onOpenEditor(selected.path)}>
                      {t('在编辑器打开')}
                    </button>
                  ) : null}
                  {canPreview ? (
                    <button className="btn btn-quiet" onClick={() => setPreview((value) => !value)}>
                      {preview ? t('源码') : t('预览')}
                    </button>
                  ) : null}
                  <button
                    className="btn"
                    disabled={saving || !dirty || read?.truncated === true}
                    onClick={() => void save()}
                    title={t('保存（Cmd/Ctrl+S）')}
                  >
                    {saving ? t('保存中…') : t('保存')}
                  </button>
                </div>
                {preview && kind === 'html' ? (
                  <iframe
                    className="file-preview"
                    sandbox=""
                    srcDoc={draft}
                    title={selected.path}
                    data-testid="file-preview"
                  />
                ) : preview && kind === 'markdown' ? (
                  <div className="file-preview file-preview-markdown" data-testid="file-preview">
                    <MarkdownView text={draft} />
                  </div>
                ) : (
                  <div
                    className={`file-editor-surface ${showGutter ? 'has-gutter' : ''}`}
                    style={{ '--file-gutter': `${gutterWidth}px` } as React.CSSProperties}
                  >
                    {showGutter ? (
                      <div className="file-gutter" ref={gutterRef} aria-hidden="true">
                        {Array.from({ length: totalLines }, (_, index) => (
                          <span key={index}>{index + 1}</span>
                        ))}
                      </div>
                    ) : null}
                    {highlighted !== null ? (
                      <pre
                        ref={highlightRef}
                        className="file-highlight"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
                      />
                    ) : null}
                    <textarea
                      ref={editorRef}
                      className={`file-textarea ${highlighted === null ? 'plain' : ''}`}
                      value={draft}
                      wrap="off"
                      readOnly={read?.truncated === true}
                      spellCheck={false}
                      onChange={(event) => {
                        setDraft(event.target.value)
                        updateCursor(event.currentTarget)
                      }}
                      onClick={(event) => updateCursor(event.currentTarget)}
                      onKeyUp={(event) => updateCursor(event.currentTarget)}
                      onSelect={(event) => updateCursor(event.currentTarget)}
                      onScroll={(event) => {
                        const pre = highlightRef.current
                        if (pre) {
                          pre.scrollTop = event.currentTarget.scrollTop
                          pre.scrollLeft = event.currentTarget.scrollLeft
                        }
                        if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
                      }}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
                          if (onOpenEditor) {
                            event.preventDefault()
                            onOpenEditor(selected.path)
                          }
                          return
                        }
                        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                          event.preventDefault()
                          void save()
                          return
                        }
                        if (event.key === 'Tab' && read?.truncated !== true) {
                          event.preventDefault()
                          const target = event.currentTarget
                          const start = target.selectionStart
                          const end = target.selectionEnd
                          setDraft(`${draft.slice(0, start)}  ${draft.slice(end)}`)
                          requestAnimationFrame(() => {
                            target.selectionStart = start + 2
                            target.selectionEnd = start + 2
                            updateCursor(target)
                          })
                        }
                      }}
                    />
                  </div>
                )}
                {!preview ? (
                  <div className="file-status-bar" data-testid="editor-status">
                    <span>{language ?? t('纯文本')}</span>
                    <span>
                      {t('第 {{line}} 行，第 {{column}} 列', {
                        line: cursor.line,
                        column: cursor.column,
                      })}
                    </span>
                    {cursor.selected > 0 ? <span>{t('已选 {{count}} 个字符', { count: cursor.selected })}</span> : null}
                    <span>{t('共 {{count}} 行', { count: totalLines })}</span>
                    {read?.truncated ? <span>{t('只读')}</span> : null}
                    <span className="spacer" />
                    {onOpenEditor ? <span className="file-status-hint">{t('⌘⇧E 在编辑器打开')}</span> : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
