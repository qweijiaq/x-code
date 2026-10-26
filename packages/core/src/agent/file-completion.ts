// @x-code-cli/core — 工作区文件索引与 @-提及排序
//
// 由 CLI（ChatInput）和桌面渲染器的 @ 菜单共享。扫描器是有界的，
// 且每个匹配操作都是无状态的：
//
//   1. detectAtToken — 光标是否位于某个 `@…` token 内，它跨越到哪里？
//   2. scoreAndRank — 用基名加权对条目做模糊排序。
//   3. applyCompletion — 把选中的路径拼接到缓冲区里。
//   4. scanWorkspaceFiles — 浅层优先、过滤后的工作区索引。
import fs from 'node:fs/promises'
import path from 'node:path'

export interface AtTrigger {
  /** 当光标位于一个 @-token 内、且其 '@' 在行首或前面是空白时为 true。 */
  active: boolean
  /** '@' 自身的位置（仅在 active 时有意义）。 */
  atIdx: number
  /** '@' 与光标之间的路径子串，不含可选的引号。 */
  query: string
  /** token 的右边界（光标处或之后的首个空白，或 text.length）。
   *  applyCompletion 会替换 text.slice(atIdx, tokenEnd)。 */
  tokenEnd: number
}

const INACTIVE: AtTrigger = { active: false, atIdx: -1, query: '', tokenEnd: -1 }

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

export function detectAtToken(text: string, cursor: number): AtTrigger {
  if (cursor < 0 || cursor > text.length) return INACTIVE
  let atIdx = text.lastIndexOf('@', Math.max(0, cursor - 1))
  while (atIdx >= 0) {
    if (atIdx > 0 && !isWhitespace(text[atIdx - 1] ?? '')) {
      atIdx = text.lastIndexOf('@', atIdx - 1)
      continue
    }

    const quote = text[atIdx + 1]
    if (quote === '"' || quote === "'") {
      let closingQuote = -1
      for (let index = atIdx + 2; index < text.length; index++) {
        if (text[index] === quote && text[index - 1] !== '\\') {
          closingQuote = index
          break
        }
      }
      const contentStart = atIdx + 2
      const contentEnd = closingQuote >= 0 ? closingQuote : text.length
      const tokenEnd = closingQuote >= 0 ? closingQuote + 1 : text.length
      if (cursor >= contentStart && cursor <= tokenEnd) {
        const query = text.slice(contentStart, Math.min(cursor, contentEnd)).split(`\\${quote}`).join(quote)
        return { active: true, atIdx, query, tokenEnd }
      }
    } else {
      let tokenEnd = atIdx + 1
      while (tokenEnd < text.length && !isWhitespace(text[tokenEnd] ?? '')) tokenEnd++
      if (cursor >= atIdx + 1 && cursor <= tokenEnd) {
        return {
          active: true,
          atIdx,
          query: text.slice(atIdx + 1, cursor),
          tokenEnd,
        }
      }
    }
    atIdx = atIdx === 0 ? -1 : text.lastIndexOf('@', atIdx - 1)
  }
  return INACTIVE
}

export interface FileEntry {
  /** 相对 cwd 的 POSIX 风格路径。 */
  relPath: string
  isDirectory: boolean
}

export interface ScoredEntry extends FileEntry {
  score: number
}

function isHidden(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/')
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath
  return basename.startsWith('.')
}

/** 带连续段奖励的子序列匹配，未命中时返回 -Infinity。
 *  更靠前的匹配位置胜过更靠后的（有上限）。 */
function fuzzyScore(target: string, query: string): number {
  if (query.length === 0) return 0
  const t = target.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  let qi = 0
  let score = 0
  let consecutive = 0
  let firstMatchIdx = -1
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (firstMatchIdx === -1) firstMatchIdx = ti
      consecutive++
      score += 1 + consecutive
      qi++
    } else {
      consecutive = 0
    }
    ti++
  }
  if (qi < q.length) return -Infinity
  score += Math.max(0, 10 - firstMatchIdx)
  return score
}

function scoreEntry(entry: FileEntry, query: string): number {
  if (query.length === 0) {
    // 空查询：浅层路径优先；字母序的并列决胜由外层排序处理。
    const depth = entry.relPath.split('/').length
    return -depth
  }
  const slash = entry.relPath.lastIndexOf('/')
  const basename = slash >= 0 ? entry.relPath.slice(slash + 1) : entry.relPath
  // 基名匹配权重大，这样 `chat` 能把 ChatInput.tsx 排在深处
  // 的 `src/foo/chatter/util.ts` 之前。
  const baseScore = fuzzyScore(basename, query)
  if (baseScore !== -Infinity) return baseScore * 10
  return fuzzyScore(entry.relPath, query)
}

export function scoreAndRank(entries: FileEntry[], query: string): ScoredEntry[] {
  const showHidden = query.startsWith('.')
  const out: ScoredEntry[] = []
  for (const e of entries) {
    if (!showHidden && isHidden(e.relPath)) continue
    const score = scoreEntry(e, query)
    if (score === -Infinity) continue
    out.push({ ...e, score })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.relPath.localeCompare(b.relPath)
  })
  return out
}

