// @x-code-cli/core — 共享的最小 YAML frontmatter 解析器
//
// 供命令、技能和子 agent 加载器使用。在不依赖 gray-matter 的情况下处理
// 我们所需的子集：字符串标量、数字标量、内联/流式数组、折叠续行、引号剥离
// 以及注释行。每个使用方都会再用 Zod 或领域专用逻辑进一步校验解析结果。

export interface FrontmatterResult {
  data: Record<string, unknown>
  body: string
}

export interface ParseFrontmatterOptions {
  /** 为 true 时，把 `[a, b]` 解析为字符串数组、把纯数字值解析为数字。
   *  为 false（默认）时所有值保持字符串。子 agent 需要它来解析
   *  `tools: [...]` 和 `maxTurns: 10`；命令和技能则不需要。 */
  coerceTypes?: boolean
  /** 记忆主题模式：块列表（`key:` 后跟缩进的 `- item` 行）、`true`/`false`
   *  布尔标量、`[a, b]` 内联数组，以及严格校验——无法识别的行会抛出而不是被
   *  跳过。 */
  blockLists?: boolean
}

/** blockLists 模式下的标量解析：布尔值、JSON 风格双引号，以及 YAML 风格
 *  单引号（转义为 ''）。 */
function parseBlockListScalar(value: string): string | boolean {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

/** 从 markdown 文件开头解析以 `---` 分隔的 YAML frontmatter 块。
 *  若未找到有效栅栏则返回 null。
 *
 *  支持：
 *  - 缩进续行（折叠进上一行）
 *  - 内联数组：`key: [a, b, c]`（当 coerceTypes=true 时）
 *  - 整数标量：`key: 42`（当 coerceTypes=true 时）
 *  - 带引号的字符串标量（单引号或双引号）
 *  - 注释行（以 `#` 开头的行） */
export function parseFrontmatter(raw: string, options?: ParseFrontmatterOptions): FrontmatterResult | null {
  const coerce = options?.coerceTypes ?? false
  const blockLists = options?.blockLists ?? false
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = blockLists ? match[2]!.replace(/\r\n/g, '\n') : match[2]!
  const data: Record<string, unknown> = {}

  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (blockLists) {
      if (/^\s+-\s/.test(line)) foldedLines.push(line)
      else if (/^\s/.test(line) && line.trim()) throw new Error(`Unsupported frontmatter line: ${line.trim()}`)
      else foldedLines.push(line)
      continue
    }
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  let arrayKey: string | null = null
  for (const line of foldedLines) {
    if (blockLists) {
      const item = line.match(/^\s+-\s+(.*)$/)
      if (item && arrayKey) {
        const list = data[arrayKey]
        if (Array.isArray(list)) list.push(String(parseBlockListScalar(item[1]!)))
        continue
      }
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (blockLists && (colonIdx < 1 || !/^[a-z_]+$/.test(trimmed.slice(0, colonIdx)))) {
      throw new Error(`Unsupported frontmatter line: ${trimmed}`)
    }
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    if (blockLists) {
      arrayKey = null
      if (!value) {
        data[key] = []
        arrayKey = key
      } else if (value.startsWith('[') && value.endsWith(']')) {
        data[key] = value
          .slice(1, -1)
          .split(',')
          .map((item) => String(parseBlockListScalar(item)))
      } else {
        data[key] = parseBlockListScalar(value)
      }
      continue
    }

    if (coerce && value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      data[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (coerce && typeof value === 'string' && /^\d+$/.test(value)) {
      data[key] = parseInt(value, 10)
      continue
    }

    data[key] = value
  }

  return { data, body }
}
