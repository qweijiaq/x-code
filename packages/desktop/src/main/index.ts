import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} from 'electron'
import type { UtilityProcess } from 'electron'

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  RuntimeInbound,
  RuntimeOutbound,
  RuntimeRequest,
  RuntimeResponse,
  SmokeReport,
} from '../shared/protocol.js'

const isSmoke = process.argv.includes('--smoke-test')
const isUiSmoke = process.argv.includes('--ui-smoke')
const isHeadlessSmoke = isSmoke || isUiSmoke

// Headless smokes must not read or mutate the user's real ~/.x-code settings
// or secrets. An isolated home also makes approval-related checks
// deterministic regardless of the user's persisted trust settings.
if (isHeadlessSmoke) {
  const smokeHome = path.join(os.tmpdir(), 'xcode-desktop-smoke-home')
  process.env.X_CODE_HOME = smokeHome
  try {
    fs.rmSync(smokeHome, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup.
  }
  // Sessions, plugins, and workspace scans resolve against the workspace.
  // Keep them inside the disposable smoke home so a test run never writes
  // into the user's project.
  const smokeWorkspace = path.join(smokeHome, 'workspace')
  fs.mkdirSync(path.join(smokeWorkspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(smokeWorkspace, 'README.md'), '# Smoke workspace\n\nAttachment smoke content.\n')
  fs.writeFileSync(path.join(smokeWorkspace, 'notes.md'), '# Notes\n\nSecond file for the @ menu.\n')
  fs.writeFileSync(path.join(smokeWorkspace, 'src', 'example.ts'), 'export const answer = 42\n')
  fs.writeFileSync(path.join(smokeWorkspace, 'data.csv'), 'name,dept,amount\nAda,eng,100\nBob,ops,70\n')
  fs.writeFileSync(
    path.join(smokeWorkspace, 'package.json'),
    JSON.stringify(
      {
        name: 'smoke-project',
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(1)"',
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ) + '\n',
  )
  fs.mkdirSync(path.join(smokeWorkspace, '.smoke-plugin'), { recursive: true })
  fs.writeFileSync(
    path.join(smokeWorkspace, '.smoke-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: 'smoke-plugin',
        version: '1.0.0',
        description: 'Smoke userConfig plugin',
        userConfig: [
          { key: 'SMOKE_TOKEN', type: 'string', sensitive: true, prompt: 'Token' },
          { key: 'SMOKE_REGION', type: 'string', default: 'cn', prompt: 'Region' },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const pdfFixture = path.join(__dirname, '../../tests/fixtures/smoke.pdf')
  if (fs.existsSync(pdfFixture)) fs.copyFileSync(pdfFixture, path.join(smokeWorkspace, 'sample.pdf'))
  // A real repository lets the UI smoke exercise the Git panel and per-turn
  // checkpoints. Git is a dev dependency of these smokes; failures are ignored.
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'Smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
      GIT_TERMINAL_PROMPT: '0',
    }
    execFileSync('git', ['init', '-q'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['add', '-A'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['commit', '-q', '-m', 'smoke fixtures'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['branch', 'smoke-branch'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['branch', 'smoke-remove'], { cwd: smokeWorkspace, env })
    execFileSync('git', ['update-ref', 'refs/remotes/origin/smoke-remote', 'HEAD'], {
      cwd: smokeWorkspace,
      env,
    })
  } catch {
    // Git unavailable: the Git panel check reports the workspace as non-repo.
  }
  process.env.X_CODE_WORKSPACE = smokeWorkspace
  process.env.X_CODE_EXPORT_DIR = path.join(smokeHome, 'exports')
}
const REQUEST_TIMEOUT_MS = 120_000
const IMAGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_PREVIEW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
const LONG_REQUEST_TIMEOUT_MS = 15 * 60_000

/** Agent turns and document/network work can legitimately outlive the default
 *  IPC timeout. `agent:submit` has no timer at all: its response arrives when
 *  the turn ends, and the runtime's exit path rejects pending requests. */
function timeoutFor(method: string): number | null {
  if (method === 'agent:submit') return null
  if (
    method.startsWith('plugins:') ||
    method.startsWith('settings:marketplace') ||
    method.startsWith('skills:install') ||
    method === 'settings:mcp-auth' ||
    method === 'library:index' ||
    method === 'library:search' ||
    method === 'checks:run' ||
    method === 'audio:transcribe' ||
    method === 'session:export'
  ) {
    return LONG_REQUEST_TIMEOUT_MS
  }
  // These re-bootstrap providers/plugins/MCP servers for a workspace, and an
  // MCP server that is slow to hand-shake is normal, not a hung request.
  if (
    method === 'workspace:switch' ||
    method === 'settings:reload' ||
    method === 'settings:mcp-reload' ||
    method === 'settings:mcp-trust-project'
  ) {
    return LONG_REQUEST_TIMEOUT_MS
  }
  if (method === 'agent:compact') return 10 * 60_000
  if (method === 'smoke:run') return 5 * 60_000
  return REQUEST_TIMEOUT_MS
}

let mainWindow: BrowserWindow | null = null
let primaryWindowId: number | null = null
let smokeFinished = false

interface PendingRequest {
  resolve: (response: RuntimeResponse) => void
  timer?: NodeJS.Timeout
}

interface RuntimeContext {
  window: BrowserWindow
  runtime: UtilityProcess | null
  ready: boolean
  readyWaiters: Array<() => void>
  pending: Map<string, PendingRequest>
  /** Workspace explicitly requested when this window was created. */
  workspacePath?: string
  /** Workspace reported by the runtime after initialization. */
  workspace?: string
  /** Session files open in this window's tabs (canonical paths). */
  sessionFiles: Set<string>
}

/** Every window owns its own AgentHost runtime so sessions can run in
 *  parallel without sharing a turn/busy flag. */
const runtimeContexts = new Map<number, RuntimeContext>()

function contextForWindow(window: BrowserWindow | null | undefined): RuntimeContext | null {
  if (!window || window.isDestroyed()) return null
  return runtimeContexts.get(window.id) ?? null
}

function activeContext(): RuntimeContext | null {
  return contextForWindow(mainWindow) ?? [...runtimeContexts.values()][0] ?? null
}

function windowForSender(sender: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender) ?? mainWindow
}

function log(...args: unknown[]): void {
  console.log('[main]', ...args)
}

function runtimeVersions(): Record<string, string> {
  return {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  }
}

function failPending(context: RuntimeContext, code: string, message: string): void {
  for (const [id, entry] of context.pending) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve({ id, ok: false, error: { code, message } })
  }
  context.pending.clear()
}

/** Render HTML to PDF with a hidden window. Used by the runtime's
 *  documentExport tool through the main-request channel. */
async function renderPdfBase64(html: string): Promise<string> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF rendering timed out')), 30_000)
    })
    await Promise.race([window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`), timeout])
    const pdf = await Promise.race([window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }), timeout])
    return pdf.toString('base64')
  } finally {
    if (timer) clearTimeout(timer)
    window.destroy()
  }
}

function currentAppVersion(): string {
  if (app.isPackaged) return app.getVersion()
  // Unpackaged Electron reports Electron's own version; the desktop package's
  // version is the one users compare against a release feed.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')) as {
      version?: string
    }
    if (pkg.version) return pkg.version
  } catch {
    // Fall through to Electron's version.
  }
  return app.getVersion()
}

function onRuntimeMessage(message: RuntimeOutbound, context: RuntimeContext): void {
  if (!message || typeof message !== 'object') return

  if (message.kind === 'main-request') {
    void (async () => {
      const reply = (payload: { ok: true; result: unknown } | { ok: false; error: string }): void => {
        try {
          context.runtime?.postMessage({ kind: 'main-response', id: message.id, ...payload })
        } catch {
          // Runtime is already gone.
        }
      }
      try {
        if (message.method === 'app:notify') {
          const title = typeof message.params?.title === 'string' ? message.params.title : ''
          const body = typeof message.params?.body === 'string' ? message.params.body : ''
          if (!title) throw new Error('Notification title is required')
          // Smoke runs must stay silent and headless CI has no notification
          // permission; the focused window also makes the notification noise.
          if (
            isSmoke ||
            isUiSmoke ||
            !Notification.isSupported() ||
            context.window.isDestroyed() ||
            context.window.isFocused()
          ) {
            reply({ ok: true, result: { shown: false } })
            return
          }
          const notification = new Notification({ title: title.slice(0, 120), body: body.slice(0, 400) })
          const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined
          notification.on('click', () => {
            if (context.window.isDestroyed()) return
            if (context.window.isMinimized()) context.window.restore()
            context.window.show()
            context.window.focus()
            if (sessionId) {
              context.window.webContents.send('runtime:event', { type: 'app:open-session', sessionId })
            }
          })
          notification.show()
          reply({ ok: true, result: { shown: true } })
          return
        }
        if (message.method === 'app:reveal-path') {
          if (typeof message.params?.path !== 'string' || !message.params.path.trim()) {
            throw new Error('Invalid reveal path')
          }
          const target = path.resolve(message.params.path)
          if (!fs.existsSync(target)) {
            reply({ ok: true, result: { opened: false } })
            return
          }
          if (fs.statSync(target).isDirectory()) await shell.openPath(target)
          else shell.showItemInFolder(target)
          reply({ ok: true, result: { opened: true } })
          return
        }
        if (message.method === 'app:render-pdf') {
          if (typeof message.params?.html !== 'string' || message.params.html.length > 5_000_000) {
            throw new Error('Invalid PDF render payload')
          }
          reply({ ok: true, result: { data: await renderPdfBase64(message.params.html) } })
          return
        }
        if (message.method === 'app:safe-storage-status') {
          reply({ ok: true, result: { available: safeStorage.isEncryptionAvailable() } })
          return
        }
        if (message.method === 'app:safe-storage-encrypt' || message.method === 'app:safe-storage-decrypt') {
          if (typeof message.params?.data !== 'string') throw new Error('Invalid safeStorage payload')
          if (!safeStorage.isEncryptionAvailable()) {
            reply({ ok: true, result: { available: false } })
            return
          }
          if (message.method === 'app:safe-storage-encrypt') {
            if (message.params.data.length > 100_000) throw new Error('Secret is too large to store')
            const encrypted = safeStorage.encryptString(message.params.data)
            reply({ ok: true, result: { available: true, data: encrypted.toString('base64') } })
          } else {
            const decrypted = safeStorage.decryptString(Buffer.from(message.params.data, 'base64'))
            reply({ ok: true, result: { available: true, data: decrypted } })
          }
          return
        }
        throw new Error(`Unsupported main request: ${message.method}`)
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  if (message.kind === 'response') {
    const entry = context.pending.get(message.response.id)
    if (entry) {
      clearTimeout(entry.timer)
      context.pending.delete(message.response.id)
      entry.resolve(message.response)
    }
    return
  }

  if (message.kind === 'ready') {
    context.ready = true
    log(`runtime ready pid=${message.pid} node=${message.versions.node ?? '?'} window=${context.window.id}`)
    for (const waiter of context.readyWaiters.splice(0)) waiter()
    return
  }

  if (message.kind === 'event') {
    const event = message.event
    if (event.type === 'app:state') {
      const previous = context.workspace
      context.workspace = event.state.workspace
      if (context.workspacePath) {
        const next = canonicalDirectory(context.workspace)
        const changed = previous !== undefined && canonicalDirectory(previous) !== next
        context.workspacePath = next
        if (changed) saveOpenWorkspaceWindows()
      }
    }
    if (event.type === 'runtime:log') {
      log(`[runtime:${event.level}] ${event.message}`)
    }
    if (event.type === 'mcp:auth-url' && event.url.startsWith('https://')) {
      void shell.openExternal(event.url)
    }
    if (event.type === 'smoke:result' && isSmoke) {
      finishSmoke(event.report)
      return
    }
    if (!context.window.isDestroyed()) context.window.webContents.send('runtime:event', event)
  }
}

/** Directory with model files shipped inside the app (extraResources in
 *  packaged builds, build/whisper for local development). */
function bundledWhisperDir(): string | null {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'whisper') : path.join(__dirname, '../../build/whisper')
  return fs.existsSync(path.join(dir, 'ggml-tiny.bin')) ? dir : null
}

function spawnRuntime(context: RuntimeContext): void {
  if (context.runtime || context.window.isDestroyed()) return

  const runtimePath = path.join(__dirname, '../runtime/index.mjs')
  log(`spawning runtime: ${runtimePath} for window ${context.window.id}`)
  const whisperDir = bundledWhisperDir()

  context.runtime = utilityProcess.fork(runtimePath, [], {
    serviceName: 'X-Code Runtime',
    stdio: 'pipe',
    env: {
      ...process.env,
      X_CODE_DESKTOP: '1',
      ...(context.workspacePath ? { X_CODE_WINDOW_WORKSPACE: context.workspacePath } : {}),
      ...(whisperDir ? { X_CODE_WHISPER_BUNDLED_DIR: whisperDir } : {}),
    },
  })

  const child = context.runtime
  child.stdout?.on('data', (chunk: Buffer) => log(`[runtime:${context.window.id}:out] ${chunk.toString().trimEnd()}`))
  child.stderr?.on('data', (chunk: Buffer) => log(`[runtime:${context.window.id}:err] ${chunk.toString().trimEnd()}`))

  child.on('message', (message: RuntimeOutbound) => {
    try {
      onRuntimeMessage(message, context)
    } catch (error) {
      log('runtime message handler failed', error)
    }
  })

  child.on('exit', (code) => {
    log(`runtime exited code=${code} window=${context.window.id}`)
    if (context.runtime === child) context.runtime = null
    context.ready = false
    failPending(context, 'runtime-exited', `Runtime process exited (code ${code})`)
  })
}

function waitForRuntime(context: RuntimeContext): Promise<void> {
  if (context.ready) return Promise.resolve()
  spawnRuntime(context)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime did not become ready in time')), 30_000)
    context.readyWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function forwardRequest(
  request: RuntimeRequest,
  context: RuntimeContext | null = activeContext(),
): Promise<RuntimeResponse> {
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
    return Promise.resolve({
      id: 'invalid',
      ok: false,
      error: { code: 'invalid-request', message: 'Malformed runtime request' },
    })
  }
  if (!context) {
    return Promise.resolve({
      id: request.id,
      ok: false,
      error: { code: 'no-window', message: 'No application window is available' },
    })
  }

  if (!context.runtime) spawnRuntime(context)
  if (!context.runtime) {
    return Promise.resolve({
      id: request.id,
      ok: false,
      error: { code: 'runtime-unavailable', message: 'Runtime is not available' },
    })
  }

  return new Promise((resolve) => {
    const timeout = timeoutFor(request.method)
    const timer =
      timeout === null
        ? undefined
        : setTimeout(() => {
            context.pending.delete(request.id)
            resolve({
              id: request.id,
              ok: false,
              error: { code: 'timeout', message: `Runtime request timed out: ${request.method}` },
            })
          }, timeout)

    context.pending.set(request.id, { resolve, timer })
    const inbound: RuntimeInbound = { kind: 'request', request }
    context.runtime?.postMessage(inbound)
  })
}

interface SavedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): SavedWindowState | null {
  if (isHeadlessSmoke) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf-8')) as Partial<SavedWindowState>
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
    if (parsed.width < 600 || parsed.height < 400) return null
    return {
      ...(typeof parsed.x === 'number' ? { x: parsed.x } : {}),
      ...(typeof parsed.y === 'number' ? { y: parsed.y } : {}),
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      maximized: parsed.maximized === true,
    }
  } catch {
    return null
  }
}

function visibleOnSomeDisplay(state: SavedWindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false
  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea
    return (
      state.x! < x + width - 80 &&
      state.x! + state.width > x + 80 &&
      state.y! < y + height - 80 &&
      state.y! + state.height > y + 80
    )
  })
}

function saveWindowState(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || isHeadlessSmoke) return
  try {
    const bounds = window.getNormalBounds()
    const state: SavedWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: window.isMaximized(),
    }
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true })
    fs.writeFileSync(windowStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8')
  } catch {
    // Window state is a convenience only.
  }
}

let windowStateTimer: NodeJS.Timeout | null = null

function canonicalDirectory(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

let appQuitting = false

function openWorkspaceWindowsPath(): string {
  return path.join(app.getPath('userData'), 'open-workspaces.json')
}

/** Explicitly bound workspace windows (branch worktrees, moved sessions).
 *  Blank windows and the primary window are represented by lastWorkspace. */
function loadOpenWorkspaceWindows(): string[] {
  if (isHeadlessSmoke) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(openWorkspaceWindowsPath(), 'utf-8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
  } catch {
    return []
  }
}

function saveOpenWorkspaceWindows(): void {
  if (isHeadlessSmoke) return
  const workspaces = new Set<string>()
  for (const context of runtimeContexts.values()) {
    if (context.workspacePath) {
      workspaces.add(canonicalDirectory(context.workspace ?? context.workspacePath))
    }
  }
  try {
    fs.mkdirSync(path.dirname(openWorkspaceWindowsPath()), { recursive: true })
    fs.writeFileSync(openWorkspaceWindowsPath(), JSON.stringify([...workspaces], null, 2) + '\n', 'utf-8')
  } catch {
    // Workspace restoration is a convenience only.
  }
}

async function restoreWorkspaceWindows(primary: RuntimeContext): Promise<void> {
  const saved = loadOpenWorkspaceWindows()
  if (saved.length === 0) return
  const seen = new Set<string>()
  try {
    await waitForRuntime(primary)
    if (appQuitting) return
    const state = await forwardRequest({ id: `restore-${Date.now()}`, method: 'app:state', params: {} }, primary)
    if (!state.ok) return
    seen.add(canonicalDirectory((state.result as { workspace: string }).workspace))
  } catch {
    // Without the primary workspace we cannot tell whether a saved path is
    // already open; leave restoration for the next launch.
    return
  }
  for (const savedPath of saved) {
    try {
      if (!fs.statSync(savedPath).isDirectory()) continue
    } catch {
      continue
    }
    const workspace = canonicalDirectory(savedPath)
    if (seen.has(workspace)) continue
    seen.add(workspace)
    const query = new URLSearchParams({ fresh: '1', workspace })
    createWindow(true, query.toString(), workspace)
  }
  saveOpenWorkspaceWindows()
}

/** Requests that change settings shared by every window. After one succeeds,
 *  the other renderers reload their own runtime so keys, tools and plugin
 *  state do not silently diverge. */
const SHARED_SETTINGS_METHODS = new Set<string>([
  'settings:set-api-key',
  'settings:set-custom-model',
  'settings:clear-api-key',
  'settings:set-skill-enabled',
  'settings:set-tool-enabled',
  'settings:set-tool-always-allow',
  'settings:set-always-allow-all',
  'settings:set-notifications',
  'settings:set-onboarded',
  'settings:set-update-feed',
  'settings:set-shell-sandbox',
  'settings:mcp-trust-project',
  'settings:set-tool-profile',
  'settings:set-plugin-enabled',
  'settings:mcp-save',
  'settings:mcp-remove',
  'settings:marketplace-install',
  'settings:marketplace-add',
  'skills:import',
  'skills:install-command',
  'skills:remove',
  'plugins:import',
  'plugins:install-command',
  'plugins:install',
  'plugins:save-user-config',
  'plugins:uninstall',
  'hooks:save',
  'hooks:trust-project',
  'commands:save',
  'commands:delete',
  'memory:save-topic',
  'memory:delete-topic',
  'memory:reload',
  'project:save',
])

function broadcastSettingsChange(source: RuntimeContext): void {
  for (const entry of runtimeContexts.values()) {
    if (entry === source || entry.window.isDestroyed()) continue
    entry.window.webContents.send('runtime:event', { type: 'app:settings-changed' })
  }
}

function createWindow(show = true, search = '', workspacePath?: string): RuntimeContext {
  const saved = loadWindowState()
  const useSaved = saved !== null && visibleOnSomeDisplay(saved)
  const cascade = runtimeContexts.size * 28
  const window = new BrowserWindow({
    ...(useSaved && saved.x !== undefined && saved.y !== undefined
      ? { x: saved.x + cascade, y: saved.y + cascade }
      : {}),
    width: useSaved ? saved.width : 1280,
    height: useSaved ? saved.height : 820,
    minWidth: 900,
    minHeight: 600,
    show,
    backgroundColor: '#f6f2e8',
    title: 'X-Code',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window
  if (primaryWindowId === null) primaryWindowId = window.id
  const context: RuntimeContext = {
    window,
    runtime: null,
    ready: false,
    readyWaiters: [],
    pending: new Map(),
    ...(workspacePath ? { workspacePath } : {}),
    sessionFiles: new Set(),
  }
  runtimeContexts.set(window.id, context)
  spawnRuntime(context)
  if (workspacePath) saveOpenWorkspaceWindows()

  if (useSaved && saved.maximized && show && window.id === primaryWindowId) {
    window.once('ready-to-show', () => window.maximize())
  }

  const scheduleSave = (): void => {
    if (isHeadlessSmoke || window.id !== primaryWindowId) return
    if (windowStateTimer) clearTimeout(windowStateTimer)
    windowStateTimer = setTimeout(() => saveWindowState(window), 500)
  }
  window.on('resize', scheduleSave)
  window.on('move', scheduleSave)
  window.on('focus', () => {
    mainWindow = window
  })
  window.on('close', () => {
    if (isHeadlessSmoke || window.id !== primaryWindowId) return
    if (windowStateTimer) clearTimeout(windowStateTimer)
    saveWindowState(window)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  })

  window.on('closed', () => {
    // Approvals are fail-closed: a closed window must not leave a tool call
    // waiting on a decision that can never arrive.
    void forwardRequest({ id: `cancel-${Date.now()}`, method: 'approvals:cancel-all', params: {} }, context)
    context.runtime?.kill()
    runtimeContexts.delete(window.id)
    if (mainWindow === window) {
      mainWindow = [...runtimeContexts.values()].at(-1)?.window ?? null
    }
    if (primaryWindowId === window.id) {
      primaryWindowId = [...runtimeContexts.keys()][0] ?? null
    }
    if (!appQuitting) saveOpenWorkspaceWindows()
  })

  window.webContents.on('render-process-gone', () => {
    void forwardRequest({ id: `cancel-renderer-${Date.now()}`, method: 'approvals:cancel-all', params: {} }, context)
  })

  void window.loadFile(path.join(__dirname, '../renderer/index.html'), search ? { search } : undefined)
  return context
}

let tray: Tray | null = null

function showMainWindow(): void {
  const target =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : ([...runtimeContexts.values()].at(-1)?.window ?? null)
  if (!target) {
    createWindow()
    return
  }
  mainWindow = target
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function createTray(): void {
  if (isHeadlessSmoke || tray) return
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../build/icon.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return
  image = image.resize({ width: 16, height: 16 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('X-Code')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 X-Code', click: showMainWindow },
      {
        label: '新建会话',
        click: () => {
          showMainWindow()
          mainWindow?.webContents.send('runtime:event', { type: 'app:new-session' })
        },
      },
      { label: '新建窗口', click: () => createWindow(true) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  )
  tray.on('click', showMainWindow)
}

function finishSmoke(report: SmokeReport): void {
  // Only `--smoke-test` turns a diagnostics result into process exit. In the
  // normal app, the same event is forwarded to the renderer for display.
  if (!isSmoke) return
  if (smokeFinished) return
  smokeFinished = true
  // Machine-readable line consumed by scripts/check-desktop-smoke.
  console.log(`SMOKE_RESULT ${JSON.stringify(report)}`)
  const code = report.ok ? 0 : 1
  setTimeout(() => app.exit(code), 50)
}

async function runSmoke(): Promise<void> {
  try {
    const context = activeContext() ?? createWindow(false)
    await waitForRuntime(context)
    const response = await forwardRequest({ id: 'smoke-1', method: 'smoke:run', params: {} }, context)
    if (!response.ok) {
      finishSmoke({
        ok: false,
        modules: {},
        pty: { ok: false, output: '', error: response.error.message },
        agent: { ok: false, text: '', error: response.error.message },
        versions: runtimeVersions(),
      })
      return
    }
    // The runtime also emits a smoke:result event; finishSmoke is idempotent.
    finishSmoke(response.result as SmokeReport)
  } catch (error) {
    finishSmoke({
      ok: false,
      modules: {},
      pty: { ok: false, output: '', error: String(error) },
      agent: { ok: false, text: '', error: String(error) },
      versions: runtimeVersions(),
    })
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function editorCandidates(): Array<{ command: string; label: string }> {
  const candidates: Array<{ command: string; label: string }> = []
  const configured = process.env.X_CODE_EDITOR?.trim()
  if (configured) candidates.push({ command: configured, label: path.basename(configured) })
  for (const [command, label] of [
    ['code', 'VS Code'],
    ['cursor', 'Cursor'],
    ['windsurf', 'Windsurf'],
  ] as const) {
    if (commandExists(command)) candidates.push({ command, label })
  }
  if (process.platform === 'darwin') {
    for (const [command, label] of [
      ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'VS Code'],
      [path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'), 'VS Code'],
      ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', 'Cursor'],
      [path.join(os.homedir(), 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'), 'Cursor'],
    ] as const) {
      if (fs.existsSync(command)) candidates.push({ command, label })
    }
  }
  return candidates
}

function openInEditor(
  filePath: string,
  line?: number,
  column?: number,
): { opened: boolean; editor?: string; error?: string } {
  if (!path.isAbsolute(filePath)) return { opened: false, error: '需要一个绝对路径' }
  if (!fs.existsSync(filePath)) return { opened: false, error: `文件不存在：${filePath}` }
  const candidates = editorCandidates()
  if (candidates.length === 0) {
    return { opened: false, error: '未找到 VS Code 或 Cursor。安装后重试，或设置 X_CODE_EDITOR。' }
  }
  const candidate = candidates[0]
  const target =
    line !== undefined && Number.isFinite(line)
      ? `${filePath}:${Math.max(1, Math.round(line))}:${Math.max(1, Math.round(column ?? 1))}`
      : filePath
  try {
    const child = spawn(candidate.command, line !== undefined ? ['--goto', target] : [target], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.unref()
    return { opened: true, editor: candidate.label }
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function installIpc(): void {
  ipcMain.handle('runtime:request', async (event, request: RuntimeRequest) => {
    const senderWindow = windowForSender(event.sender)
    const context = contextForWindow(senderWindow)
    if (request?.method === 'app:open-external') {
      const url = (request.params as { url?: string }).url ?? ''
      if (!url.startsWith('https://')) {
        return {
          id: request.id,
          ok: false,
          error: { code: 'invalid-url', message: 'Only https URLs can be opened externally' },
        }
      }
      await shell.openExternal(url)
      return { id: request.id, ok: true, result: null }
    }
    if (request?.method === 'app:pick-path') {
      const requestedKind = (request.params as { kind?: string }).kind
      const kind =
        requestedKind === 'plugin'
          ? 'plugin'
          : requestedKind === 'project'
            ? 'project'
            : requestedKind === 'folder'
              ? 'folder'
              : requestedKind === 'document'
                ? 'document'
                : 'skill'
      const options: Electron.OpenDialogOptions =
        kind === 'project'
          ? { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] }
          : kind === 'folder'
            ? { title: '选择要索引的文件夹', properties: ['openDirectory'] }
            : kind === 'document'
              ? {
                  title: '选择文档或媒体文件',
                  properties: ['openFile', 'multiSelections'],
                  filters: [
                    {
                      name: 'Documents',
                      extensions: [
                        'pdf',
                        'docx',
                        'xlsx',
                        'pptx',
                        'odt',
                        'ods',
                        'odp',
                        'md',
                        'markdown',
                        'txt',
                        'csv',
                        'tsv',
                        'epub',
                        'mobi',
                        'azw',
                        'azw3',
                        'png',
                        'jpg',
                        'jpeg',
                        'webp',
                        'gif',
                        'mp3',
                        'wav',
                        'm4a',
                        'flac',
                        'ogg',
                        'mp4',
                        'm4v',
                        'mov',
                        'webm',
                        'mkv',
                        'avi',
                      ],
                    },
                  ],
                }
              : {
                  title: kind === 'skill' ? '选择 SKILL.md 或技能文件夹' : '选择插件文件夹',
                  properties: kind === 'skill' ? ['openFile', 'openDirectory'] : ['openDirectory'],
                  filters: kind === 'skill' ? [{ name: 'Skill', extensions: ['md'] }] : undefined,
                }
      const result = senderWindow
        ? await dialog.showOpenDialog(senderWindow, options)
        : await dialog.showOpenDialog(options)
      return {
        id: request.id,
        ok: true,
        result: {
          path: result.canceled ? null : (result.filePaths[0] ?? null),
          paths: result.canceled ? [] : result.filePaths,
        },
      }
    }
    if (request?.method === 'app:open-in-editor') {
      const params = request.params as { filePath?: string; line?: number; column?: number }
      const filePath = typeof params.filePath === 'string' ? params.filePath : ''
      if (!filePath) {
        return { id: request.id, ok: false, error: { code: 'invalid-path', message: 'File path is required' } }
      }
      return {
        id: request.id,
        ok: true,
        result: openInEditor(filePath, params.line, params.column),
      }
    }
    if (request?.method === 'app:capture-region') {
      if (process.platform !== 'darwin') {
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'unsupported',
            message: '区域截图目前仅支持 macOS；可以改用整屏截图。',
          },
        }
      }
      const target = path.join(os.tmpdir(), `x-code-region-${Date.now()}-${process.pid}.png`)
      try {
        // Let the composer repaint after closing the capture menu, but keep the
        // app visible so the user can select a region of the project itself.
        await new Promise((resolve) => setTimeout(resolve, 150))
        const exitCode = await new Promise<number>((resolve) => {
          const child = spawn('screencapture', ['-i', '-x', '-t', 'png', target], { stdio: 'ignore' })
          child.on('error', () => resolve(1))
          child.on('exit', (code) => resolve(typeof code === 'number' ? code : 1))
        })
        if (exitCode !== 0 || !fs.existsSync(target)) {
          return { id: request.id, ok: true, result: { dataUrl: '', width: 0, height: 0, cancelled: true } }
        }
        const buffer = fs.readFileSync(target)
        const image = nativeImage.createFromBuffer(buffer)
        if (image.isEmpty()) {
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'capture-permission',
              message:
                '无法读取屏幕区域。请在系统设置 → 隐私与安全性 → 屏幕录制中允许 X-Code（开发时是 Electron），然后重启应用。',
            },
          }
        }
        const size = image.getSize()
        return {
          id: request.id,
          ok: true,
          result: {
            dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
            width: size.width,
            height: size.height,
            cancelled: false,
          },
        }
      } finally {
        fs.rmSync(target, { force: true })
      }
    }
    if (request?.method === 'app:capture-screen') {
      const display = screen.getPrimaryDisplay()
      const scale = display.scaleFactor || 1
      const width = Math.max(1, Math.round(display.size.width * scale))
      const height = Math.max(1, Math.round(display.size.height * scale))
      let sources: Electron.DesktopCapturerSource[]
      try {
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width, height },
        })
      } catch {
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'capture-permission',
            message:
              '无法访问屏幕。请在系统设置 → 隐私与安全性 → 屏幕录制中允许 X-Code（开发时是 Electron），然后重启应用。',
          },
        }
      }
      const source = sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'capture-unavailable',
            message: '无法读取屏幕。请在系统设置 → 隐私与安全性 → 屏幕录制中允许 X-Code 后重试。',
          },
        }
      }
      return {
        id: request.id,
        ok: true,
        result: {
          dataUrl: source.thumbnail.toDataURL(),
          width,
          height,
          name: source.name,
        },
      }
    }
    if (request?.method === 'app:set-zoom') {
      const requested = Number((request.params as { factor?: number }).factor)
      const factor = Number.isFinite(requested) ? Math.min(1.6, Math.max(0.7, requested)) : 1
      senderWindow?.webContents.setZoomFactor(factor)
      return { id: request.id, ok: true, result: { factor } }
    }
    if (request?.method === 'app:microphone-access') {
      if (isUiSmoke) return { id: request.id, ok: true, result: { granted: true } }
      if (process.platform !== 'darwin') {
        return { id: request.id, ok: true, result: { granted: true } }
      }
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone')
        return { id: request.id, ok: true, result: { granted } }
      } catch (error) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'microphone-denied',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    if (request?.method === 'app:check-update') {
      const currentVersion = currentAppVersion()
      const feed = (request.params as { feed?: string }).feed?.trim() ?? ''
      if (!feed) return { id: request.id, ok: true, result: { configured: false, currentVersion } }
      if (!feed.startsWith('https://')) {
        return {
          id: request.id,
          ok: true,
          result: { configured: true, currentVersion, error: '更新源必须是 https URL' },
        }
      }
      try {
        const response = await fetch(feed, {
          signal: AbortSignal.timeout(8_000),
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as { version?: unknown; url?: unknown; notes?: unknown }
        if (typeof data.version !== 'string') throw new Error('更新源缺少 version 字段')
        return {
          id: request.id,
          ok: true,
          result: {
            configured: true,
            currentVersion,
            latestVersion: data.version,
            url: typeof data.url === 'string' ? data.url : '',
            notes: typeof data.notes === 'string' ? data.notes : '',
          },
        }
      } catch (error) {
        return {
          id: request.id,
          ok: true,
          result: {
            configured: true,
            currentVersion,
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    if (request?.method === 'app:reveal-path') {
      const raw = (request.params as { path?: string }).path ?? ''
      if (!raw.trim()) {
        return { id: request.id, ok: false, error: { code: 'invalid-path', message: 'Path is required' } }
      }
      const target = path.resolve(raw)
      if (!fs.existsSync(target)) {
        return { id: request.id, ok: true, result: { opened: false } }
      }
      if (fs.statSync(target).isDirectory()) await shell.openPath(target)
      else shell.showItemInFolder(target)
      return { id: request.id, ok: true, result: { opened: true } }
    }
    if (request?.method === 'app:image-preview') {
      const raw = (request.params as { path?: string }).path ?? ''
      if (!raw.trim()) {
        return { id: request.id, ok: false, error: { code: 'invalid-path', message: 'Path is required' } }
      }
      const target = path.resolve(raw)
      const mime = IMAGE_PREVIEW_MIME[path.extname(target).toLowerCase()]
      if (!mime) {
        return {
          id: request.id,
          ok: false,
          error: { code: 'unsupported-image', message: 'Only raster image previews are supported' },
        }
      }
      try {
        const stat = fs.statSync(target)
        if (!stat.isFile()) throw new Error('Not a file')
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return {
            id: request.id,
            ok: false,
            error: { code: 'image-too-large', message: 'Image is larger than 20 MB' },
          }
        }
        const buffer = fs.readFileSync(target)
        return {
          id: request.id,
          ok: true,
          result: {
            dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
            mime,
            name: path.basename(target),
            size: stat.size,
          },
        }
      } catch {
        return { id: request.id, ok: false, error: { code: 'missing-image', message: 'Image not found' } }
      }
    }
    if (request?.method === 'app:window-info') {
      const focusedId = BrowserWindow.getFocusedWindow()?.id ?? null
      return {
        id: request.id,
        ok: true,
        result: {
          count: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
          focusedId,
          senderId: senderWindow?.id ?? null,
          windows: [...runtimeContexts.values()]
            .filter((entry) => !entry.window.isDestroyed())
            .map((entry) => ({
              id: entry.window.id,
              workspace: entry.workspace,
              focused: entry.window.id === focusedId,
              sessionFiles: [...entry.sessionFiles],
            })),
        },
      }
    }
    if (request?.method === 'app:set-window-sessions') {
      if (context) {
        const filePaths = (request.params as { filePaths?: unknown }).filePaths
        context.sessionFiles = new Set(
          Array.isArray(filePaths)
            ? filePaths
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                .map((entry) => canonicalDirectory(entry.trim()))
            : [],
        )
      }
      return { id: request.id, ok: true, result: null }
    }
    if (request?.method === 'session:load') {
      const raw = (request.params as { filePath?: string }).filePath ?? ''
      if (raw.trim()) {
        const target = canonicalDirectory(raw.trim())
        const holder = [...runtimeContexts.values()].find(
          (entry) => entry !== context && !entry.window.isDestroyed() && entry.sessionFiles.has(target),
        )
        if (holder) {
          return {
            id: request.id,
            ok: false,
            error: { code: 'session-in-use', message: '该会话已在另一个窗口打开' },
          }
        }
      }
    }
    if (request?.method === 'app:new-window') {
      const params = request.params as {
        sessionFilePath?: string
        workspacePath?: string
      }
      const rawSessionFilePath =
        typeof params.sessionFilePath === 'string' && params.sessionFilePath.trim()
          ? params.sessionFilePath.trim()
          : undefined
      const sessionFilePath = rawSessionFilePath ? canonicalDirectory(rawSessionFilePath) : undefined
      let workspacePath: string | undefined
      if (typeof params.workspacePath === 'string' && params.workspacePath.trim()) {
        workspacePath = canonicalDirectory(params.workspacePath.trim())
        try {
          if (!fs.statSync(workspacePath).isDirectory()) throw new Error('not a directory')
        } catch {
          return {
            id: request.id,
            ok: false,
            error: { code: 'invalid-workspace', message: `Workspace does not exist: ${workspacePath}` },
          }
        }
        // A blank window for a workspace that is already open just focuses it.
        // Moving a session is different: the sender closes its tab, so a new
        // window is created even when another window uses the same workspace.
        if (!sessionFilePath) {
          const existing = [...runtimeContexts.values()].find(
            (entry) =>
              !entry.window.isDestroyed() &&
              ((entry.workspacePath && canonicalDirectory(entry.workspacePath) === workspacePath) ||
                (entry.workspace && canonicalDirectory(entry.workspace) === workspacePath)),
          )
          if (existing) {
            if (existing.window.isMinimized()) existing.window.restore()
            existing.window.show()
            existing.window.focus()
            return { id: request.id, ok: true, result: { created: false, focused: true } }
          }
        }
      }
      const query = new URLSearchParams({ fresh: '1' })
      if (sessionFilePath) {
        // The session is being moved out of the sender: release its claim
        // before the new renderer asks to load the same file.
        if (context) context.sessionFiles.delete(canonicalDirectory(sessionFilePath))
        query.set('session', sessionFilePath)
      }
      if (workspacePath) query.set('workspace', workspacePath)
      createWindow(true, query.toString(), workspacePath)
      return { id: request.id, ok: true, result: { created: true, focused: false } }
    }
    if (request?.method === 'app:quit') {
      setTimeout(() => app.quit(), 50)
      return { id: request.id, ok: true, result: null }
    }
    if (request?.method === 'worktree:remove') {
      const rawPath = (request.params as { path?: string }).path ?? ''
      if (rawPath.trim()) {
        const target = canonicalDirectory(rawPath.trim())
        const inUse = [...runtimeContexts.values()].find(
          (entry) =>
            !entry.window.isDestroyed() &&
            ((entry.workspacePath && canonicalDirectory(entry.workspacePath) === target) ||
              (entry.workspace && canonicalDirectory(entry.workspace) === target)),
        )
        if (inUse) {
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'worktree-in-use',
              message:
                inUse === context
                  ? '不能移除当前窗口正在使用的工作区，请先关闭该窗口'
                  : '该 worktree 正被另一个窗口使用，请先关闭那个窗口',
            },
          }
        }
      }
    }
    const response = await forwardRequest(request, context)
    if (response.ok && context && SHARED_SETTINGS_METHODS.has(request.method)) {
      broadcastSettingsChange(context)
    }
    return response
  })

  ipcMain.on('app:copy-text', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  ipcMain.on('ui-smoke:result', (_event, result: unknown) => {
    if (!isUiSmoke) return
    console.log(`UI_SMOKE_RESULT ${JSON.stringify(result)}`)
    if (uiSmokeTimer) {
      clearTimeout(uiSmokeTimer)
      uiSmokeTimer = null
    }
    const ok = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true)
    setTimeout(() => app.exit(ok ? 0 : 1), 50)
  })
}

let uiSmokeTimer: NodeJS.Timeout | null = null

function startUiSmoke(): void {
  const query = process.env.X_CODE_UI_SMOKE_ONBOARD === '1' ? 'ui-smoke=1&onboard=1' : 'ui-smoke=1'
  createWindow(false, query)
  uiSmokeTimer = setTimeout(() => {
    console.log(`UI_SMOKE_RESULT ${JSON.stringify({ ok: false, checks: {}, error: 'ui smoke timeout' })}`)
    app.exit(1)
  }, 60_000)
}

const gotLock = isHeadlessSmoke ? true : app.requestSingleInstanceLock()

if (!gotLock) {
  console.log('[main] another instance is already running; bringing it forward and exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    // Bring the last focused window forward, or recreate one so a second
    // launch never disappears silently.
    showMainWindow()
  })

  app.whenReady().then(() => {
    installIpc()
    // Chromium-level media permission; the OS (TCC) still prompts separately.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'media')
    })
    if (isSmoke) {
      void runSmoke()
      return
    }
    if (isUiSmoke) {
      startUiSmoke()
      return
    }
    // Development aids for visual inspection: open the terminal drawer or
    // auto-submit a demo prompt. Production launches start clean.
    const search = new URLSearchParams()
    if (process.env.X_CODE_OPEN_TERMINAL === '1') search.set('terminal', '1')
    if (process.env.X_CODE_OPEN_SETTINGS === '1') search.set('settings', '1')
    if (process.env.X_CODE_SLASH_DEMO === '1') search.set('slash', '1')
    if (process.env.X_CODE_DEMO_PROMPT) search.set('prompt', process.env.X_CODE_DEMO_PROMPT)
    const primary = createWindow(true, search.toString())
    void restoreWorkspaceWindows(primary)
    createTray()
    try {
      globalShortcut.register('CommandOrControl+Shift+Space', showMainWindow)
    } catch {
      // The shortcut can be taken by another app; the tray still works.
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Single-window app: closing the window quits the process. This also
    // prevents a hidden zombie instance from blocking the next launch via the
    // single-instance lock. Headless smokes may create transient windows
    // (PDF rendering); their exit path is the smoke result, not this event.
    if (isHeadlessSmoke) return
    app.quit()
  })

  app.on('before-quit', () => {
    appQuitting = true
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
    for (const context of runtimeContexts.values()) {
      const child = context.runtime
      context.runtime = null
      if (!child) continue
      try {
        child.postMessage({ kind: 'shutdown' } satisfies RuntimeInbound)
      } catch {
        // Runtime may already be gone.
      }
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already dead.
        }
      }, 500)
    }
    runtimeContexts.clear()
  })
}