/** 把选中的条目拼接到缓冲区，替换整个 @-token。
 *  目录带上尾部 '/'，让用户可以继续输入子路径；文件不带
 *  （光标停在路径末尾，方便用户继续组织提示词）。 */
export function applyCompletion(
  text: string,
  atIdx: number,
  tokenEnd: number,
  picked: { relPath: string; isDirectory: boolean },
): { text: string; cursor: number } {
  const completedPath = picked.relPath + (picked.isDirectory ? '/' : '')
  const quoted = /\s|["\\]/.test(completedPath)
  const insert = quoted ? `@"${completedPath.replace(/"/g, '\\"')}"` : `@${completedPath}`
  const before = text.slice(0, atIdx)
  const after = text.slice(tokenEnd)
  return {
    text: before + insert + after,
    cursor: atIdx + insert.length - (quoted && picked.isDirectory ? 1 : 0),
  }
}

const HARD_BLACKLIST: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.x-code',
  'out',
  'build',
  'coverage',
  '.turbo',
  '.cache',
])

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_MS = 200

interface SimpleIgnore {
  /** 在树中任意位置都匹配的裸名称（`node_modules`、`dist`）。 */
  names: Set<string>
  /** 含点的小写后缀（`.log`、`.tsbuildinfo`）。 */
  suffixes: Set<string>
}

const EMPTY_IGNORE: SimpleIgnore = { names: new Set(), suffixes: new Set() }

/** 用刻意简化的语义解析 .gitignore 内容字符串：
 *  - 跳过空行、注释（`#`）、否定（`!…`）
 *  - `*.ext`               → 后缀 `.ext`
 *  - `name` / `/name` / `name/`  → 裸名称（任意深度都匹配）
 *  - 任何中间含 `/`、`**`，或 `?` / `[` 的模式都被丢弃
 *
 *  这能覆盖硬黑名单漏掉的 90%+ 情况（`*.log`、`coverage`、
 *  `.DS_Store`、`*.tsbuildinfo`），又不必引入 `ignore` 包。
 *  忽略规则复杂的仓库只是无法充分受益于 gitignore 过滤 ——
 *  硬黑名单仍能挡住最严重的那些。 */
export function parseSimpleGitignore(content: string): SimpleIgnore {
  const names = new Set<string>()
  const suffixes = new Set<string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    if (line.startsWith('*.') && !line.slice(2).match(/[\\/*?[\]]/)) {
      suffixes.add(line.slice(1).toLowerCase())
      continue
    }
    const stripped = line.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!stripped) continue
    if (/[*?[\]/]/.test(stripped)) continue
    names.add(stripped)
  }
  return { names, suffixes }
}

async function loadIgnore(rootDir: string): Promise<SimpleIgnore> {
  try {
    const content = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf-8')
    return parseSimpleGitignore(content)
  } catch {
    return EMPTY_IGNORE
  }
}

export interface ScanOptions {
  rootDir: string
  signal?: AbortSignal
  maxEntries?: number
  maxMs?: number
  /** 覆盖 gitignore。测试注入点 —— 生产路径总是加载
   *  `<rootDir>/.gitignore`。 */
  ignore?: SimpleIgnore
}

/** 带三层过滤对 rootDir 做 BFS。即便在 Windows 上也产出 POSIX 风格的
 *  relPath，好与菜单显示的和用户正在输入的内容（正斜杠）一致。
 *  file-ingest.ts:118 会在后端归一化两种风格。 */
export async function scanWorkspaceFiles(opts: ScanOptions): Promise<FileEntry[]> {
  const { rootDir, signal, maxEntries = DEFAULT_MAX_ENTRIES, maxMs = DEFAULT_MAX_MS } = opts
  const ignore = opts.ignore ?? (await loadIgnore(rootDir))
  const start = Date.now()
  const result: FileEntry[] = []
  const queue: string[] = ['']

  const matchesSuffix = (name: string): boolean => {
    if (ignore.suffixes.size === 0) return false
    const lower = name.toLowerCase()
    for (const suf of ignore.suffixes) {
      if (lower.endsWith(suf)) return true
    }
    return false
  }

  while (queue.length > 0) {
    if (signal?.aborted) break
    if (Date.now() - start > maxMs) break
    if (result.length >= maxEntries) break

    const relDir = queue.shift()!
    const absDir = relDir === '' ? rootDir : path.join(rootDir, relDir)

    let dirents
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      const name = dirent.name
      if (HARD_BLACKLIST.has(name)) continue
      if (ignore.names.has(name)) continue
      if (dirent.isSymbolicLink()) continue

      const isDir = dirent.isDirectory()
      const isFile = dirent.isFile()
      if (!isDir && !isFile) continue
      if (isFile && matchesSuffix(name)) continue

      const relPath = relDir ? `${relDir}/${name}` : name
      result.push({ relPath, isDirectory: isDir })
      if (isDir) queue.push(relPath)
      if (result.length >= maxEntries) break
    }
  }

  return result
}
