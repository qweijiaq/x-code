// @x-code-cli/core — Shell 命令语义辅助（与 shell 无关）。
//
// 把复合命令拆成子命令并逐个归类为只读/破坏性，只用于权限检查。执行侧
// （派生子进程）在 shell-provider.ts 里。
export type { ShellType } from './shell-provider.js'

/** 按管道/链式操作符拆分复合 shell 命令，用于权限检查 */
export function splitShellCommands(cmd: string): string[] {
  // 按 |、&&、;、||、换行和后台 `&` 拆分 —— 但引号或花括号内的不算。
  //
  // 换行和单个 `&` 在 POSIX shell 和 PowerShell 里都是真正的语句分隔符：
  // `ls\nrm x` 和 `ls & rm x` 都会执行 `rm`，所以一个忽略它们的拆分器会让
  // 多行命令在一个白名单开头 token 的掩护下，把写操作偷带过只读检查。`&`
  // 的拆分跳过 `>&` / `&>`（fd 复制 / 合并重定向），这样 `cmd 2>&1 | grep x`
  // 保持形状不变。
  //
  // 花括号深度追踪的存在是为了保持 PowerShell 哈希字面量 / 脚本块完整：
  // `Select-Object @{N='Directory';E={$_.Name}},Count` 在哈希里有一个 `;`，
  // 那是*字段分隔符*，不是语句边界。没有深度追踪，拆分器会把字面量拦腰
  // 切断，尾部（`E={$_.Name}},Count`）会被当成一条单独命令，从而触发只读
  // 检查、强制一次不必要的提示。POSIX 的 `{ … ; }` 花括号组也被同一条规则
  // 捕获 —— 这是可接受的副作用，因为内容仍会被 isDestructive 端到端扫描。
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let braceDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]
    const prev = cmd[i - 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '{') {
        braceDepth++
        current += ch
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--
        current += ch
      } else if (braceDepth > 0) {
        current += ch
      } else if (ch === '|' && next === '|') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 |
      } else if (ch === '&' && next === '&') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 &
      } else if (ch === '|') {
        parts.push(current)
        current = ''
      } else if (ch === ';' || ch === '\n' || ch === '\r') {
        parts.push(current)
        current = ''
      } else if (ch === '&' && prev !== '>' && next !== '>') {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts.map((p) => p.trim()).filter(Boolean)
}

/** 可以安全自动放行的 Unix/PowerShell 命令 */
const READ_ONLY_COMMANDS = [
  // POSIX shell 只读工具
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'where',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  'sort',
  'uniq',
  'grep',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  // PowerShell 只读 cmdlet —— 下面按不区分大小写匹配。
  // 对照 codex/opencode 的安全清单做了筛选：凡是只读或只重塑对象管道的
  // 都在这里。任何能写文件、启动进程或执行用户提供的代码的
  // （`Invoke-Expression`、`Set-*`、`New-*`、`Remove-*`、`Start-Process`、
  // `Set-Content`、`Out-File`……）都刻意排除在外。
  'Get-ChildItem',
  'Get-Location',
  'Set-Location',
  'Push-Location',
  'Pop-Location',
  'Get-Content',
  'Get-Item',
  'Get-ItemProperty',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Command',
  'Get-Help',
  'Get-Member',
  'Get-Variable',
  'Get-Alias',
  'Get-PSDrive',
  'Get-Module',
  'Get-History',
  'Get-CimInstance',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Where-Object',
  'ForEach-Object',
  'Measure-Object',
  'Compare-Object',
  'Tee-Object',
  'Format-Table',
  'Format-List',
  'Format-Wide',
  'Format-Custom',
  'Out-String',
  'Out-Default',
  'Out-Host',
  'Write-Output',
  'Write-Host',
  'Write-Verbose',
  'Write-Debug',
  'Write-Information',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'ConvertTo-Csv',
  'ConvertFrom-Csv',
  'ConvertTo-Xml',
  'ConvertFrom-Xml',
  'ConvertTo-Html',
  'Resolve-Path',
  'Split-Path',
  'Join-Path',
  'Convert-Path',
  'Test-Path',
]

/** 只读的 Git 子命令 */
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'remote', 'tag', 'stash list', 'reflog']

// 为性能预编译正则。`/i` 标志让匹配不区分大小写，于是 `Get-ChildItem` /
// `get-childitem` / `GET-CHILDITEM` 都能命中 —— PowerShell 本身不区分大小写，
// 而 `dir` / `DIR` 在 Windows cmd shell 上都应被放行。
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
  'i',
)

