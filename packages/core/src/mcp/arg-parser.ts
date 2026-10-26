// @x-code-cli/core — /mcp add/add-json/remove 的斜杠命令参数解析器
//
// 斜杠命令只投递一个原始字符串（`/mcp <sub>` 之后的文本），我们必须把它
// 转成结构化的 McpServerConfig。解析器刻意保持窄范围：
//   - 每个子命令一个入口（parseAdd / parseAddJson / parseRemove）
//   - 返回带标记的 ParseResult，让 App.tsx 调用方只分支一次，
//     要么拿到可用的命令，要么拿到一行错误字符串
//
// 我们支持的引号规则，刻意保持最小：
//   - "双引号" 和 '单引号' 包裹的字符串保留空白
//   - 反斜杠只转义空白、引号字符（以及它自己）——
//     `\ ` 表示字面空格，`\"` 表示字面引号，`\\` 表示字面反斜杠。
//     反斜杠后跟其他字符则原样透传。这在 Windows 上很关键，用户经常
//     粘贴 `D:\res\x-code-cli\tmp` 这样的路径——完全的 POSIX 风格转义
//     会吞掉所有这些反斜杠并悄悄破坏路径。
//   - 其余情况：空白切分 token
//
// 为什么不依赖 shell-words 这类 npm 包：这里的表面积很小，
// 50 行的 tokenizer 让解析器对测试完全确定，且没有跨平台 shell
// 转义带来的意外。
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

export interface AddCommand {
  kind: 'add'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface AddJsonCommand {
  kind: 'add-json'
  name: string
  scope: ConfigScope
  config: McpServerConfig
}

export interface RemoveCommand {
  kind: 'remove'
  name: string
  /** 用户未传 --scope 时为 undefined；由调用方自动探测。 */
  scope?: ConfigScope
}

export type ParsedCommand = AddCommand | AddJsonCommand | RemoveCommand

export type ParseResult<T extends ParsedCommand = ParsedCommand> =
  | { ok: true; command: T }
  | { ok: false; error: string }

/** `mcpServers.<name>` 允许的名字。相比运行时的 name-mangling 消毒器更严格，
 *  因为*配置入口*是拒绝奇怪名字的更好位置——添加之后才发生的意外消毒
 *  （"我输入 `my server!` 结果变成 `my_server___xxx`"）比一次明确的拒绝
 *  更糟糕。长度 32 为 `{server}__{tool}` 格式留出余量，使其远低于模型侧
 *  64 字符的工具名上限。 */
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

// ── 顶层入口 ─────────────────────────────────────────────────

/** 解析 /mcp add [...flags] <name> <command-or-url> [args...] 的参数。 */
export function parseAdd(rawArg: string): ParseResult<AddCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  // 第一遍：从前面剥离 flag。遇到第一个非 flag token（即服务器名）就停下；
  // `--` 分隔符会硬性终止 flag 解析并被丢弃——其后全部是位置参数。
  let isHttp = false
  let scope: ConfigScope = 'user'
  let timeout: number | undefined
  const envEntries: Array<[string, string]> = []
  const headerEntries: Array<[string, string]> = []

