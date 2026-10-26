// @x-code-cli/core — 跨平台 shell provider 抽象。
//
// 每种 shell（bash/zsh、PowerShell）各自派生子进程，各有一堆引号/编码上的
// 怪癖。把这些怪癖藏在 provider 接口后面，意味着 tool-execution 层不需要
// 平台分支，也不需要为 PowerShell 手写引号转义。
import { type ResultPromise, execa } from 'execa'

import os from 'node:os'

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
      //     都会变成退出 0 或一个笼统的 1，丢失信号。跑过原生 exe 时优先用
      //     $LASTEXITCODE；只有 cmdlet 的管道回退到 $?。
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
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

export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin 会把 SHELL 设成 Unix 风格路径。有它的话优先
    // 用它，这样 Unix 工具生态能按预期工作。
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      return createPosixProvider(shell, shell.endsWith('zsh') ? 'zsh' : 'bash')
    }
    return createPowerShellProvider('powershell.exe')
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  return createPosixProvider(userShell, userShell.endsWith('zsh') ? 'zsh' : 'bash')
}
