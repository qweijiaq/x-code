import fs from 'node:fs'

import type { RuntimeEvent, ShellCreateParams } from '../shared/protocol.js'
import { refreshShellEnvironment } from './shell-env.js'

type PtyModule = typeof import('node-pty')
type Pty = import('node-pty').IPty

let ptyModule: PtyModule | null = null

export async function loadPty(): Promise<PtyModule> {
  if (!ptyModule) {
    const imported = (await import('node-pty')) as unknown as { default?: PtyModule } & PtyModule
    ptyModule = (imported.default ?? imported) as PtyModule
  }
  return ptyModule
}

export function interactiveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: [] }
  }
  const file = process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  // Login shell so .zprofile/.zlogin and .zshrc are both applied, matching the
  // user's terminal app.
  return { file, args: ['-l', '-i'] }
}

function isUtf8Locale(value: string | undefined): boolean {
  return value !== undefined && /utf-?8/i.test(value)
}

export function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM ??= 'truecolor'
  env.PYTHONIOENCODING ??= 'utf-8'
  // A GUI launch inherits no LANG/LC_CTYPE from Finder, which leaves zsh and
  // most CLIs in the C locale: Chinese input and filenames then arrive as
  // escape sequences or replacement characters. Default the PTY to UTF-8
  // unless the login shell already provided a UTF-8 locale.
  if (env.LC_ALL && !isUtf8Locale(env.LC_ALL)) env.LC_ALL = 'en_US.UTF-8'
  if (env.LC_CTYPE && !isUtf8Locale(env.LC_CTYPE)) env.LC_CTYPE = 'en_US.UTF-8'
  if (!isUtf8Locale(env.LANG)) env.LANG = 'en_US.UTF-8'
  return env
}

export class ShellManager {
  private shells = new Map<string, Pty>()
  private seq = 0

  constructor(private readonly send: (event: RuntimeEvent) => void) {}

  async create(params: ShellCreateParams): Promise<{ id: string }> {
    const pty = await loadPty()
    const id = `shell-${++this.seq}`
    const { file, args } = interactiveShell()
    await refreshShellEnvironment()
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, params.cols),
      rows: Math.max(2, params.rows),
      cwd: params.cwd && fs.existsSync(params.cwd) ? params.cwd : process.cwd(),
      env: ptyEnv(),
    })

    this.shells.set(id, proc)
    proc.onData((data) => this.send({ type: 'shell:output', id, data }))
    proc.onExit(({ exitCode, signal }) => {
      this.shells.delete(id)
      this.send({ type: 'shell:exit', id, exitCode, signal })
    })
    return { id }
  }

  write(id: string, data: string): void {
    const shell = this.shells.get(id)
    if (!shell) throw new Error(`no-shell: ${id}`)
    shell.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const shell = this.shells.get(id)
    if (!shell) throw new Error(`no-shell: ${id}`)
    shell.resize(Math.max(2, cols), Math.max(2, rows))
  }

  kill(id: string): void {
    const shell = this.shells.get(id)
    if (!shell) return
    this.shells.delete(id)
    try {
      shell.kill()
    } catch {
      // Already gone.
    }
  }

  disposeAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id)
  }
}
