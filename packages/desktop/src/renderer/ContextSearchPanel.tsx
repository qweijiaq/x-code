import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ContextSearchResponse,
  ContextSearchResultView,
  ContextSearchSourceView,
  RequestMap,
  RequestMethod,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'

function request<T extends RequestMethod>(method: T, params: RequestMap[T]['params']): Promise<RuntimeResponse> {
  return window.xcode.request({ id: crypto.randomUUID(), method, params } as RuntimeRequest)
}

const SOURCES: Array<{ id: ContextSearchSourceView; label: string }> = [
  { id: 'memory', label: '记忆' },
  { id: 'docs', label: '文档' },
  { id: 'sessions', label: '会话' },
  { id: 'code', label: '代码' },
]

const SOURCE_LABEL: Record<ContextSearchSourceView, string> = {
  memory: '记忆',
  docs: '文档',
  sessions: '会话',
  code: '代码',
}

interface Props {
  onClose: () => void
  onOpenPath: (path: string, line?: number) => void
  onOpenDocument: (path: string, page?: number) => void
  onOpenSession: (sessionId: string) => void
}

function reference(item: ContextSearchResultView): string {
  return [
    item.path ? `${item.path}${item.line ? `:${item.line}` : ''}` : '',
    item.page ? `page ${item.page}` : '',
    item.sessionId ? `session ${item.sessionId}` : '',
    item.role ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function ContextSearchPanel({ onClose, onOpenPath, onOpenDocument, onOpenSession }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [scopes, setScopes] = useState<Set<ContextSearchSourceView>>(new Set(SOURCES.map((source) => source.id)))
  const [result, setResult] = useState<ContextSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const response = await request('context:search', {
        query: trimmed,
        scopes: [...scopes],
        limit: 8,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setResult(response.result as ContextSearchResponse)
    } finally {
      setLoading(false)
    }
  }

  const toggleScope = (id: ContextSearchSourceView): void => {
    setScopes((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next.size === 0 ? new Set(SOURCES.map((source) => source.id)) : next
    })
  }

  const open = (item: ContextSearchResultView): void => {
    if (item.source === 'code' && item.path) return onOpenPath(item.path, item.line)
    if (item.source === 'docs' && item.path) return onOpenDocument(item.path, item.page)
    if (item.source === 'sessions' && item.sessionId) return onOpenSession(item.sessionId)
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="goal-card context-search-card"
        data-testid="context-search-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="goal-head">
          <div>
            <div className="goal-title">{t('全局检索')}</div>
            <div className="goal-sub">{t('记忆 / 文档 / 历史会话 / 代码，一次查询并保留引用')}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose} aria-label={t('关闭面板')}>
            {t('关闭面板')}
          </button>
        </header>

        <div className="context-search-bar">
          <input
            className="settings-input"
            autoFocus
            value={query}
            placeholder={t('搜索本地上下文，例如：登录逻辑、上次的决定、错误处理')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void search()
            }}
          />
          <button className="btn solid" disabled={loading || !query.trim()} onClick={() => void search()}>
            {loading ? t('搜索中…') : t('搜索')}
          </button>
        </div>

        <div className="context-scopes">
          {SOURCES.map((source) => (
            <button
              key={source.id}
              className={`btn ${scopes.has(source.id) ? 'solid' : ''}`}
              onClick={() => toggleScope(source.id)}
            >
              {t(source.label)}
            </button>
          ))}
        </div>

        {error ? <div className="goal-error">{error}</div> : null}
        {result && result.results.length === 0 ? (
          <div className="goal-muted">{result.notes[0] ?? t('没有匹配结果。')}</div>
        ) : null}
        {result && result.results.length > 0 ? (
          <div className="context-results">
            {result.results.map((item, index) => (
              <button
                key={`${item.source}-${index}-${item.path ?? item.sessionId ?? item.title}`}
                className="context-result"
                onClick={() => open(item)}
                disabled={item.source === 'memory' || (!item.path && !item.sessionId)}
              >
                <span className={`context-source context-source-${item.source}`}>{t(SOURCE_LABEL[item.source])}</span>
                <span className="context-result-body">
                  <span className="context-result-title">{item.title}</span>
                  {reference(item) ? <span className="context-result-ref">{reference(item)}</span> : null}
                  <span className="context-result-snippet">{item.snippet}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
