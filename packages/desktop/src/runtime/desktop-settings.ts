import fs from 'node:fs'
import path from 'node:path'

import { MIN_CONTEXT_WINDOW_OVERRIDE, WEB_SEARCH_PROVIDERS, userXcodeDir } from '@x-code-cli/core'

export interface ProjectOverrides {
  modelId?: string
  taskMode?: string
  autoChecks?: boolean
}

interface DesktopSettingsFile {
  disabledTools?: string[]
  autoAllowedTools?: string[]
  alwaysAllowAll?: boolean
  recentProjects?: string[]
  lastWorkspace?: string
  customModelId?: string
  librarySemantic?: boolean
  libraryRoot?: string
  taskMode?: string
  autoChecks?: boolean
  shellSandbox?: boolean
  shellSandboxNetwork?: boolean
  shellSandboxExtensions?: boolean
  notifications?: boolean
  onboarded?: boolean
  updateFeed?: string
  pinnedSessions?: string[]
  archivedSessions?: string[]
  sessionTitles?: Record<string, string>
  projectSettings?: Record<string, ProjectOverrides>
  trustedProjectHooks?: string[]
  contextWindowOverrides?: Record<string, number>
  searchProvider?: string
}

const STANDALONE_SEARCH_IDS = new Set(
  WEB_SEARCH_PROVIDERS.filter((provider) => !provider.modelKeyOnly).map((provider) => provider.id),
)

function normalizeSearchProvider(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim().toLowerCase()
  return STANDALONE_SEARCH_IDS.has(id) ? id : undefined
}

function normalizeSessionTitles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!sessionId.trim() || typeof value !== 'string') continue
    const title = value.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (title) out[sessionId] = title
  }
  return out
}

function normalizeContextWindowOverrides(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [modelId, tokens] of Object.entries(raw as Record<string, unknown>)) {
    if (!modelId.trim()) continue
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= MIN_CONTEXT_WINDOW_OVERRIDE) {
      out[modelId] = tokens
    }
  }
  return out
}

function settingsPath(): string {
  return path.join(userXcodeDir(), 'desktop-settings.json')
}

function normalizeProjectSettings(raw: unknown): Record<string, ProjectOverrides> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ProjectOverrides> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const overrides: ProjectOverrides = {}
    if (typeof entry.modelId === 'string' && entry.modelId.trim()) overrides.modelId = entry.modelId.trim()
    if (typeof entry.taskMode === 'string' && entry.taskMode.trim()) overrides.taskMode = entry.taskMode.trim()
    if (typeof entry.autoChecks === 'boolean') overrides.autoChecks = entry.autoChecks
    out[path.resolve(key)] = overrides
  }
  return out
}

export function loadDesktopSettings(): DesktopSettingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const data = parsed as DesktopSettingsFile
      return {
        disabledTools: Array.isArray(data.disabledTools)
          ? data.disabledTools.filter((name): name is string => typeof name === 'string')
          : [],
        autoAllowedTools: Array.isArray(data.autoAllowedTools)
          ? data.autoAllowedTools.filter((name): name is string => typeof name === 'string')
          : [],
        alwaysAllowAll: data.alwaysAllowAll === true,
        recentProjects: Array.isArray(data.recentProjects)
          ? data.recentProjects.filter((entry): entry is string => typeof entry === 'string')
          : [],
        lastWorkspace: typeof data.lastWorkspace === 'string' ? data.lastWorkspace : undefined,
        customModelId: typeof data.customModelId === 'string' ? data.customModelId : undefined,
        librarySemantic: data.librarySemantic === true,
        libraryRoot: typeof data.libraryRoot === 'string' ? data.libraryRoot : undefined,
        taskMode: typeof data.taskMode === 'string' ? data.taskMode : undefined,
        autoChecks: data.autoChecks === true,
        shellSandbox: data.shellSandbox !== false,
        shellSandboxNetwork: data.shellSandboxNetwork === true,
        shellSandboxExtensions: data.shellSandboxExtensions === true,
        notifications: data.notifications !== false,
        onboarded: data.onboarded === true,
        updateFeed: typeof data.updateFeed === 'string' ? data.updateFeed : undefined,
        pinnedSessions: Array.isArray(data.pinnedSessions)
          ? data.pinnedSessions.filter((entry): entry is string => typeof entry === 'string')
          : [],
        archivedSessions: Array.isArray(data.archivedSessions)
          ? data.archivedSessions.filter((entry): entry is string => typeof entry === 'string')
          : [],
        sessionTitles: normalizeSessionTitles(data.sessionTitles),
        projectSettings: normalizeProjectSettings(data.projectSettings),
        trustedProjectHooks: Array.isArray(data.trustedProjectHooks)
          ? data.trustedProjectHooks
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => path.resolve(entry))
          : [],
        contextWindowOverrides: normalizeContextWindowOverrides(data.contextWindowOverrides),
        searchProvider: normalizeSearchProvider(data.searchProvider),
      }
    }
  } catch {
    // 文件缺失或格式损坏。
  }
  return { disabledTools: [], autoAllowedTools: [], alwaysAllowAll: false, recentProjects: [] }
}

export function saveDesktopSettings(update: DesktopSettingsFile): void {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const data: DesktopSettingsFile = { ...loadDesktopSettings(), ...update }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, file)
}

let searchProviderOriginal: string | undefined
let searchProviderCaptured = false

/** 把核心的 webSearch 覆盖指向用户偏好的 provider。空偏好
 *  恢复 shell/.env 提供的值，因此 CLI 风格的 env
 *  覆盖继续有效。 */
export function applySearchProviderPreference(provider: string | undefined): void {
  if (!searchProviderCaptured) {
    searchProviderOriginal = process.env.X_CODE_WEB_SEARCH_PROVIDER
    searchProviderCaptured = true
  }
  if (provider) {
    process.env.X_CODE_WEB_SEARCH_PROVIDER = provider
  } else if (searchProviderOriginal === undefined) {
    delete process.env.X_CODE_WEB_SEARCH_PROVIDER
  } else {
    process.env.X_CODE_WEB_SEARCH_PROVIDER = searchProviderOriginal
  }
}
