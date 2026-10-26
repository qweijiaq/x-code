// @x-code-cli/cli — Shell 检测与持久化命令辅助函数。
//
// index.ts 中多个打印消息的函数都需要 Shell 检测。formatPersistCommand
// 辅助函数提取了那个可复制的 switch(shell) 块——它此前一字不差地同时出现在
// printNoApiKeyMessage 和 printNoWebSearchKeyHint 中。

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh'

export function detectShell(): ShellType {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) return 'powershell'
    return 'cmd'
  }
  const shellPath = process.env.SHELL ?? ''
  const base = shellPath.split('/').pop() ?? ''
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') return base
  if (process.platform === 'darwin') return 'zsh'
  return 'bash'
}

/**
 * 返回一条可复制粘贴的 shell 命令，用于持久化一个环境变量。返回的字符串只
 * 是命令本身（无前缀、无换行）——调用方用 chalk 颜色和周围的文字来包装它。
 *
 *   envVar        — 例如 "ANTHROPIC_API_KEY"
 *   exampleValue  — 例如 "sk-ant-..."
 *   shell         — detectShell() 的结果
 */
export function formatPersistCommand(envVar: string, exampleValue: string, shell: ShellType): string {
  switch (shell) {
    case 'powershell':
      return `[Environment]::SetEnvironmentVariable('${envVar}','${exampleValue}','User')`
    case 'cmd':
      return `setx ${envVar} "${exampleValue}"`
    case 'zsh':
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.zshrc && source ~/.zshrc`
    case 'fish':
      return `set -Ux ${envVar} ${exampleValue}`
    case 'bash':
    default:
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.bashrc && source ~/.bashrc`
  }
}