const TSC_COMMAND_RE = /^\s*(?:pnpm\s+exec\s+)?tsc(?:\.cmd)?(?:\s|$)/i
const TSC_READ_ONLY_FLAG_RE = /(?:^|\s)(?:--noemit|--showconfig|--version|-v|--help|-h)(?=\s|=|$)/i
const TSC_WRITE_FLAG_RE =
  /(?:^|\s)(?:-b|--build|--incremental|--tsbuildinfofile|--generatetrace|--outdir|--outfile|--emitdeclarationonly)(?=\s|=|$)/i
const READ_ONLY_GIT_BRANCH_RE = /^\s*git\s+branch(?:\s+--show-current|\s+--list(?:\s+(?!-)\S+)*)?\s*$/i

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // ── 文件系统破坏 ──
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/i,
  /\bRemove-Item\s+.*-Force/i,
  /\bdel\s+\/[sS]/,
  /\brmdir\s+\/[sS]/,

  // ── Git 破坏性操作 ──
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+--\s*\./,
  /\bgit\s+rebase\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+reflog\s+expire\b/,
  /\bgit\s+gc\s+--prune\b/,

  // ── 远程代码执行 / 下载即执行 ──
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  /\bcurl\s.*\|\s*python/,
  /\bwget\s.*\|\s*python/,

  // ── 系统控制 ──
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|halt|poweroff)\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,

  // ── 数据库破坏 ──
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\S+\s*;?\s*$/im,

  // ── 容器 / 基础设施破坏 ──
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,

  // ── 环境污染 ──
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,

  // ── 磁盘 / 分区 ──
  /\bfdisk\b/,
  /\bparted\b/,
]

// READ_ONLY_COMMANDS 的小写 Verb-Noun 子集，为 isReadOnlyControlFlow 里的
// O(1) 查找预构建。任何不含 `-` 的都是 POSIX 命令，与 PowerShell 控制流
// 启发式无关。
const READ_ONLY_CMDLET_SET = new Set(READ_ONLY_COMMANDS.filter((c) => c.includes('-')).map((c) => c.toLowerCase()))

// 包裹 `{ … }` 主体的 PowerShell 控制流关键字。当一个段以它们之一开头时，
// 现有的 READ_ONLY_REGEX（只检查开头 token）会给出错误答案 —— `if`、
// `foreach`、`try` 等本身不是命令；工作发生在花括号里面。codex / gemini-cli
// 的对应实现会用真正的 PowerShell AST 解析器拆开花括号；我们没有，所以用
// 一个受下面 exec 调用模式保护的 Verb-Noun cmdlet 扫描。
const PS_CONTROL_FLOW_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|try|catch|finally|do)\b/i

