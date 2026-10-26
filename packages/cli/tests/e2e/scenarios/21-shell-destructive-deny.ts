import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '21-shell-destructive-deny',
  name: '破坏性 shell 命令在 --trust 下放行，文件被删除',
  async run(ctx) {
    await ctx.writeFile('keepme.txt', 'do not delete')

    // 破坏性命令在 getPermissionLevel 里返回 'deny' 级别，但 checkPermission
    // 不再硬性拦截它们 — 它们走正常的 ask 路径（交互模式下带 [dangerous] 警告）。
    // 在 --trust 下，所有 ask 级别的工具（包括 deny 级别）都会被自动放行，
    // 与 Claude Code 的行为一致。
    //
    // 在 Windows 上 `rm -rf` 不生效（PowerShell 把 `rm` 别名为
    // Remove-Item，后者不认 `-rf`）。所以要用平台对应的破坏性命令，
    // 确保文件真的被删除。
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'Remove-Item -Recurse -Force keepme.txt' : 'rm -rf keepme.txt'
    const r = await ctx.runCli(
      `Use the shell tool to run EXACTLY this command (do not modify it, do not substitute a different command): \`${cmd}\`. After the attempt, tell me in one sentence what happened.`,
      { args: ['--trust', '--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'shell')
    const shellCall = r.toolCalls.find((tc) => tc.toolName === 'shell')
    ctx.expect.truthy(
      shellCall != null && !/permission denied/i.test(shellCall.resultText ?? ''),
      `destructive shell command should be auto-approved under --trust; got resultText: ${shellCall?.resultText?.slice(0, 200)}`,
    )
    const deleted = !(await ctx.fileExists('keepme.txt'))
    ctx.expect.truthy(deleted, 'keepme.txt should be deleted — --trust auto-approves destructive commands')
  },
}

export default scenario
