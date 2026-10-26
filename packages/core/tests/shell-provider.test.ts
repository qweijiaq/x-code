// shell-provider.ts 的集成测试。
//
// 这些测试会启动真实的子进程（bash / zsh / PowerShell），从而端到端地
// 覆盖整条编码 + 引号处理路径。当当前平台解析到不同 shell 时，每个
// suite 会自行跳过。
//
// 回归目标（见仓库根目录的 a.log，它记录了一台 zh-CN Windows 机器上的
// 原始故障）：
//   • 双引号命令在旧的转义反斜杠方案下会命中 `At line:1 char:N`
//   • 原生 exe 的退出码过去会被丢弃，因为 PS 不会把 $LASTEXITCODE
//     传播到它自己的进程退出码
//   • UTF-8 输出过去依赖 `chcp 65001 >nul && ...` 的 cmd 包装
import { describe, expect, it } from 'vitest'

import { getShellProvider } from '../src/tools/shell-provider.js'

const provider = getShellProvider()
const isPowerShell = provider.type === 'powershell'
const isPosix = provider.type === 'bash' || provider.type === 'zsh'

async function run(command: string, timeout = 10_000) {
  const r = await provider.spawn(command, { timeout })
  return {
    exitCode: r.exitCode ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  }
}

describe.skipIf(!isPowerShell)('PowerShell provider', () => {
  // a.log 第 11 行：过去命中 "At line:1 char:24" 的确切形状。
  it('runs commands with nested double quotes', async () => {
    const r = await run(`powershell -Command "Write-Host 'nested'"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('nested')
  })

  // a.log 第 33 行：内嵌双引号字面量的复合命令。
  it('runs compound commands with double-quoted literals', async () => {
    const r = await run(`Write-Output "a"; Write-Output "---"; Write-Output "b"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a')
    expect(r.stdout).toContain('---')
    expect(r.stdout).toContain('b')
  })

  // a.log 第 49 行：双引号包裹的提交信息风格参数。
  it('runs commands with colon-bearing double-quoted args', async () => {
    const r = await run(`Write-Output "feat: use primary accent color"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('primary accent color')
  })

  // 过去依赖 `chcp 65001 >nul &&` 的 cmd 包装；现在
  // -EncodedCommand 的负载自己设置 [Console]::OutputEncoding。
  it('round-trips UTF-8 (Chinese + em-dash + emoji)', async () => {
    const r = await run(`Write-Output "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  // PS 5.1 不会把 $LASTEXITCODE 传播到它自己的退出码。若 provider 没有
  // 结尾的 `exit $__ec`，这里返回的就是 0 或 1。
  it('propagates native exit codes', async () => {
    const r = await run(`cmd /c exit 3`)
    expect(r.exitCode).toBe(3)
  })

  it('does not leak CLIXML progress noise to stderr', async () => {
    const r = await run(`Write-Output ok`)
    expect(r.stderr).not.toMatch(/CLIXML/)
  })
})

describe.skipIf(!isPosix)('POSIX provider (bash/zsh)', () => {
  it('runs commands with escaped double quotes', async () => {
    const r = await run(`echo "hello \\"world\\""`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
    expect(r.stdout).toContain('world')
  })

  it('round-trips UTF-8 (Chinese + em-dash + emoji)', async () => {
    const r = await run(`echo "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  it('propagates non-zero exit codes', async () => {
    const r = await run(`sh -c 'exit 3'`)
    expect(r.exitCode).toBe(3)
  })
})