  let i = 0
  let sawDoubleDash = false
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!t.startsWith('-')) break // first positional
    if (t === '--') {
      sawDoubleDash = true
      i++
      break
    }
    if (t === '--http' || t === '--transport') {
      // --http 是我们的简写；--transport <name> 是 Claude/Gemini 的语法
      // （这里只接受 http；按设计文档，sse 有意不支持——
      // MCP 规范已在 2025-03 弃用 SSE）。
      if (t === '--transport') {
        const next = tokens[i + 1]
        if (next !== 'http') {
          return err(
            `--transport only supports "http" (got ${next ?? '(missing)'}); use --http directly or omit for stdio`,
          )
        }
        i += 2
      } else {
        i++
      }
      isHttp = true
      continue
    }
    if (t === '--scope') {
      const scopeResult = parseScopeValue(tokens, i)
      if (!scopeResult.ok) return scopeResult
      scope = scopeResult.scope
      i = scopeResult.nextIndex
      continue
    }
    if (t === '--env') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--env requires a KEY=VALUE argument')
      const eq = v.indexOf('=')
      if (eq <= 0) return err(`--env expects KEY=VALUE (got ${v})`)
      envEntries.push([v.slice(0, eq), v.slice(eq + 1)])
      i += 2
      continue
    }
    if (t === '--header') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--header requires a "Key: value" argument')
      // Header 格式："Key: Value"（RFC 7230 风格）。冒号两侧的空白宽容处理，
      // 以贴合用户习惯。
      const colon = v.indexOf(':')
      if (colon <= 0) return err(`--header expects "Key: Value" (got ${v})`)
      headerEntries.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()])
      i += 2
      continue
    }
    if (t === '--timeout') {
      const v = tokens[i + 1]
      if (typeof v !== 'string') return err('--timeout requires a number (ms)')
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return err(`--timeout requires a positive integer (got ${v})`)
      timeout = n
      i += 2
      continue
    }
    return err(`Unknown flag: ${t}`)
  }

  // 位置参数。（可选的）`--` 之后剩下的全是 name + command/url + 其余参数。
  // Stdio：tokens[i] = name，tokens[i+1] = command，tokens[i+2..] = args。
  // HTTP：tokens[i] = name，tokens[i+1] = url，后面不再有内容。
  //
  // 习惯 Claude Code 用法的用户会写 `add <name> -- <cmd>`，把分隔符放在
  // name 之后。我们的 flag 循环已在第一个非 flag（即 name）处停下，所以
  // 任何 `--` 都会落到 positional[1]。丢弃它——它只是装饰性的，
  // 真正的命令跟在后面。
  let positional = tokens.slice(i)
  if (positional[1] === '--') {
    positional = [positional[0]!, ...positional.slice(2)]
  }
  if (positional.length < 2) {
    return err(
      isHttp
        ? 'Usage: /mcp add --http [--scope user|project] [--header "K: V"]... [--timeout N] <name> <url>'
        : 'Usage: /mcp add [--scope user|project] [--env K=V]... [--timeout N] <name> <command> [args...]',
    )
  }
  const name = positional[0]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }

  if (isHttp) {
    if (positional.length > 2) {
      return err('HTTP servers take only <name> <url> — no extra positional args')
    }
    if (envEntries.length > 0) return err('--env is only valid for stdio servers')
    const url = positional[1]!
    if (!isValidUrl(url)) return err(`Invalid URL: ${url}`)
    const config: McpHttpServerConfig = {
      url,
      ...(headerEntries.length > 0 ? { headers: Object.fromEntries(headerEntries) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    return ok({ kind: 'add', name, scope, config })
  }

  // stdio。`--` 允许但可选。有的用户会写 `/mcp add fs npx -y @pkg/foo /tmp`，
  // 有的写 `/mcp add fs -- npx -y ...`。两种情况都会同样到达这个分支——
  // 我们已在上游剥掉了 `--`。
  void sawDoubleDash
  if (headerEntries.length > 0) return err('--header is only valid for HTTP servers (--http)')
  const command = positional[1]!
  const args = positional.slice(2)
  const config: McpStdioServerConfig = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  }
  return ok({ kind: 'add', name, scope, config })
}

/** 解析 /mcp add-json [--scope ...] <name> '<json>' 的参数。 */
export function parseAddJson(rawArg: string): ParseResult<AddJsonCommand> {
  // add-json 特别需要保持 JSON 字面量完整，而不是交给 shell tokenizer 处理
  // （后者会破坏嵌套引号）。策略：在 JSON 开始之前的*前缀*上用 tokenize
  // 剥离 flag + name，然后把 JSON 作为后缀原样取出。我们通过寻找 name token
  // 之后的第一个 `{` 来定位 JSON 的起点。

  const trimmed = rawArg.trim()
  if (!trimmed) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }

  // 遍历 token，直到用完 flags/name 或者遇到以 `{` 开头的 token。JSON 块
  // 可能是以单引号形式输入给斜杠命令的——此时 tokenizer 会剥掉引号，
  // 我们得到一个干净的对象字符串。如果未加引号，用户本就不该有嵌套空白，
  // 所以单个 token 就够用了。
  const tokRes = tokenize(trimmed)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens

  const scopeResult = parseScopeOnlyFlags(tokens, 'user', 'add-json')
  if (!scopeResult.ok) return scopeResult
  const { scope } = scopeResult
  let i = scopeResult.nextIndex

  if (i >= tokens.length) {
    return err("Usage: /mcp add-json [--scope user|project] <name> '<json>'")
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  i++

  // 如果用户没有给 JSON 加引号，它可能被拆成多个 token。用单个空格拼接
  // 剩余部分；JSON 解析容忍 token 之间的任何空白，实践中能正常往返。
  if (i >= tokens.length) {
    return err(`Missing JSON body for "${name}". Wrap it in single quotes: '{...}'`)
  }
  const jsonBlob = tokens.slice(i).join(' ').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlob)
  } catch (e) {
    return err(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 我们使用与 loader 相同的 zod schema 校验，但把依赖放在 writer 层，
  // 以避免这里的循环导入——所以通过把解析出的对象当作 McpServerConfig 返回、
  // 让调用方去校验来标记"需要校验"。writer 在写入前确实会校验
  // （见 config-writer.ts）。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('JSON body must be an object')
  }
  return ok({ kind: 'add-json', name, scope, config: parsed as McpServerConfig })
}

