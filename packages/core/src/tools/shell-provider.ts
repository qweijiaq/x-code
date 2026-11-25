// @x-code-cli/core — 跨平台 shell provider 抽象。
//
// 每种 shell（bash/zsh、PowerShell）各自派生子进程，各有一堆引号/编码上的
// 怪癖。把这些怪癖藏在 provider 接口后面，意味着 tool-execution 层不需要
// 平台分支，也不需要为 PowerShell 手写引号转义。
import { type ResultPromise, execa } from 'execa'

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sanitizeShellEnv, wrapShellSpawn } from '../utils/shell-sandbox.js'

export type ShellType = 'bash' | 'zsh' | 'powershell'

// 20 MB —— 对齐 Claude Code 的 ripgrep 缓冲；对真实负载够宽裕，又小到能
// 防止意外的 `yes` 或 `find /` 吃光所有内存。一旦超过，execa 会用 SIGTERM
// 终止子进程，并抛出一个 "maxBuffer exceeded" 错误。
const MAX_SHELL_BUFFER = 20 * 1024 * 1024

export interface ShellSpawnOptions {
  timeout: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** 当这个信号中止时，execa 会杀掉子进程树。用来在命令执行中途响应用户的
   *  Esc / Ctrl+C 取消，而不必等到超时。 */
  signal?: AbortSignal
  /** 在内存里收集子进程完整的 stdout/stderr（execa 默认：true）。对长驻的
   *  后台 shell，把它设为 false，让它通过子流自行流式输出 —— 否则一旦总
   *  输出超过 MAX_SHELL_BUFFER，execa 就会 SIGTERM 它，这会杀掉一个吵吵闹闹
   *  的 dev server。 */
  buffer?: boolean
}

export interface ShellProvider {
  type: ShellType
  spawn(command: string, opts: ShellSpawnOptions): ResultPromise
}

function baseSpawnOptions(opts: ShellSpawnOptions) {
  return {
    timeout: opts.timeout,
    maxBuffer: MAX_SHELL_BUFFER,
    buffer: opts.buffer ?? true,
    windowsHide: true,
    cwd: opts.cwd,
    reject: false,
    cancelSignal: opts.signal,
    // execa 默认会把 process.env 合并回来；那会把 sanitizeShellEnv 刚删掉的
    // Electron 运行时开关重新带进子进程。这里使用完整的环境对象，禁止再合并。
    extendEnv: false,
    env: { ...sanitizeShellEnv(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  } as const
}

function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      const wrapped = wrapShellSpawn(executable, ['-c', command])
      return execa(wrapped.executable, wrapped.args, baseSpawnOptions(opts))
    },
  }
}

// PowerShell 的 -EncodedCommand 接受 base64 的 UTF-16LE 载荷。字符集是
// [A-Za-z0-9+/=]，能穿过任何外层引号层（cmd.exe、Node 的 Windows
// argv 转字符串序列化器等），所以我们永远不需要转义用户命令里的引号。
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

function createPowerShellProvider(executable: string): ShellProvider {
  return {
    type: 'powershell',
    spawn(command, opts) {
      // 前缀/后缀跑在同一个 -EncodedCommand 载荷里：
      //   • OutputEncoding = UTF-8 —— 否则 zh-CN Windows 上的 PS 5.1 会用
      //     GBK 写输出（我们按 UTF-8 解码就是乱码）。这也省掉了
      //     `chcp 65001 >nul && ...` 的 cmd.exe 包装。
      //   • ProgressPreference = SilentlyContinue —— 首次运行时模块加载会
      //     在 stderr 上发 CLIXML 进度记录，否则会以噪音形式出现在工具
      //     输出里。
      //   • 末尾的 `exit` —— PowerShell 不会把 $LASTEXITCODE 传播到它自己
      //     的进程退出码。没有这个，`git push` 失败退出 1、`tsc` 失败退出 2，
      //     都会变成退出 0 或一个笼统的 1，丢失信号。
      //     先看 `$?`（它反映最后一条语句），失败时再取 `$LASTEXITCODE`：
      //     反过来会让「原生命令成功 + 末尾 cmdlet 失败」的脚本拿到上一个
      //     原生命令留下的 0，失败被静默吞掉。
      //   • OutputEncoding 包在 try/catch 里 —— 它排在用户命令之前，在
      //     ConstrainedLanguage 语言模式（AppLocker/WDAC）或没有有效控制台
      //     句柄的重定向场景下赋值会抛终止性错误，整段 -EncodedCommand 载荷
      //     会中止，用户的命令根本不会执行。
      const wrapped = [
        'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
        'exit $__ec',
      ].join('\n')
      return execa(
        executable,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)],
        baseSpawnOptions(opts),
      )
    },
  }
}

/**
 * 从 `SHELL` 里识别 bash/zsh，并确认它真的能被 spawn。
 *
 * 用捕获组取 shell 名再小写化（原实现用 `/i` 匹配、却用大小写敏感的
 * `endsWith('zsh')` 判断类型，`/bin/ZSH` 会被误判成 bash），同时接受
 * `bash.exe` 这种带扩展名的 Windows 路径。路径不存在时返回 null：MSYS2/Cygwin
 * 的 `SHELL` 常是 Unix 风格路径（`/bin/bash`），Node 在 win32 上不做 MSYS 路径
 * 转换，直接交给 execa 只会 ENOENT。
 */
function resolvePosixShell(value: string | undefined): { path: string; type: 'bash' | 'zsh' } | null {
  const match = value?.match(/[/\\](bash|zsh)(?:\.exe)?$/i)
  if (!value || !match) return null
  if (!existsSync(value)) return null
  return { path: value, type: match[1]!.toLowerCase() === 'zsh' ? 'zsh' : 'bash' }
}

/** 能承载我们生成的 bash 语法的 shell 名。`fish` / `csh` / `tcsh` /
 *  `nologin` 不在其中：上层（tool-execution）无条件生成 bash 语法（数组、
 *  `[[ ]]`、进程替换），拿它们执行只会语法报错或给出莫名退出码，而调用方
 *  从 provider 的 `type` 完全看不出真实 shell。 */
const POSIX_BASH_SHELL_NAMES: ReadonlySet<string> = new Set(['bash', 'sh', 'dash'])

/** 非 Windows 平台上的默认 provider：只在 `SHELL` 指向一个真实存在、且名字
 *  被识别（bash / sh / dash / zsh）的可执行文件时才用它，否则回落到
 *  `/bin/bash`。空字符串 `SHELL=''` 会 spawn 一个空路径，同样走回落。 */
function resolveDefaultPosixProvider(): ShellProvider {
  const value = process.env.SHELL?.trim()
  if (!value || !path.isAbsolute(value) || !existsSync(value)) {
    return createPosixProvider('/bin/bash', 'bash')
  }
  const name = path.basename(value).toLowerCase()
  if (name === 'zsh') return createPosixProvider(value, 'zsh')
  if (POSIX_BASH_SHELL_NAMES.has(name)) return createPosixProvider(value, 'bash')
  return createPosixProvider('/bin/bash', 'bash')
}

export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin 会把 SHELL 设成 Unix 风格路径。路径可用时优先
    // 用它，这样 Unix 工具生态能按预期工作；不可用则回落到 PowerShell，避免
    // 整条命令因 ENOENT 失败。
    const detected = resolvePosixShell(process.env.SHELL)
    if (detected) return createPosixProvider(detected.path, detected.type)
    return createPowerShellProvider('powershell.exe')
  }
  return resolveDefaultPosixProvider()
}
