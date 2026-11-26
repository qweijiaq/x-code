// @x-code-cli/desktop — renderer 的本地偏好存储
//
// 草稿、最近文档和首用清单都只是 localStorage 便利功能；集中在这里，
// 避免 App.tsx 的渲染逻辑和存储键名混在一起。
import { isUiSmoke } from './ui-smoke.js'

export function draftStorageKey(sessionId: string | null): string {
  return `xcode.draft.${sessionId ?? 'new'}`
}

const LAST_DOCUMENTS_KEY = 'xcode.lastDocuments'

// localStorage 里的内容可能被手工改坏、被旧版本写成 `null`/数组等非普通对象；
// 统一在这里收窄，避免下游 `parsed[workspace] = ...` 在严格模式下抛 TypeError
// 导致「记住上次文档」永久失效且无法自愈。
function readLastDocuments(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(LAST_DOCUMENTS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function readLastDocument(workspace: string): string | null {
  if (!workspace) return null
  const value = readLastDocuments()[workspace]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

export function rememberLastDocument(workspace: string, filePath: string): void {
  if (!workspace || !filePath) return
  try {
    const parsed = readLastDocuments()
    parsed[workspace] = filePath
    localStorage.setItem(LAST_DOCUMENTS_KEY, JSON.stringify(parsed))
  } catch {
    // 记住上次文档只是便利功能。
  }
}

export function forgetLastDocument(workspace: string, filePath: string): void {
  if (!workspace) return
  try {
    const parsed = readLastDocuments()
    if (parsed[workspace] !== filePath) return
    delete parsed[workspace]
    localStorage.setItem(LAST_DOCUMENTS_KEY, JSON.stringify(parsed))
  } catch {
    // 忽略。
  }
}

export type UsageKey = 'attach' | 'screenshot' | 'document' | 'palette' | 'skill'

const USAGE_KEY = isUiSmoke ? 'xcode.smoke.usage.v1' : 'xcode.usage.v1'
export const USAGE_DISMISSED_KEY = isUiSmoke ? 'xcode.smoke.usage.dismissed' : 'xcode.usage.dismissed'

export function readUsage(): Record<UsageKey, boolean> {
  const empty: Record<UsageKey, boolean> = {
    attach: false,
    screenshot: false,
    document: false,
    palette: false,
    skill: false,
  }
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<UsageKey, unknown>>) : {}
    for (const key of Object.keys(empty) as UsageKey[]) empty[key] = parsed[key] === true
  } catch {
    // 损坏的使用记录不应阻塞清单。
  }
  return empty
}

export function writeUsage(usage: Record<UsageKey, boolean>): void {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
  } catch {
    // 忽略配额错误。
  }
}
