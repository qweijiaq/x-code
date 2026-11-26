import { describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { formatPersistCommand } from '../src/shell.js'

/** 取出「会被写进 rc 文件的那一行」：命令形如
 *  `echo <quoted> >> ~/.bashrc && source ~/.bashrc`。 */
function rcLine(command: string, rcFile: string): string {
  const suffix = ` >> ~/${rcFile} && source ~/${rcFile}`
  expect(command.endsWith(suffix)).toBe(true)
  return command.slice(0, -suffix.length)
}

describe('formatPersistCommand', () => {
  it('rejects invalid environment variable names', () => {
    expect(() => formatPersistCommand('FOO=1; rm -rf ~', 'x', 'bash')).toThrow(/Invalid environment variable name/)
  })

  it('quotes the value before quoting the whole echo argument', () => {
    const command = formatPersistCommand('MY_KEY', "a' ; echo INJECTED ; '", 'bash')

    // 外层单引号保护 echo 的参数，内层单引号保护写进 rc 文件的值：`'` 必须在
    // 两个层级上都被转义，否则值会提前闭合并把剩余部分变成可执行语法。
    expect(command.startsWith(`echo 'export MY_KEY='\\''a'`)).toBe(true)
    expect(rcLine(command, '.bashrc')).not.toBe('')
  })

  // 只有真 shell 才能证明转义是正确的：这里把生成的命令跑一遍，再把落进 rc 文件
  // 的内容 source 一次，断言值原样还原且注入片段没有执行。
  it.skipIf(process.platform === 'win32')('round-trips a hostile value through bash without executing it', () => {
    const key = 'XC_PERSIST_ROUNDTRIP'
    const value = "a' ; echo INJECTED ; '"
    const command = formatPersistCommand(key, value, 'bash').replace(' >> ~/.bashrc && source ~/.bashrc', '')
    const rcFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xc-shell-')), 'rc.sh')
    const written = execFileSync('bash', ['-c', command], { encoding: 'utf8' })
    fs.writeFileSync(rcFile, written)

    const sourced = execFileSync('bash', ['-c', `source ${rcFile}; printf '%s' "$${key}"`], {
      encoding: 'utf8',
      env: {},
    })

    expect(sourced).toBe(value)
    expect(sourced).not.toContain('INJECTED\n')
  })

  it.each([
    ['powershell', "[Environment]::SetEnvironmentVariable('MY_KEY','a''b','User')"],
    // cmd 的双引号内 `'` 是字面量，只有 `"` 需要翻倍。
    ['cmd', `setx MY_KEY "a'b"`],
    ['fish', "set -Ux MY_KEY 'a\\'b'"],
  ] as const)('escapes single quotes for %s', (shell, expected) => {
    expect(formatPersistCommand('MY_KEY', "a'b", shell)).toBe(expected)
  })
})