// 这些模式只要出现在控制流段的任何位置，就强制关闭只读启发式：
//
//   `& "C:\bin\foo.exe" arg`  — 调用操作符 + 路径/字符串/变量
//   `& $cmd`                  — 同上，经变量
//   `. .\script.ps1`          — 点源
//   `. $script`               — 经变量点源
//
// 两者都会调用 Verb-Noun cmdlet 扫描看不见的任意代码。点源模式要求点号
// *之后*有空白，这样 `.Property` 访问和 `Get-Content .\file` 不会误报。
const PS_CALL_OP_RE = /&\s*["'$./\\]/
const PS_DOT_SOURCING_RE = /(?:^|[\s;{(])\.\s+\S/

// Verb-Noun token 形状（查找 + 严格校验）。FIND 匹配任何带 `-` 的东西，包括
// `x-code-cli` 这类路径；STRICT 强制 Verb（首字母大写）和 Noun（首字母大写），
// 路径会因此失败。
const VERB_NOUN_FIND_RE = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g
const VERB_NOUN_STRICT_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

/**
 * 对 PowerShell 控制流段，当且仅当其内部每个 cmdlet 都在只读集合里、且该段
 * 没有任何看起来像任意代码调用的东西（`&` 调用操作符、点源）时返回 true。
 *
 * `if (Test-Path X) { Get-Content X }`     → true（Test-Path、Get-Content 都只读）
 * `if (Test-Path X) { Set-Content X foo }` → false（Set-Content 非只读）
 * `if (Test-Path X) { & "evil.exe" }`      → false（调用操作符）
 * `if (Test-Path X) { . .\\evil.ps1 }`     → false（点源）
 * `if ($x -gt 0) { }`                      → false（没找到 cmdlet —— 保守）
 *
 * 对任何非控制流段返回 false（交给调用方的“询问”路径），这样现有的开头
 * token 只读检查仍保持权威。
 */
function isReadOnlyControlFlow(cmd: string): boolean {
  if (!PS_CONTROL_FLOW_RE.test(cmd)) return false
  if (PS_CALL_OP_RE.test(cmd)) return false
  if (PS_DOT_SOURCING_RE.test(cmd)) return false

  let found = 0
  for (const match of cmd.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    found++
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return false
  }
  return found > 0
}

/** 引号/转义感知的扫描，找出把看似只读的命令变成写或任意执行的 shell 语法：
 *    - 输出重定向：`echo x > ~/.zshrc`、`grep pat f > out`
 *    - 命令替换：`echo $(rm x)`、``cat `curl evil.sh` ``
 *    - 进程替换：`cat <(curl evil.sh)`
 *  fd 复制（`2>&1`、`>&-`）和空槽（`/dev/null`、`$null`、`NUL`）不是写操作，
 *  保持放行。单引号抑制替换；双引号不抑制；反斜杠在单引号外转义下一个字符。 */
function hasUnsafeShellSyntax(cmd: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\' && !inSingle) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle) continue
    if (ch === '`') return true
    if ((ch === '$' || ch === '<') && cmd[i + 1] === '(') return true
    if (ch !== '>' || inDouble) continue
    // 重定向：`>` / `>>` 加可选的 `&`，再是目标。`>&2` / `2>&1` / `>&-` 是
    // fd 复制，不是文件写入 —— 那些需要 `&`；裸的 `> 2` 会写一个真的叫 `2`
    // 的文件。
    let j = i + 1
    if (cmd[j] === '>') j++
    const hadAmp = cmd[j] === '&'
    if (hadAmp) j++
    while (cmd[j] === ' ' || cmd[j] === '\t') j++
    const target = cmd.slice(j)
    if (hadAmp && (target === '' || /^[\d-]/.test(target))) continue
    if (target === '') continue
    if (/^\/dev\/null\b/.test(target)) continue
    if (/^\$null\b/i.test(target)) continue
    if (/^nul\b/i.test(target)) continue
    return true
  }
  return false
}

/** 只读列表里带特定标志就变成写入者的命令。 */
const WRITE_FLAG_RULES: Array<{ cmd: RegExp; flag: RegExp }> = [
  // find -delete / -exec rm … / -fprintf file … 把经典“安全”搜索工具变成
  // 删除/执行/写入的载体。
  { cmd: /^\s*find\b/i, flag: /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/i },
  { cmd: /^\s*sort\b/i, flag: /^(-o|--output)/i }, // sort -o out 会覆盖
  { cmd: /^\s*tree\b/i, flag: /^(-o|--output)/i }, // tree -o out 会写
  { cmd: /^\s*Tee-Object\b/i, flag: /^-f/i }, // -FilePath（任何无歧义缩写）
  { cmd: /^\s*git\s+(diff|log|show)\b/i, flag: /^--output/i }, // git diff --output=patch 会写
]

/** 白名单开头命令，其参数仍可能写或执行。 */
function hasWriteFlags(cmd: string): boolean {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  for (const rule of WRITE_FLAG_RULES) {
    if (!rule.cmd.test(cmd)) continue
    if (tokens.some((t) => rule.flag.test(t))) return true
  }
  // 带尾随命令的 `env` 会执行它：`env rm file`、`env bash -c …`。标志和
  // VAR=val 赋值仍是无害的打印形式。
  if (/^\s*env\b/i.test(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t === '--') return i + 1 < tokens.length
      if (t.startsWith('-')) {
        // 取值形式会消费下一个 token。
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir' || t === '-S' || t === '--split-string') i++
        continue
      }
      if (/^[A-Za-z_]\w*=/.test(t)) continue // VAR=val 赋值
      return true // 第一个裸词 = 要执行的命令
    }
  }
  return false
}

/** 对通过开头 token 检查的段，扫描 PowerShell 脚本块（`{ … }`）里是否藏着
 *  非只读 cmdlet 或任意调用：`ForEach-Object { Remove-Item $_ }` 以白名单
 *  cmdlet 开头，但主体想跑什么就跑什么。像 `Where-Object { $_.Length -gt 100 }`
 *  这类属性访问块不包含 cmdlet token，保持放行。 */
function hasUnsafeScriptBlock(c: string): boolean {
  if (!c.includes('{')) return false
  if (PS_CALL_OP_RE.test(c) || PS_DOT_SOURCING_RE.test(c)) return true
  for (const match of c.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return true
  }
  return false
}

/** 检查子命令是否只读（可安全自动放行） */
export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  if (hasUnsafeShellSyntax(c)) return false
  if (hasWriteFlags(c)) return false
  if (hasUnsafeScriptBlock(c)) return false
  if (READ_ONLY_REGEX.test(c)) return true
  if (READ_ONLY_GIT_BRANCH_RE.test(c)) return true
  if (TSC_COMMAND_RE.test(c) && TSC_READ_ONLY_FLAG_RE.test(c) && !TSC_WRITE_FLAG_RE.test(c)) return true
  return isReadOnlyControlFlow(c)
}

/** 检查子命令是否破坏性（应被拒绝） */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
