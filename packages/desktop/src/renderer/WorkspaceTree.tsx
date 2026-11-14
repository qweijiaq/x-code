import { Fragment } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import type { SessionListItem, SessionSearchResult } from '../shared/protocol.js'
import { SidebarSkeleton } from './Skeleton.js'
import { isImeEnter, isImeEvent } from './ime.js'
import { sessionDayGroup, sessionTime, sessionTitle } from './transcript-model.js'

export interface WorkspaceTreeGroup {
  path: string
  name: string
  current: boolean
  sessions: SessionListItem[]
}

interface WorkspaceTreeProps {
  sidebarTreeGroups: WorkspaceTreeGroup[]
  expandedWorkspaces: Set<string>
  runningSessionIds: Set<string>
  runningOther: Record<string, string[]>
  switchingProject: string | null
  activeSessionId: string | null
  pendingSession: { sessionId: string; at: number } | null
  showPendingSession: boolean
  visibleSessions: SessionListItem[]
  extraSearchResults: SessionSearchResult[]
  searchResults: SessionSearchResult[]
  searchingSessions: boolean
  loading: boolean
  othersLoading: boolean
  sessionQuery: string
  showArchived: boolean
  tabTitles: Record<string, string>
  renaming: { filePath: string; value: string } | null
  deletingSession: string | null
  sessionSearchRef: RefObject<HTMLInputElement | null>
  renameCancelRef: RefObject<boolean>
  setSessionQuery(value: string): void
  setShowArchived(update: (value: boolean) => boolean): void
  setRenaming(value: { filePath: string; value: string } | null): void
  setDeletingSession(value: string | null): void
  setSessionMenu(value: { filePath: string; x: number; y: number } | null): void
  toggleWorkspace(path: string): void
  switchProject(path: string): Promise<void>
  newSession(): Promise<void>
  openWorkspaceWindow(path: string): Promise<void>
  newWorkspaceSession(path: string): Promise<void>
  openWorkspaceSession(path: string, filePath: string): Promise<void>
  loadSession(item: SessionListItem): Promise<void>
  commitRename(): Promise<void>
  confirmDeleteSession(item: SessionListItem): Promise<void>
}

