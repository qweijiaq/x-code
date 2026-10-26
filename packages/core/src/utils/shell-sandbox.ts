// @x-code-cli/core — macOS workspace-write shell sandbox
//
// When enabled (desktop setting, macOS only), agent shell commands run under
// `/usr/bin/sandbox-exec` with a generated SBPL profile:
//   - reads are allowed everywhere except a list of credential locations,
//   - writes are allowed only inside the workspace and temp directories,
//   - network access is denied unless the user explicitly allows it,
//   - API keys / tokens / secrets are stripped from the child environment.
//
// The interactive terminal in the desktop app is the user's own shell and is
// NOT sandboxed. With `includeExtensions`, hook commands and stdio MCP
// servers are wrapped too: hooks use the configured network policy, MCP
// servers always keep network access (their APIs live outside the sandbox)
// while still being restricted to workspace/temp writes.
import os from 'node:os'
import path from 'node:path'

export interface ShellSandboxConfig {
  enabled: boolean
  workspace: string
  allowNetwork: boolean
  /** Opt-in: also sandbox hook commands and stdio MCP servers. */
  includeExtensions: boolean
}

const DEFAULT_CONFIG: ShellSandboxConfig = {
  enabled: false,
  workspace: process.cwd(),
  allowNetwork: false,
  includeExtensions: false,
}

let current: ShellSandboxConfig = { ...DEFAULT_CONFIG }

export function setShellSandbox(config: Partial<ShellSandboxConfig>): void {
  current = { ...current, ...config }
}

export function getShellSandbox(): ShellSandboxConfig {
  return current
}

/** True when commands must be wrapped with sandbox-exec. */
export function isShellSandboxActive(): boolean {
  return process.platform === 'darwin' && current.enabled
}

/** True when hooks / stdio MCP servers must also be wrapped. */
export function isExtensionSandboxActive(): boolean {
  return isShellSandboxActive() && current.includeExtensions
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function sensitivePaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.netrc'),
    path.join(home, '.npmrc'),
    path.join(home, '.pypirc'),
    path.join(home, 'Library', 'Keychains'),
    path.join(home, '.x-code', 'desktop-secrets.json'),
    path.join(home, '.x-code', 'plugins', 'user-config.json'),
  ]
}

/** Build the SBPL profile. Later rules override earlier ones, so the sensitive
 *  deny block sits after the workspace write allow. */
export function sandboxProfileText(config: ShellSandboxConfig = current): string {
  const workspace = path.resolve(config.workspace)
  const temp = os.tmpdir()
  const xcodeRoot = process.env.X_CODE_HOME?.trim() || path.join(os.homedir(), '.x-code')
  const skillRuntime = path.join(xcodeRoot, 'skill-runtime')
  const lines = ['(version 1)', '(allow default)']
  if (!config.allowNetwork) lines.push('(deny network*)')
  lines.push(
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${sbplString(workspace)})`,
    `  (subpath ${sbplString(temp)})`,
    // Skill scripts may download models/dependencies into their isolated
    // runtime; it is app-managed and contains no credentials.
    `  (subpath ${sbplString(skillRuntime)})`,
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper"))',
    '(deny file-read* file-write*',
    ...sensitivePaths().map((entry) => `  (subpath ${sbplString(entry)})`),
    ')',
  )
  return lines.join('\n')
}

/** Wrap an executable + args so it runs inside sandbox-exec when active. */
export function wrapShellSpawn(
  executable: string,
  args: string[],
  config: ShellSandboxConfig = current,
): { executable: string; args: string[] } {
  if (process.platform !== 'darwin' || !config.enabled) return { executable, args }
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfileText(config), executable, ...args] }
}

const SECRET_ENV_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i

/** Remove credential-looking variables from a child environment. PATH, HOME,
 *  locale, and display variables are preserved. */
export function sanitizeShellEnv(env: NodeJS.ProcessEnv, config: ShellSandboxConfig = current): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin' || !config.enabled) return env
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue
    sanitized[key] = value
  }
  return sanitized
}
