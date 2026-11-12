// @x-code-cli/cli — `xc completion <shell>`：生成 shell 补全脚本
//
// 只读、纯本地：把固定的子命令与选项列表渲染成 bash / zsh / fish 脚本，写到
// stdout，由用户重定向到自己的补全目录或 `source`。不做自动安装，避免在用户
// shell 配置里留下无法追踪的片段。
import path from 'node:path'

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const
export type CompletionShell = (typeof COMPLETION_SHELLS)[number]

/** 顶层子命令与可补全的选项。新增子命令或全局选项时同步这里。 */
const SUBCOMMANDS = ['watch', 'trace', 'audit', 'plugin', 'login', 'logout', 'completion'] as const

const PLUGIN_SUBCOMMANDS = [
  'list',
  'info',
  'install',
  'uninstall',
  'enable',
  'disable',
  'search',
  'update',
  'validate',
  'schema',
  'doctor',
  'marketplace',
] as const

const OPTIONS = [
  '--model',
  '--trust',
  '--print',
  '--output-format',
  '--name',
  '--max-turns',
  '--max-tokens',
  '--max-cost',
  '--external-content-policy',
  '--fallback-model',
  '--plan',
  '--plugins',
  '--no-plugins',
  '--hooks',
  '--no-hooks',
  '--plugin-debug',
  '--continue',
  '--scratch',
  '--resume',
  '--version',
  '--help',
] as const

const VALUE_OPTIONS = new Set([
  '--model',
  '--output-format',
  '--name',
  '--max-turns',
  '--max-tokens',
  '--max-cost',
  '--external-content-policy',
  '--fallback-model',
  '--resume',
])

const OPTION_VALUE_CHOICES: Record<string, readonly string[]> = {
  '--output-format': ['text', 'json', 'jsonl'],
  '--external-content-policy': ['off', 'approve'],
}

function bashScript(): string {
  const firstWords = [...SUBCOMMANDS, ...OPTIONS].join(' ')
  return [
    '# bash completion for xc (X-Code)',
    '# Install: xc completion bash > ~/.local/share/bash-completion/completions/xc',
    '_xc() {',
    '  local cur prev',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    COMPREPLY=( $(compgen -W "${firstWords}" -- "$cur") )`,
    '    return 0',
    '  fi',
    '',
    '  case "$prev" in',
    `    --output-format) COMPREPLY=( $(compgen -W "${OPTION_VALUE_CHOICES['--output-format'].join(' ')}" -- "$cur") ); return 0 ;;`,
    `    --external-content-policy) COMPREPLY=( $(compgen -W "${OPTION_VALUE_CHOICES['--external-content-policy'].join(' ')}" -- "$cur") ); return 0 ;;`,
    '    --model|-m|--name|--max-turns|--max-tokens|--max-cost|--fallback-model|--resume|-r) return 0 ;;',
    `    plugin) COMPREPLY=( $(compgen -W "${PLUGIN_SUBCOMMANDS.join(' ')}" -- "$cur") ); return 0 ;;`,
    '  esac',
    '',
    '  if [[ "$cur" == -* ]]; then',
    `    COMPREPLY=( $(compgen -W "${OPTIONS.join(' ')}" -- "$cur") )`,
    '  fi',
    '}',
    'complete -F _xc xc x-code',
    '',
  ].join('\n')
}

function zshScript(): string {
  return [
    '#compdef xc x-code',
    '# Install: xc completion zsh > "${fpath[1]}/_xc"',
    '_xc() {',
    '  local curcontext="$curcontext" state line',
    '  typeset -A opt_args',
    '  _arguments -C \\',
    "    '1: :->command' \\",
    "    '*: :->args'",
    '',
    '  case $state in',
    '    command)',
    `      _values 'command' ${SUBCOMMANDS.join(' ')}`,
    '      ;;',
    '    args)',
    '      case $words[2] in',
    '        plugin)',
    `          _values 'plugin command' ${PLUGIN_SUBCOMMANDS.join(' ')}`,
    '          ;;',
    '        *)',
    `          _values 'option' ${OPTIONS.join(' ')}`,
    '          ;;',
    '      esac',
    '      ;;',
    '  esac',
    '}',
    '_xc "$@"',
    '',
  ].join('\n')
}

function fishScript(): string {
  const lines: string[] = [
    '# fish completion for xc (X-Code)',
    '# Install: xc completion fish > ~/.config/fish/completions/xc.fish',
  ]
  for (const bin of ['xc', 'x-code']) {
    lines.push(`complete -c ${bin} -f`)
    for (const command of SUBCOMMANDS) {
      lines.push(`complete -c ${bin} -n '__fish_use_subcommand' -a ${command}`)
    }
    for (const option of OPTIONS) {
      lines.push(`complete -c ${bin} -l ${option.slice(2)}${VALUE_OPTIONS.has(option) ? ' -r' : ''}`)
    }
    for (const [option, choices] of Object.entries(OPTION_VALUE_CHOICES)) {
      lines.push(`complete -c ${bin} -l ${option.slice(2)} -a '${choices.join(' ')}'`)
    }
    for (const command of PLUGIN_SUBCOMMANDS) {
      lines.push(`complete -c ${bin} -n '__fish_seen_subcommand_from plugin' -a ${command}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function renderCompletion(shell: CompletionShell): string {
  if (shell === 'bash') return bashScript()
  if (shell === 'zsh') return zshScript()
  return fishScript()
}

/** 未显式给出 shell 时从 `$SHELL` 推断；无法识别时退回 bash。 */
export function detectShell(shellPath: string | undefined = process.env.SHELL): CompletionShell {
  const name = path.basename(shellPath ?? '')
  if (name === 'zsh' || name === 'fish') return name
  return 'bash'
}

const USAGE = 'Usage: xc completion [bash|zsh|fish]\n'

export function runCompletionCommand(args: string[]): number {
  const requested = args[0]?.trim()
  if (requested === '--help' || requested === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (requested && !(COMPLETION_SHELLS as readonly string[]).includes(requested)) {
    process.stderr.write(`Unknown shell: ${requested}\n${USAGE}`)
    return 1
  }
  const shell = (requested as CompletionShell | undefined) ?? detectShell()
  process.stdout.write(renderCompletion(shell))
  return 0
}
