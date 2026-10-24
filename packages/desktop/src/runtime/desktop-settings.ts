import fs from 'node:fs'
import path from 'node:path'

import { userXcodeDir } from '@x-code-cli/core'

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
  projectSettings?: Record<string, ProjectOverrides>
  trustedProjectHooks?: string[]
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
        projectSettings: normalizeProjectSettings(data.projectSettings),
        trustedProjectHooks: Array.isArray(data.trustedProjectHooks)
          ? data.trustedProjectHooks
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => path.resolve(entry))
          : [],
      }
    }
  } catch {
    // Missing or malformed file.
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
