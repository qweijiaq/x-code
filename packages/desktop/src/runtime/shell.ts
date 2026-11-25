import fs from 'node:fs'
import os from 'node:os'

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
  // 登录 shell，使 .zprofile/.zlogin 和 .zshrc 都生效，
  // 与用户的终端应用一致。
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
  // 交互式终端是用户自己的 shell，不应该继承 Electron utilityProcess 的
  // 运行时开关；否则在终端里跑 Electron 项目会变成纯 Node（没有窗口）。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.TERM = 'xterm-256color'
  env.COLORTERM ??= 'truecolor'
  env.PYTHONIOENCODING ??= 'utf-8'
  // 从 GUI 启动不会从 Finder 继承 LANG/LC_CTYPE，这会让 zsh 和
  // 大多数 CLI 处于 C locale：中文输入和文件名会变成
  // 转义序列或替换字符。默认 PTY 为 UTF-8，
  // 除非登录 shell 已提供 UTF-8 locale。
  if (env.LC_ALL && !isUtf8Locale(env.LC_ALL)) env.LC_ALL = 'en_US.UTF-8'
  if (env.LC_CTYPE && !isUtf8Locale(env.LC_CTYPE)) env.LC_CTYPE = 'en_US.UTF-8'
  if (!isUtf8Locale(env.LANG)) env.LANG = 'en_US.UTF-8'
  return env
}

export class ShellManager {
  private shells = new Map<string, Pty>()
  private seq = 0
  /** 被主动 kill 的终端 id：用来区分“用户关闭标签页”和“shell 意外退出”。 */
  private readonly killed = new Set<string>()

  constructor(private readonly send: (event: RuntimeEvent) => void) {}

  async create(params: ShellCreateParams): Promise<{ id: string }> {
    const pty = await loadPty()
    const id = `shell-${++this.seq}`
    await refreshShellEnvironment()
    // 必须在刷新之后再求值：GUI 启动时 `SHELL` 常常是空的，登录 shell
    // 探测会把真实的 `SHELL` 合并进 `process.env`，早求值就会退回到
    // `/bin/sh`（Linux 上通常不是用户的真实 shell），与 `ptyEnv()` 的顺序
    // 也不一致。
    const { file, args } = interactiveShell()
    let proc: Pty | null = null
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(2, params.cols),
        rows: Math.max(2, params.rows),
        // `process.cwd()` 在打包后的 Electron 里可能是 `/` 或应用安装目录：
        // 用户新开终端会落在一个不可写的奇怪位置。回退到 home。
        cwd: params.cwd && fs.existsSync(params.cwd) ? params.cwd : os.homedir(),
        env: ptyEnv(),
      })

      this.shells.set(id, proc)
      proc.onData((data) => {
        // 主动 kill 的 shell 不再往 renderer 推残留输出。
        if (this.killed.has(id)) return
        this.send({ type: 'shell:output', id, data })
      })
      proc.onExit(({ exitCode, signal }) => {
        this.shells.delete(id)
        // 用户主动关闭标签页时不再回一条 `shell:exit`：那会让人误以为
        // shell 崩溃，或在 disposeAll 的关闭流程里往已销毁的端口发消息。
        if (this.killed.delete(id)) return
        this.send({ type: 'shell:exit', id, exitCode, signal })
      })
      return { id }
    } catch (error) {
      // spawn / 注册失败时进程不在 `this.shells` 里，不 kill 就是无人管理的
      // 孤儿进程（`seq` 已经自增，id 也不会再被复用）。
      try {
        proc?.kill()
      } catch {
        // 没起来就没有可 kill 的。
      }
      this.shells.delete(id)
      this.killed.delete(id)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法启动终端 ${file}：${message.slice(0, 200)}`)
    }
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
    this.killed.add(id)
    this.shells.delete(id)
    try {
      shell.kill()
    } catch {
      // 已经不存在了。
    }
  }

  disposeAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id)
  }
}