export function WorkspaceTree({
  sidebarTreeGroups,
  expandedWorkspaces,
  runningSessionIds,
  runningOther,
  switchingProject,
  activeSessionId,
  pendingSession,
  showPendingSession,
  visibleSessions,
  extraSearchResults,
  searchResults,
  searchingSessions,
  loading,
  othersLoading,
  sessionQuery,
  showArchived,
  tabTitles,
  renaming,
  deletingSession,
  sessionSearchRef,
  renameCancelRef,
  setSessionQuery,
  setShowArchived,
  setRenaming,
  setDeletingSession,
  setSessionMenu,
  toggleWorkspace,
  switchProject,
  newSession,
  openWorkspaceWindow,
  newWorkspaceSession,
  openWorkspaceSession,
  loadSession,
  commitRename,
  confirmDeleteSession,
}: WorkspaceTreeProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="workspace-tree" data-testid="workspace-tree">
      {sidebarTreeGroups.map((group) => {
        const expanded = expandedWorkspaces.has(group.path)
        const runningCount = group.current ? runningSessionIds.size : (runningOther[group.path]?.length ?? 0)
        return (
          <div key={group.path} className={`tree-group${group.current ? ' is-current' : ''}`}>
            <div className={`tree-row${group.current ? ' is-current' : ''}`}>
              <button
                className="tree-twist"
                aria-expanded={expanded}
                aria-label={expanded ? t('收起工作区') : t('展开工作区')}
                onClick={() => toggleWorkspace(group.path)}
              >
                {expanded ? '▾' : '▸'}
              </button>
              <button
                className="tree-name"
                title={group.path}
                disabled={switchingProject !== null}
                onClick={() => (group.current ? toggleWorkspace(group.path) : void switchProject(group.path))}
              >
                {switchingProject === group.path ? <span className="project-spinner" aria-hidden="true" /> : null}
                {group.name}
                {runningCount > 0 ? (
                  <span className="tree-running" title={t('正在执行')}>
                    {runningCount}
                  </span>
                ) : null}
              </button>
              {group.current ? (
                <button className="tree-action" title={t('新建会话')} onClick={() => void newSession()}>
                  ＋
                </button>
              ) : (
                <>
                  <button
                    className="tree-action"
                    data-testid="workspace-new-session"
                    title={t('在该工作区新建会话')}
                    aria-label={t('在该工作区新建会话')}
                    disabled={switchingProject !== null}
                    onClick={() => void newWorkspaceSession(group.path)}
                  >
                    ＋
                  </button>
                  <button
                    className="tree-action"
                    title={t('在新窗口打开该工作区')}
                    aria-label={t('在新窗口打开该工作区')}
                    onClick={() => void openWorkspaceWindow(group.path)}
                  >
                    ⧉
                  </button>
                </>
              )}
            </div>
            {expanded ? (
              group.current ? (
                <div className="tree-children">
                  <div className="sidebar-search-row">
                    <span
                      className="sidebar-session-count"
                      title={t('当前工作区 {{count}} 个会话', { count: visibleSessions.length })}
                    >
                      {visibleSessions.length}
                    </span>
                    <div className="sidebar-search">
                      <input
                        ref={sessionSearchRef}
                        value={sessionQuery}
                        placeholder={t('搜索会话')}
                        onChange={(event) => setSessionQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (isImeEvent(event)) return
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setSessionQuery('')
                            return
                          }
                          if (event.key !== 'Enter' || isImeEnter(event)) return
                          event.preventDefault()
                          const target = searchResults[0] ?? visibleSessions[0]
                          if (!target) return
                          if ('filePath' in target) {
                            void loadSession({
                              filePath: target.filePath,
                              sessionId: target.sessionId,
                              ...(target.name ? { name: target.name } : {}),
                              firstPrompt: target.firstPrompt,
                              startedAt: new Date(target.mtime).toISOString(),
                              modelId: '',
                              mtime: target.mtime,
                            })
                          }
                        }}
                      />
                    </div>
                  </div>
                  <button
                    className={`sidebar-archived-toggle ${showArchived ? 'active' : ''}`}
                    onClick={() => setShowArchived((value) => !value)}
                  >
                    {showArchived ? t('隐藏归档') : t('显示归档')}
                  </button>
                  <div className="sidebar-sessions">
                    {showPendingSession ? (
                      <div className="sidebar-session sidebar-session-placeholder active">
                        <span className="sidebar-session-title">
                          {tabTitles[pendingSession?.sessionId ?? ''] || t('新会话')}
                        </span>
                        <span className="sidebar-session-meta">{t('刚刚')}</span>
                      </div>
                    ) : null}
                    {loading && visibleSessions.length === 0 && !showPendingSession ? <SidebarSkeleton /> : null}
                    {!loading && visibleSessions.length === 0 && !showPendingSession ? (
                      <div className="sidebar-empty">
                        <span>{sessionQuery.trim() ? t('没有匹配的会话') : t('暂无会话')}</span>
                        {sessionQuery.trim() ? (
                          <button className="btn btn-quiet" onClick={() => setSessionQuery('')}>
                            {t('清除搜索')}
                          </button>
                        ) : (
                          <button className="btn btn-quiet" onClick={() => void newSession()}>
                            {t('新建会话')}
                          </button>
                        )}
                      </div>
                    ) : null}
                    {visibleSessions.slice(0, 100).map((item, index, list) => {
                      const now = Date.now()
                      const group = sessionDayGroup(item.mtime, now, item.pinned === true)
                      const previous =
                        index > 0
                          ? sessionDayGroup(list[index - 1]!.mtime, now, list[index - 1]!.pinned === true)
                          : null
                      const groupLabel = {
                        pinned: t('置顶'),
                        today: t('今天'),
                        yesterday: t('昨天'),
                        week: t('本周'),
                        earlier: t('更早'),
                      }[group]
                      const groupCount = list.filter(
                        (row) => sessionDayGroup(row.mtime, now, row.pinned === true) === group,
                      ).length
                      return (
                        <Fragment key={item.sessionId}>
                          {group !== previous ? (
                            <div className="sidebar-day">
                              <span>{groupLabel}</span>
                              <span className="sidebar-day-count">{groupCount}</span>
                            </div>
                          ) : null}
                          <div
                            className={`sidebar-session-row ${activeSessionId === item.sessionId ? 'active' : ''}`}
                            data-session-id={item.sessionId}
                          >
                            {renaming?.filePath === item.filePath ? (
                              <input
                                className="sidebar-rename"
                                autoFocus
                                value={renaming.value}
                                onChange={(event) =>
                                  setRenaming({ filePath: item.filePath, value: event.target.value })
                                }
                                onKeyDown={(event) => {
                                  if (isImeEvent(event)) return
                                  if (event.key === 'Enter') {
                                    if (isImeEnter(event)) return
                                    event.preventDefault()
                                    void commitRename()
                                  }
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    renameCancelRef.current = true
                                    setRenaming(null)
                                    renameCancelRef.current = false
                                  }
                                }}
                                onBlur={() => {
                                  if (renaming) void commitRename()
                                }}
                              />
                            ) : (
                              <>
                                <button
                                  className="sidebar-session"
                                  title={sessionTitle(item)}
                                  onClick={() => void loadSession(item)}
                                >
                                  <span className="sidebar-session-title">
                                    {runningSessionIds.has(item.sessionId) ? (
                                      <span
                                        className="sidebar-session-running"
                                        title={t('正在运行')}
                                        aria-label={t('正在运行')}
                                      />
                                    ) : null}
                                    {item.pinned ? '★ ' : ''}
                                    {sessionTitle(item)}
                                  </span>
                                  <span className="sidebar-session-meta">{sessionTime(item)}</span>
                                </button>
                                <span className="sidebar-session-actions">
                                  {deletingSession === item.filePath ? (
                                    <>
                                      <button
                                        className="session-action danger"
                                        onClick={() => void confirmDeleteSession(item)}
                                      >
                                        {t('确认')}
                                      </button>
                                      <button className="session-action" onClick={() => setDeletingSession(null)}>
                                        {t('取消')}
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="session-action session-menu-toggle"
                                      data-testid="session-menu-toggle"
                                      title={t('更多操作')}
                                      aria-label={t('更多操作')}
                                      onClick={(event) => {
                                        const rect = event.currentTarget.getBoundingClientRect()
                                        setSessionMenu({
                                          filePath: item.filePath,
                                          x: Math.max(8, Math.min(window.innerWidth - 188, rect.right - 180)),
                                          y: Math.max(8, Math.min(window.innerHeight - 190, rect.bottom + 4)),
                                        })
                                      }}
                                    >
                                      ⋯
                                    </button>
                                  )}
                                </span>
                              </>
                            )}
                          </div>
                        </Fragment>
                      )
                    })}
                    {sessionQuery.trim().length >= 2 ? (
                      <div className="sidebar-search-results" data-testid="session-search-results">
                        <div className="sidebar-search-head">
                          {searchingSessions
                            ? t('全文搜索中…')
                            : t('全文匹配 {{count}}', { count: searchResults.length })}
                        </div>
                        {!searchingSessions && searchResults.length === 0 ? (
                          <div className="sidebar-empty">
                            <span>{t('没有匹配的全文内容')}</span>
                            <button className="btn btn-quiet" onClick={() => setSessionQuery('')}>
                              {t('清除搜索')}
                            </button>
                          </div>
                        ) : null}
                        {extraSearchResults.map((result) => (
                          <button
                            key={result.filePath}
                            className="sidebar-search-hit"
                            onClick={() =>
                              void loadSession({
                                filePath: result.filePath,
                                sessionId: result.sessionId,
                                ...(result.name ? { name: result.name } : {}),
                                firstPrompt: result.firstPrompt,
                                startedAt: new Date(result.mtime).toISOString(),
                                modelId: '',
                                mtime: result.mtime,
                              })
                            }
                          >
                            <span className="sidebar-search-name">
                              {result.name || result.firstPrompt || result.sessionId}
                            </span>
                            <span className="sidebar-search-snippet">{result.snippet}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="tree-children tree-children-other">
                  {othersLoading && group.sessions.length === 0 ? <SidebarSkeleton rows={2} /> : null}
                  {!othersLoading && group.sessions.length === 0 ? (
                    <div className="sidebar-empty">
                      <span>{t('暂无会话')}</span>
                      <button className="btn btn-quiet" onClick={() => void newWorkspaceSession(group.path)}>
                        {t('新建会话')}
                      </button>
                      <button className="btn btn-quiet" onClick={() => void openWorkspaceWindow(group.path)}>
                        {t('在新窗口打开')}
                      </button>
                    </div>
                  ) : (
                    group.sessions.map((item) => (
                      <button
                        key={item.sessionId}
                        className="tree-session"
                        title={sessionTitle(item)}
                        onClick={() => void openWorkspaceSession(group.path, item.filePath)}
                      >
                        <span className="sidebar-session-title">
                          {runningOther[group.path]?.includes(item.sessionId) ? (
                            <span className="sidebar-session-running" aria-hidden="true" />
                          ) : null}
                          {item.pinned ? '★ ' : ''}
                          {sessionTitle(item)}
                        </span>
                        <span className="sidebar-session-meta">{sessionTime(item)}</span>
                      </button>
                    ))
                  )}
                </div>
              )
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
