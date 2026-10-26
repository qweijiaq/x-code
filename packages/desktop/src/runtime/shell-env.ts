// GUI-launched Electron does not inherit the PATH a terminal app starts with:
// tools installed later (Homebrew, nvm, uv, ...) are invisible to the agent's
// shell until the app restarts. Resolve the login shell's environment on demand
// and merge it into the runtime process without clobbering app-managed values
// such as stored API keys or X_CODE_HOME.
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BEGIN = '__XCODE_ENV_BEGIN__'
const END = '__XCODE_ENV_END__'
const CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 5_000

export interface ShellEnvironmentResult {
  refreshed: boolean
  shell: string
  /** Number of variables that were absent before the refresh. */
  added: number
  /** Variables whose value was updated (currently PATH). */
  updated: string[]
  error?: string
}

let cached: { at: number; result: ShellEnvironmentResult } | null = null

export function parseLoginShellEnv(stdout: string): Record<string, string> | null {
  const begin = stdout.indexOf(BEGIN)
  const end = stdout.indexOf(END)
  if (begin < 0 || end <= begin) return null
  const env: Record<string, string> = {}
  for (const entry of stdout.slice(begin + BEGIN.length, end).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

const NEVER_IMPORT = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'XCODE_SHELL_ENV_PROBE'])

/** Merge a login-shell snapshot. Existing values win except for PATH, so keys
 *  injected by the desktop settings/`.env` are never overwritten by the shell. */
export function applyLoginShellEnv(
  current: NodeJS.ProcessEnv,
  captured: Record<string, string>,
): { added: number; updated: string[] } {
  let added = 0
  const updated: string[] = []
  for (const [key, value] of Object.entries(captured)) {
    if (NEVER_IMPORT.has(key)) continue
    if (key === 'PATH') {
      if (value && current.PATH !== value) {
        current.PATH = value
        updated.push(key)
      }
      continue
    }
    if (current[key] === undefined) {
      current[key] = value
      added += 1
    }
  }
  return { added, updated }
}

export function resetShellEnvironmentCache(): void {
  cached = null
}

/** Re-read the user's interactive login shell environment. Cached briefly so
 *  opening terminal tabs or submitting turns does not spawn a shell each time. */
export async function refreshShellEnvironment(options: { force?: boolean } = {}): Promise<ShellEnvironmentResult> {
  if (process.env.XCODE_SKIP_SHELL_ENV_REFRESH === '1') {
    return { refreshed: false, shell: process.env.SHELL ?? '', added: 0, updated: [], error: 'disabled' }
  }
  if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return cached.result

  if (process.platform === 'win32') {
    const result: ShellEnvironmentResult = {
      refreshed: false,
      shell: process.env.COMSPEC ?? 'cmd.exe',
      added: 0,
      updated: [],
      error: 'environment refresh is not implemented on Windows',
    }
    cached = { at: Date.now(), result }
    return result
  }

  const shell = process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const probe = `printf '${BEGIN}'; env -0; printf '${END}'`
  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-i', '-c', probe], {
      cwd: os.homedir(),
      env: { ...process.env, XCODE_SHELL_ENV_PROBE: '1' },
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    const captured = parseLoginShellEnv(stdout)
    if (!captured) throw new Error('login shell did not return an environment')
    const { added, updated } = applyLoginShellEnv(process.env, captured)
    const result: ShellEnvironmentResult = { refreshed: true, shell, added, updated }
    cached = { at: Date.now(), result }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: ShellEnvironmentResult = {
      refreshed: false,
      shell,
      added: 0,
      updated: [],
      error: message.slice(0, 200),
    }
    // Cache failures too, otherwise every turn retries a slow/broken rc file.
    cached = { at: Date.now(), result }
    return result
  }
}
