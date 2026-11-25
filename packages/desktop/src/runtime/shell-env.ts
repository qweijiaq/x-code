// 从 GUI 启动的 Electron 不会继承终端应用启动时的 PATH：
// 后来安装的工具（Homebrew、nvm、uv 等）在应用重启前对 agent 的
// shell 不可见。按需解析登录 shell 的环境并合并进运行时进程，
// 同时不覆盖应用管理的值（如存储的 API key 或 X_CODE_HOME）。
import { execFile } from 'node:child_process'
import os from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BEGIN = '__XCODE_ENV_BEGIN__'
const END = '__XCODE_ENV_END__'
const CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 5_000

export interface ShellEnvironmentResult {
  refreshed: boolean
  shell: string
  /** 刷新前不存在的变量数量。 */
  added: number
  /** 值被更新的变量（目前是 PATH）。 */
  updated: string[]
  error?: string
}

let cached: { at: number; result: ShellEnvironmentResult } | null = null

export function parseLoginShellEnv(stdout: string): Record<string, string> | null {
  const begin = stdout.indexOf(BEGIN)
  if (begin < 0) return null
  // 结束标记必须从 BEGIN 之后开始找：用户的 rc 文件会打印调试图、heredoc
  // 示例甚至主题脚本，里面出现 END 会让 `end <= begin` 成立，整个探测
  // 直接失败并被缓存 30s，用户就再也拿不到登录 shell 的 PATH。
  const end = stdout.indexOf(END, begin + BEGIN.length)
  if (end < 0) return null
  const env: Record<string, string> = {}
  for (const entry of stdout.slice(begin + BEGIN.length, end).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

/** 不从登录 shell 快照导入的变量。
 *
 *  除了探针自身写下的簿记变量（PWD/SHLVL/…），这里还挡掉那些会改变
 *  **运行时行为**而不是环境可见性的变量：用户的 rc 文件里一条
 *  `NODE_OPTIONS=--require …` 或 `LD_PRELOAD=…` 会被 `applyLoginShellEnv`
 *  合并进 `process.env`（第一次赋值，之后不再覆盖），从而注入到 Electron
 *  自身以及后续 spawn 的 agent 子进程；`IFS` 会破坏后续对命令输出的分词
 *  解析；`TERM`/`TERMINFO*` 由 `ptyEnv()` 自己按 xterm 设定，导入 rc 里的
 *  值会让终端能力与 node-pty 的声明不一致。
 *
 *  真正的修复方向是把这里改成白名单（PATH + 已知工具目录 + 明确需要的
 *  API key），当前黑名单先收口最直接的几类。 */
const NEVER_IMPORT = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'XCODE_SHELL_ENV_PROBE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'IFS',
  'TERM',
  'TERMINFO',
  'TERMINFO_DIRS',
  'TERMCAP',
])

/** 合并登录 shell 快照。除 PATH 外已有值优先，因此桌面设置/`.env`
 *  注入的 key 绝不会被 shell 覆盖。 */
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
        const sep = process.platform === 'win32' ? ';' : ':'
        const shellDirs = value.split(sep).filter(Boolean)
        // 应用启动时往 PATH 里追加过的专有目录（捆绑的 node/bin、
        // `X_CODE_HOME` 下的工具目录等）不在 shell 快照里；直接覆盖会
        // 静默丢掉它们，且 `resetShellEnvironmentCache()` 也回滚不了。
        // 因此合并而非替换：shell 目录优先，应用专有目录保留在后面。
        const appOnly = (current.PATH ?? '').split(sep).filter((dir) => dir && !shellDirs.includes(dir))
        const merged = [...shellDirs, ...appOnly].join(sep)
        if (merged !== current.PATH) {
          current.PATH = merged
          updated.push(key)
        }
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

/** 探针只用 `-l -i -c` 这三个参数，只有 POSIX 系 shell 支持这套组合。
 *  `process.env.SHELL` 指向 fish/nu/tcsh/xonsh 等时，探测必然失败，而失败
 *  结果也会被缓存 30s——这些用户（GUI 启动看不到 Homebrew/nvm 的那批人）
 *  就永远修不好。按 basename 白名单选择：不支持的回退到系统自带 shell，
 *  结果是 PATH 偏保守，但不会“永久失败”。 */
const POSIX_PROBE_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh'])

function probeShell(): string {
  const configured = process.env.SHELL?.trim() ?? ''
  if (configured && POSIX_PROBE_SHELLS.has(basename(configured))) return configured
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** 重新读取用户的交互式登录 shell 环境。短暂缓存，
 *  这样打开终端标签页或提交轮次时不必每次都拉起一个 shell。 */
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

  const shell = probeShell()
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
    // 失败也要缓存，否则每轮都会重试缓慢/损坏的 rc 文件。
    cached = { at: Date.now(), result }
    return result
  }
}
