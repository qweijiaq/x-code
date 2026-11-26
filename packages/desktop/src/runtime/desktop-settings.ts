import { flockSync } from 'fs-ext-extra-prebuilt'

import fs from 'node:fs'
import path from 'node:path'

import { MIN_CONTEXT_WINDOW_OVERRIDE, WEB_SEARCH_PROVIDERS, debugLog, userXcodeDir } from '@x-code-cli/core'

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
  autoFixChecks?: boolean
  autoCodeIndex?: boolean
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
    // 相对路径会随启动时的 cwd 漂移成不同键，覆盖设置静默失效：只接受绝对路径。
    if (!path.isAbsolute(key)) continue
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

/** 首次启动（文件不存在）时的默认值。形状必须与正常路径完全一致：
 *  `saveDesktopSettings` / `updateDesktopSettings` 用 `{ ...current, ...patch }`
 *  整体写回，缺一个字段就等于把用户已存的
 *  sessionTitles / projectSettings / pinnedSessions / contextWindowOverrides
 *  等静默清空（且不可恢复）。 */
const EMPTY_SETTINGS: DesktopSettingsFile = {
  disabledTools: [],
  autoAllowedTools: [],
  alwaysAllowAll: false,
  recentProjects: [],
  pinnedSessions: [],
  archivedSessions: [],
  sessionTitles: {},
  projectSettings: {},
  trustedProjectHooks: [],
  contextWindowOverrides: {},
  librarySemantic: false,
  autoChecks: false,
  autoFixChecks: false,
  autoCodeIndex: false,
  // 与正常路径的 `data.x !== false` 归一化保持一致。
  shellSandbox: true,
  shellSandboxNetwork: false,
  shellSandboxExtensions: false,
  notifications: true,
  onboarded: false,
}

/** 把无法解析的文件搬成 `.bak`，绝不静默丢弃。 */
function quarantineCorruptSettings(file: string, reason: unknown): void {
  debugLog('settings.corrupt', reason instanceof Error ? reason.message : String(reason))
  try {
    let backup = `${file}.bak`
    for (let index = 1; fs.existsSync(backup) && index < 100; index++) backup = `${file}.bak-${index}`
    fs.renameSync(file, backup)
  } catch (error) {
    debugLog('settings.corrupt-backup-failed', error instanceof Error ? error.message : String(error))
  }
}

export function loadDesktopSettings(): DesktopSettingsFile {
  const file = settingsPath()
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
  } catch (error) {
    // 只有「文件不存在」才是首次启动。其它 I/O 错误（EACCES/EBUSY/EIO…）必须
    // 让写路径放弃落盘：用默认值顶替再写回，等于清空用户全部设置。
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ...EMPTY_SETTINGS }
    if (code !== undefined) throw error
    // 解析失败（无 errno）属于文件损坏：备份后按默认值启动，用户仍可找回。
    quarantineCorruptSettings(file, error)
    return { ...EMPTY_SETTINGS }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    {
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
        autoFixChecks: data.autoFixChecks === true,
        autoCodeIndex: data.autoCodeIndex === true,
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
        // 同上：相对路径按 cwd 解析会让同一个项目在不同启动下变成不同键。
        trustedProjectHooks: Array.isArray(data.trustedProjectHooks)
          ? data.trustedProjectHooks.filter(
              (entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry),
            )
          : [],
        contextWindowOverrides: normalizeContextWindowOverrides(data.contextWindowOverrides),
        searchProvider: normalizeSearchProvider(data.searchProvider),
      }
    }
  }
  // 合法 JSON 但不是对象：同样按损坏处理（备份后重新开始）。
  quarantineCorruptSettings(file, 'settings file is not a JSON object')
  return { ...EMPTY_SETTINGS }
}

/**
 * 多窗口是多个 utilityProcess，各自 read-modify-write 同一个 JSON。
 * 用操作系统级 flock 把「重新读取 → 合并 → rename」包成原子段，避免两个
 * 窗口同时保存不同字段时后写覆盖前写。
 */
let settingsLockDepth = 0

function withSettingsLock<T>(fn: () => T): T {
  // flock 关联的是 open file description，同进程另开一个 fd 同样互斥：如果
  // mutate 回调里再次调用 save/update，会永久阻塞（且没有超时）。已经在锁内
  // 就直接执行。mutate 回调本身仍然不应该嵌套调用这两个公开 API。
  if (settingsLockDepth > 0) return fn()
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lockFile = `${file}.lock`
  const fd = fs.openSync(lockFile, 'a+', 0o600)
  settingsLockDepth += 1
  try {
    flockSync(fd, 'ex')
    return fn()
  } finally {
    settingsLockDepth -= 1
    try {
      flockSync(fd, 'un')
    } catch {
      // 解锁失败不掩盖原始错误。
    }
    fs.closeSync(fd)
  }
}

export function saveDesktopSettings(update: DesktopSettingsFile): void {
  withSettingsLock(() => {
    const file = settingsPath()
    const data: DesktopSettingsFile = { ...loadDesktopSettings(), ...update }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmp, file)
  })
}

/**
 * 在锁内做 read-modify-write。容器字段（sessionTitles / projectSettings /
 * contextWindowOverrides / trustedProjectHooks / recentProjects …）必须走这里：
 * 在锁外 `loadDesktopSettings()` 再整体 `saveDesktopSettings()`，两个窗口都会
 * 基于同一份旧值追加，后写的那个会覆盖前一个——`saveDesktopSettings` 的字段级
 * 合并不适用于 Record/数组内部的条目。
 *
 * 返回 null 表示没有变化，此时不落盘。
 */
export function updateDesktopSettings(
  mutate: (current: DesktopSettingsFile) => Partial<DesktopSettingsFile> | null,
): void {
  withSettingsLock(() => {
    const current = loadDesktopSettings()
    const patch = mutate(current)
    if (!patch) return
    const file = settingsPath()
    const data: DesktopSettingsFile = { ...current, ...patch }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmp, file)
  })
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
