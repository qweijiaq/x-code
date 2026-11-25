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

/** 合法的环境变量名——`envVar` 会被裸拼进命令，`FOO=1; rm -rf ~` 这样的值
 *  否则就是一条可执行语句。 */
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** POSIX 单引号转义：单引号内除 `'` 外一切原样保留，因此 `'` 要写成 `'\''`。
 *  不加引号时，值里的空格会把它截成多个参数，`$` / 反引号会被二次展开，
 *  `'` 则会提前终止外层引号并把剩余内容变成可执行语法。 */
function quotePosix(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** PowerShell 单引号字符串：唯一的转义是把 `'` 写成 `''`。 */
function quotePowerShell(value: string): string {
  return `'${value.split("'").join("''")}'`
}

/** cmd.exe 双引号字符串。`"` 用 `""` 转义；`%` 在交互式 cmd 提示符下无法转义
 *  （`%%` 只在批处理文件里折叠），因此这里不声称能处理含 `%` 的值。 */
function quoteCmd(value: string): string {
  return `"${value.split('"').join('""')}"`
}

/** fish 的单引号字符串：转义 `\` 与 `'`。 */
function quoteFish(value: string): string {
  return `'${value.split('\\').join('\\\\').split("'").join("\\'")}'`
}

/**
 * 返回一条可复制粘贴的 shell 命令，用于持久化一个环境变量。返回的字符串只
 * 是命令本身（无前缀、无换行）——调用方用 chalk 颜色和周围的文字来包装它。
 *
 *   envVar        — 例如 "ANTHROPIC_API_KEY"
 *   exampleValue  — 例如 "sk-ant-..."
 *   shell         — detectShell() 的结果
 *
 * 两个参数都会进入一段用户会真正粘贴执行的命令，因此 `envVar` 走白名单、
 * `exampleValue` 按各 shell 的规则加引号——值里出现空格 / `$` / `'` 时既不
 * 解析错，也不会变成可注入的语法。
 */
export function formatPersistCommand(envVar: string, exampleValue: string, shell: ShellType): string {
  if (!ENV_VAR_RE.test(envVar)) throw new Error(`Invalid environment variable name: ${JSON.stringify(envVar)}`)

  switch (shell) {
    case 'powershell':
      return `[Environment]::SetEnvironmentVariable('${envVar}',${quotePowerShell(exampleValue)},'User')`
    case 'cmd':
      return `setx ${envVar} ${quoteCmd(exampleValue)}`
    case 'zsh':
      return `echo ${quotePosix(`export ${envVar}=${exampleValue}`)} >> ~/.zshrc && source ~/.zshrc`
    case 'fish':
      return `set -Ux ${envVar} ${quoteFish(exampleValue)}`
    case 'bash':
    default:
      return `echo ${quotePosix(`export ${envVar}=${exampleValue}`)} >> ~/.bashrc && source ~/.bashrc`
  }
}