/** 解析 /mcp remove [--scope ...] <name> 的参数。 */
export function parseRemove(rawArg: string): ParseResult<RemoveCommand> {
  const tokRes = tokenize(rawArg)
  if (!tokRes.ok) return tokRes
  const tokens = tokRes.tokens
  if (tokens.length === 0) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }

  const scopeResult = parseScopeOnlyFlags(tokens, undefined, 'remove')
  if (!scopeResult.ok) return scopeResult
  const { scope, nextIndex: i } = scopeResult

  if (i >= tokens.length) {
    return err('Usage: /mcp remove [--scope user|project] <name>')
  }
  if (i + 1 < tokens.length) {
    return err(`/mcp remove takes exactly one name (got extra: ${tokens.slice(i + 1).join(' ')})`)
  }
  const name = tokens[i]!
  if (!NAME_RE.test(name)) {
    return err(`Invalid server name "${name}". Must match ${NAME_RE.source}.`)
  }
  return ok({ kind: 'remove', name, scope })
}

// ── 内部实现 ──────────────────────────────────────────────────────────────

function ok<T extends ParsedCommand>(command: T): ParseResult<T> {
  return { ok: true, command }
}
function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message }
}

type ScopeParseResult<TScope extends ConfigScope | undefined> =
  | { ok: true; scope: TScope; nextIndex: number }
  | { ok: false; error: string }

function parseScopeValue(tokens: readonly string[], index: number): ScopeParseResult<ConfigScope> {
  const value = tokens[index + 1]
  if (value !== 'user' && value !== 'project') {
    return err(`--scope requires "user" or "project" (got ${value ?? '(missing)'})`)
  }
  return { ok: true, scope: value, nextIndex: index + 2 }
}

function parseScopeOnlyFlags(
  tokens: readonly string[],
  initialScope: ConfigScope,
  commandName: string,
): ScopeParseResult<ConfigScope>
function parseScopeOnlyFlags(
  tokens: readonly string[],
  initialScope: undefined,
  commandName: string,
): ScopeParseResult<ConfigScope | undefined>
function parseScopeOnlyFlags(
  tokens: readonly string[],
  initialScope: ConfigScope | undefined,
  commandName: string,
): ScopeParseResult<ConfigScope | undefined> {
  let scope = initialScope
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '--scope') {
      const scopeResult = parseScopeValue(tokens, index)
      if (!scopeResult.ok) return scopeResult
      scope = scopeResult.scope
      index = scopeResult.nextIndex
      continue
    }
    if (!token.startsWith('-')) break
    return err(`Unknown flag for ${commandName}: ${token}`)
  }

  return { ok: true, scope, nextIndex: index }
}

/** 极简的 POSIX 风格 tokenizer。支持 "..." / '...' 引号，以及任意单个字符的
 *  反斜杠转义。输出中会剥掉引号；转义会去掉反斜杠。返回带标记的结果，
 *  使调用方可以抛出"未闭合引号"而不必 throw。 */
export function tokenize(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    // 跳过 token 之间的空白。
    while (i < n && /\s/.test(input[i]!)) i++
    if (i >= n) break

    let token = ''
    let quote: '"' | "'" | null = null
    let inToken = true

    while (i < n && inToken) {
      const c = input[i]!
      if (quote) {
        if (c === '\\' && quote === '"' && i + 1 < n) {
          // 双引号内部，允许对 " 和 \ 做反斜杠转义。
          const next = input[i + 1]!
          if (next === '"' || next === '\\') {
            token += next
            i += 2
            continue
          }
          // 否则保留字面反斜杠——POSIX 行为。
          token += c
          i++
          continue
        }
        if (c === quote) {
          quote = null
          i++
          continue
        }
        token += c
        i++
        continue
      }
      // 未加引号。
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '\\' && i + 1 < n) {
        // 只转义空白、引号和反斜杠本身。其他字符连同反斜杠一起原样透传，
        // 使 `D:\res\x-code-cli\tmp` 这类 Windows 路径得以保留——吞掉这些
        // 反斜杠会悄悄破坏路径，用户要到 MCP 服务器无法访问该目录时才会发现。
        const next = input[i + 1]!
        if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
          token += next
          i += 2
          continue
        }
        // 反斜杠后跟其他任何字符：两个字符都按字面保留。
        token += c
        i++
        continue
      }
      if (/\s/.test(c)) {
        inToken = false
        break
      }
      token += c
      i++
    }
    if (quote) {
      return { ok: false, error: `Unclosed ${quote} quote` }
    }
    tokens.push(token)
  }
  return { ok: true, tokens }
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
