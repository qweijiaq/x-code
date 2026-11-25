// @x-code-cli/core — sed -i 命令解析器 & 进程内替换
//
// 拦截简单的 `sed -i 's/pattern/replacement/flags' file` 命令，好让文件历史
// 检查点系统能追踪这次修改（正常的 shell 路径不会调用
// fileHistoryTrackEdit / 添加到 filesModified）。
//
// 只处理单文件、单表达式的替换。复杂管道、多文件 glob，以及非替换类的
// sed 程序（d、y、a 等）都落到真实 shell 执行。
export type SedEditInfo = {
  filePath: string
  pattern: string
  replacement: string
  flags: string
  extendedRegex: boolean
}

// ── Shell 分词器（简化版）──────────────────────────────────────────

/** 把 shell 命令字符串切成分词，尊重单引号和双引号。如果命令包含让它
 *  不安全去模拟的操作符（管道、重定向、&&、||、;、反引号、$()），返回
 *  null。 */
function tokenize(input: string): string[] | null {
  // 拒绝带 shell 操作符的命令 —— 太复杂，无法安全模拟
  if (/[|><;`]|&&|\|\||\$\(/.test(stripQuoted(input))) return null

  const tokens: string[] = []
  let current = ''
  let i = 0

  while (i < input.length) {
    const ch = input[i]!

    if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return null // 引号未闭合
      current += input.slice(i + 1, end)
      i = end + 1
      continue
    }

    if (ch === '"') {
      const end = findClosingDoubleQuote(input, i + 1)
      if (end === -1) return null
      current += input.slice(i + 1, end)
      i = end + 1
      continue
    }

    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 2
      continue
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      i++
      continue
    }

    current += ch
    i++
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}

/** 剥掉单引号与双引号包起来的子串，让操作符检测不会被引号内的字符触发
 *  （例如 `sed 's/a|b/c/'`）。 */
function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
}

function findClosingDoubleQuote(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++
      continue
    }
    if (s[i] === '"') return i
  }
  return -1
}

// ── BRE → ERE 转换占位符 ────────────────────────────────────────────

const PH_BACKSLASH = '\x00BS\x00'
const PH_PLUS = '\x00PL\x00'
const PH_QUESTION = '\x00QU\x00'
const PH_PIPE = '\x00PI\x00'
const PH_LPAREN = '\x00LP\x00'
const PH_RPAREN = '\x00RP\x00'

// ── 公共 API ──────────────────────────────────────────────────────────

/** 解析 shell 命令字符串。对简单的 `sed -i` 就地替换返回信息，对任何我们
 *  无法安全模拟的内容返回 null。 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()
  if (!/^\s*sed\s+/.test(trimmed)) return null

  const tokens = tokenize(trimmed.replace(/^\s*sed\s+/, ''))
  if (!tokens) return null

  let hasInPlace = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < tokens.length) {
    const arg = tokens[i]!

    // -i / --in-place（可带内联或分离的后缀）
    if (arg === '-i' || arg === '--in-place') {
      hasInPlace = true
      i++
      // macOS：-i ''（空备份后缀作为单独参数）
      if (i < tokens.length) {
        const next = tokens[i]
        if (typeof next === 'string' && !next.startsWith('-') && (next === '' || next.startsWith('.'))) {
          i++ // 消费备份后缀
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      hasInPlace = true // -i.bak 等
      i++
      continue
    }

    // -E / -r / --regexp-extended
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // -e / --expression（只允许一个）
    if (arg === '-e' || arg === '--expression') {
      if (expression !== null) return null
      if (i + 1 >= tokens.length) return null
      expression = tokens[i + 1]!
      i += 2
      continue
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // 未知标志 → 放弃
    if (arg.startsWith('-')) return null

    // 位置参数：先是表达式，再是文件路径
    if (expression === null) {
      expression = arg
    } else if (filePath === null) {
      filePath = arg
    } else {
      return null // 多个文件
    }
    i++
  }

  if (!hasInPlace || !expression || !filePath) return null

  // 解析 s/pattern/replacement/flags
  if (!expression.startsWith('s/')) return null
  const rest = expression.slice(2)

  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const ch = rest[j]!

    if (ch === '\\' && j + 1 < rest.length) {
      const escaped = ch + rest[j + 1]
      if (state === 'pattern') pattern += escaped
      else if (state === 'replacement') replacement += escaped
      else flags += escaped
      j += 2
      continue
    }

    if (ch === '/') {
      if (state === 'pattern') state = 'replacement'
      else if (state === 'replacement') state = 'flags'
      else return null // 多余的分隔符
      j++
      continue
    }

    if (state === 'pattern') pattern += ch
    else if (state === 'replacement') replacement += ch
    else flags += ch
    j++
  }

  if (state !== 'flags') return null

  if (!/^[gpimIM]*$/.test(flags)) return null

  return { filePath, pattern, replacement, flags, extendedRegex }
}

/** sed RHS 的解析结果：字面量片段、反向引用（`\1`…`\9`）或整段匹配（`&`）。 */
type SedReplacementPart = string | { group: number } | { whole: true }

/** RHS 里反斜杠转义到真实字符的映射（GNU sed 语义）。 */
const SED_REPLACEMENT_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  f: '\f',
  v: '\v',
  a: '\x07',
  '\\': '\\',
  '&': '&',
  '/': '/',
}

/**
 * 把 sed 的替换串解析成片段，交给函数式 replace 自己拼装结果。
 *
 * 直接把它当 JS 替换字符串用会有三处语义错位：`\1` 是 sed 的反向引用而 JS
 * 里 `\` 只是字面量；`$&`/`` $` ``/`$'`/`$n` 在 JS 里是特殊序列而在 sed 里 `$`
 * 是普通字符；`\n`/`\t` 在 GNU sed 的 RHS 里会产生真实换行/制表符。函数式
 * 替换一次性绕开全部特殊序列。
 */
function parseSedReplacement(replacement: string): SedReplacementPart[] {
  const parts: SedReplacementPart[] = []
  let literal = ''
  const flush = (): void => {
    if (literal.length > 0) {
      parts.push(literal)
      literal = ''
    }
  }

  let i = 0
  while (i < replacement.length) {
    const ch = replacement[i]!
    if (ch === '\\') {
      const next = replacement[i + 1]
      if (next === undefined) {
        literal += '\\'
        i++
        continue
      }
      if (next >= '1' && next <= '9') {
        flush()
        parts.push({ group: Number(next) })
        i += 2
        continue
      }
      // 无法识别的转义：GNU sed 直接丢掉反斜杠，保留字符本身。
      literal += SED_REPLACEMENT_ESCAPES[next] ?? next
      i += 2
      continue
    }
    if (ch === '&') {
      flush()
      parts.push({ whole: true })
      i++
      continue
    }
    literal += ch
    i++
  }
  flush()
  return parts
}

/** 把解析好的 RHS 片段按一次匹配的捕获组重新拼成字符串。 */
function buildSedReplacement(parts: SedReplacementPart[], match: string, groups: unknown[]): string {
  let out = ''
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part
    } else if ('whole' in part) {
      out += match
    } else {
      const value = groups[part.group - 1]
      out += typeof value === 'string' ? value : ''
    }
  }
  return out
}

/** 在进程内对内容应用 sed s/…/…/flags 替换。 */
export function applySedSubstitution(content: string, info: SedEditInfo): string {
  // sed 是按行处理的：不带 g 时每一行各替换首个匹配，`^`/`$` 也是行首/行尾
  // 锚点。用 String.replace 直接作用于全文只替换全文第一处，且 `^`/`$` 只匹配
  // 整个字符串的首尾 —— `sed -i 's/^/\/\/ /' file` 只会给第一行加注释。因此
  // 逐行应用，'m' 标志随之不再需要（每行内没有换行符）。
  let regexFlags = ''
  if (info.flags.includes('g')) regexFlags += 'g'
  if (info.flags.includes('i') || info.flags.includes('I')) regexFlags += 'i'

  let jsPattern = info.pattern.replace(/\\\//g, '/')

  if (!info.extendedRegex) {
    jsPattern = jsPattern
      .replace(/\\\\/g, PH_BACKSLASH)
      .replace(/\\\+/g, PH_PLUS)
      .replace(/\\\?/g, PH_QUESTION)
      .replace(/\\\|/g, PH_PIPE)
      .replace(/\\\(/g, PH_LPAREN)
      .replace(/\\\)/g, PH_RPAREN)
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(new RegExp(PH_BACKSLASH, 'g'), '\\\\')
      .replace(new RegExp(PH_PLUS, 'g'), '+')
      .replace(new RegExp(PH_QUESTION, 'g'), '?')
      .replace(new RegExp(PH_PIPE, 'g'), '|')
      .replace(new RegExp(PH_LPAREN, 'g'), '(')
      .replace(new RegExp(PH_RPAREN, 'g'), ')')
  }

  const parts = parseSedReplacement(info.replacement)

  try {
    const regex = new RegExp(jsPattern, regexFlags)
    return content
      .split('\n')
      .map((line) =>
        line.replace(regex, (...args: unknown[]) => {
          const match = String(args[0])
          // 回调尾部是 offset、string，以及（仅当正则含具名组时）groups 对象。
          const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
          const groupCount = args.length - 3 - (hasNamedGroups ? 1 : 0)
          return buildSedReplacement(parts, match, args.slice(1, 1 + groupCount))
        }),
      )
      .join('\n')
  } catch {
    return content
  }
}
