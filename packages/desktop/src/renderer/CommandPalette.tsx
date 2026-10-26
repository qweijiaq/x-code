import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { RuntimeRequest, RuntimeResponse, SessionListItem, WorkspaceFileItem } from '../shared/protocol.js'

export interface PaletteCommand {
  name: string
  description: string
  run: () => void | Promise<void>
}

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  /** 额外搜索词（同义词、英文名、示例）。 */
  keywords?: string[]
  run: () => void | Promise<void>
}

interface Props {
  open: boolean
  actions: PaletteAction[]
  sessions: SessionListItem[]
  commands: PaletteCommand[]
  onSession: (item: SessionListItem) => void
  onClose: () => void
}

interface Row {
  key: string
  group: string
  label: string
  hint: string
  run: () => void | Promise<void>
}

async function searchFiles(query: string): Promise<WorkspaceFileItem[]> {
  const request: RuntimeRequest = {
    id: crypto.randomUUID(),
    method: 'workspace:files',
    params: { query, limit: 8 },
  }
  const response: RuntimeResponse = await window.xcode.request(request)
  return response.ok ? (response.result as { files: WorkspaceFileItem[] }).files : []
}

export function CommandPalette({
  open,
  actions,
  sessions,
  commands,
  onSession,
  onClose,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [files, setFiles] = useState<WorkspaceFileItem[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      void searchFiles(trimmed).then((result) => {
        if (!cancelled) setFiles(result)
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  if (!open) return null

  const trimmed = query.trim().toLowerCase()
  const matches = (value: string): boolean => !trimmed || value.toLowerCase().includes(trimmed)

  const actionRows: Row[] = actions
    .filter(
      (action) =>
        matches(action.label) ||
        matches(action.hint ?? '') ||
        (action.keywords ?? []).some((keyword) => matches(keyword)),
    )
    .map((action) => ({
      key: `action:${action.id}`,
      group: t('操作'),
      label: action.label,
      hint: action.hint ?? '',
      run: action.run,
    }))
  const commandRows: Row[] = commands
    .filter((command) => matches(command.name) || matches(command.description))
    .map((command) => ({
      key: `command:${command.name}`,
      group: t('命令'),
      label: command.name,
      hint: command.description,
      run: command.run,
    }))
  const sessionRows: Row[] = sessions
    .filter((item) => matches(item.name ?? item.firstPrompt ?? item.sessionId))
    .slice(0, 8)
    .map((item) => ({
      key: `session:${item.sessionId}`,
      group: t('会话'),
      label: item.name || item.firstPrompt || item.sessionId,
      hint: item.firstPrompt && item.name ? item.firstPrompt : '',
      run: () => onSession(item),
    }))
  const fileRows: Row[] = (trimmed.length >= 2 ? files : []).map((file) => ({
    key: `file:${file.path}`,
    group: t('文件'),
    label: file.relative,
    hint: file.isDirectory ? t('目录') : '',
    run: () => {
      onClose()
      // 先关闭命令面板，让文件面板可以获取焦点。
      setTimeout(() => window.dispatchEvent(new CustomEvent('xcode:open-file', { detail: file.path })), 0)
    },
  }))

  const rows = [...actionRows, ...commandRows, ...sessionRows, ...fileRows]
  const active = rows[Math.min(index, Math.max(0, rows.length - 1))]

  const runRow = (row: Row): void => {
    onClose()
    setTimeout(() => void row.run(), 0)
  }

  const move = (delta: number): void => {
    if (rows.length === 0) return
    const next = (index + delta + rows.length) % rows.length
    setIndex(next)
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  let lastGroup = ''
  return (
    <div className="modal-scrim palette-scrim" onClick={onClose}>
      <div
        className="palette-card"
        data-testid="command-palette"
        role="dialog"
        aria-label={t('命令面板')}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          data-testid="palette-input"
          value={query}
          placeholder={t('搜索命令、会话、文件或操作…')}
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (active) runRow(active)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 ? <div className="palette-empty">{t('没有匹配的结果')}</div> : null}
          {rows.map((row, rowIndex) => {
            const showGroup = row.group !== lastGroup
            lastGroup = row.group
            return (
              <div key={row.key}>
                {showGroup ? <div className="palette-group">{row.group}</div> : null}
                <button
                  className={`palette-row ${rowIndex === index ? 'active' : ''}`}
                  data-row-index={rowIndex}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    runRow(row)
                  }}
                  onMouseEnter={() => setIndex(rowIndex)}
                >
                  <span className="palette-label">{row.label}</span>
                  {row.hint ? <span className="palette-hint">{row.hint}</span> : null}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">
          <span>↑↓ {t('选择')}</span>
          <span>↵ {t('执行')}</span>
          <span>Esc {t('关闭')}</span>
        </div>
      </div>
    </div>
  )
}
