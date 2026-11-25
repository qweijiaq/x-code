// @x-code-cli/cli — 共享 UI 工具函数。
//
// 多个模块共用的小辅助函数。抽取到这里以避免各文件间复制粘贴导致漂移。
import type { DisplayToolCall } from '@x-code-cli/core'
import { getShellProvider } from '@x-code-cli/core'

// ── 布局常量 ───────────────────────────────────────────────────

/** 工具结果行的缩进，让正文对齐到 `   ⎿  ` 括号下方
 *  （3 空格 + 括号 + 2 空格 = 6 个单元格）。滚动区写入器（stdout-writer）
 *  和 diff 渲染器（render-diff）都在用。 */
export const RESULT_INDENT = '      '

// ── 行尾规范化 ──────────────────────────────────────────

/** 把行尾规范化为 `\n`。在任何终端写入前都至关重要：Windows 粘贴 / 剪贴板
 *  内容通常带 `\r\n` 或裸 `\r`，而终端里的裸 `\r` 表示「把光标移到当前行
 *  第 0 列」——后续字符会覆盖该行之前打印的内容。 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// ── 布尔参数解析 ───────────────────────────────────────────

/** 把字符串解析为布尔值供 CLI 参数使用。
 *  接受 `on/true/1/enable/enabled` → true，
 *  `off/false/0/disable/disabled` → false，
 *  其余 → null（调用方可显示错误）。 */
export function parseBooleanArg(s: string): boolean | null {
  const trimmed = s.trim().toLowerCase()
  if (trimmed === 'on' || trimmed === 'true' || trimmed === '1' || trimmed === 'enable' || trimmed === 'enabled')
    return true
  if (trimmed === 'off' || trimmed === 'false' || trimmed === '0' || trimmed === 'disable' || trimmed === 'disabled')
    return false
  return null
}

// ── 时长格式化 ────────────────────────────────────────────────

export interface DurationFmtOptions {
  /** 亚秒精度：时长 < 60s 时，秒字段保留的小数位数。默认 1。 */
  precision?: number
  /** 为 true 时，秒字段省略末尾的 's'。默认 false。 */
  compact?: boolean
}

/**
 * 把毫秒时长格式化为人类可读字符串。
 *   <1s  → `"120ms"`
 *   <60s → `"3.5s"`（精度来自 options）
 *   >=60s → `"2m 15s"`（compact && secs === 0 时为 `"2m"`）
 */
export function formatDuration(ms: number, opts: DurationFmtOptions = {}): string {
  const { compact = false } = opts
  const precision = Math.max(0, Math.floor(opts.precision ?? 1))
  // `durationMs` 通常来自 `Date.now()` 差值：时钟回拨或异常数据会给出 NaN / 负数，
  // 不设防就会渲染成 `"NaNm NaNs"` / `"-500ms"`。
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  // 先把秒按精度舍入再判断进位，否则 59.6s（precision 0）会走秒分支渲染成 "60s"。
  const scale = 10 ** precision
  const seconds = Math.round((ms / 1000) * scale) / scale
  if (seconds < 60) return `${seconds.toFixed(precision)}s`
  const minutes = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  // 59.6s 这类值四舍五入到整秒后是 60——进位到分钟，别渲染 "1m 60s"。
  if (secs === 60) return compact ? `${minutes + 1}m` : `${minutes + 1}m 0s`
  if (compact && secs === 0) return `${minutes}m`
  return `${minutes}m ${secs}s`
}

// ── 工具展示辅助 ───────────────────────────────────────────────

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** 对任意 provider 的 shell 命令工具（zsh / bash / powershell）返回 true。
 *  用于把命令预览路由到 shell 语法高亮——`Zsh(...)` 行里 codex 风格的
 *  彩色字符串/标志。 */
export function isShellToolName(toolName: string): boolean {
  const n = normalizeToolName(toolName)
  return n === 'shell' || n === 'bash'
}

export function isCollapsibleReadOnlyTool(toolName: string): boolean {
  return COLLAPSIBLE_READ_ONLY_TOOLS.has(normalizeToolName(toolName))
}

const COLLAPSIBLE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'readfile',
  'read',
  'fileingest',
  'glob',
  'grep',
  'search',
  'listdir',
  'ls',
])

/** 从工具入参里取第一个非空字符串。各 provider 的字段名并不统一
 *  （`filePath` / `file_path` / `path`），而 `as string` 断言在运行时什么都不校验
 *  ——数字 / 数组 / 对象会一路传到下游的 `.length` / `.slice`，或渲染成
 *  `[object Object]`。 */
function firstString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

const SHELL_LABELS: Record<string, string> = {
  bash: 'Bash',
  zsh: 'Zsh',
  powershell: 'PowerShell',
}

export function getToolLabel(toolName: string): string {
  const n = normalizeToolName(toolName)
  if (n === 'shell' || n === 'bash') return SHELL_LABELS[getShellProvider().type] ?? 'Shell'
  if (n === 'fileingest') return 'Attach'
  if (n === 'readfile' || n === 'read') return 'Read'
  if (n === 'writefile' || n === 'write') return 'Write'
  if (n === 'edit' || n === 'update') return 'Update'
  if (n === 'glob') return 'Glob'
  if (n === 'grep' || n === 'search') return 'Grep'
  if (n === 'listdir' || n === 'ls') return 'ListDir'
  if (n === 'websearch') return 'WebSearch'
  if (n === 'webfetch') return 'WebFetch'
  if (n === 'askuser') return 'AskUser'
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode'
  if (n === 'task') return 'Task'
  if (n === 'todowrite') return 'TodoWrite'
  return toolName
}

export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeToolName(toolName)

  if (n === 'shell' || n === 'bash') {
    return firstString(input, 'command')
  }

  if (
    n === 'readfile' ||
    n === 'read' ||
    n === 'fileingest' ||
    n === 'writefile' ||
    n === 'write' ||
    n === 'edit' ||
    n === 'update'
  ) {
    return firstString(input, 'filePath', 'file_path', 'path')
  }

  if (n === 'listdir' || n === 'ls') {
    return firstString(input, 'dirPath', 'dir_path', 'path')
  }

  if (n === 'glob' || n === 'grep' || n === 'search') {
    return firstString(input, 'pattern', 'query')
  }

  if (n === 'websearch' || n === 'webfetch') {
    return firstString(input, 'query', 'url')
  }

  if (n === 'task') {
    return firstString(input, 'description')
  }

  if (n === 'askuser') {
    const q = firstString(input, 'question')
    const firstLine = q.split(/\r?\n/)[0]?.trim() || ''
    return firstLine
  }

  // 兜底：显示第一个字符串值（不用 JSON.stringify）
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val
  }

  return ''
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatCompactionResult(tokensBefore: number, tokensAfter: number): string {
  const removed = Math.max(0, tokensBefore - tokensAfter)
  return `Conversation compressed (estimated): before ~${formatTokenCount(tokensBefore)}; removed ~${formatTokenCount(removed)}; after ~${formatTokenCount(tokensAfter)}.`
}

export interface ReadGroupSummary {
  label: string
  detail?: string
}

const TABLE_OUTPUT_MAX_LINES = 30

export function formatReadGroupSummary(tools: readonly DisplayToolCall[]): ReadGroupSummary {
  let attachCount = 0
  let readCount = 0
  let grepCount = 0
  let globCount = 0
  let lsCount = 0
  const readPaths: string[] = []

  for (const tc of tools) {
    const n = normalizeToolName(tc.toolName)
    if (n === 'fileingest') {
      attachCount++
      const p = firstString(tc.input, 'filePath', 'file_path', 'path')
      if (p) readPaths.push(basename(p))
    } else if (n === 'read' || n === 'readfile') {
      readCount++
      const p = firstString(tc.input, 'filePath', 'file_path', 'path')
      if (p) readPaths.push(basename(p))
    } else if (n === 'grep' || n === 'search') {
      grepCount++
    } else if (n === 'glob') {
      globCount++
    } else if (n === 'listdir' || n === 'ls') {
      lsCount++
    }
  }

  const clauses: string[] = []
  if (attachCount > 0) clauses.push(`attached ${attachCount} file${attachCount === 1 ? '' : 's'}`)
  if (readCount > 0) clauses.push(`read ${readCount} file${readCount === 1 ? '' : 's'}`)
  if (grepCount > 0) clauses.push(`searched for ${grepCount} pattern${grepCount === 1 ? '' : 's'}`)
  if (globCount > 0) clauses.push(`globbed ${globCount} pattern${globCount === 1 ? '' : 's'}`)
  if (lsCount > 0) clauses.push(`listed ${lsCount} director${lsCount === 1 ? 'y' : 'ies'}`)

  if (clauses.length > 0) {
    const first = clauses[0]!
    clauses[0] = first.charAt(0).toUpperCase() + first.slice(1)
  }
  const label = clauses.join(', ')

  let detail: string | undefined
  if (readPaths.length > 0) {
    const shown = readPaths.slice(0, 3).join(', ')
    const rest = readPaths.length > 3 ? `, +${readPaths.length - 3} more` : ''
    detail = shown + rest
  }

  return detail ? { label, detail } : { label }
}

export function getToolResultSummary(toolName: string, output: string | undefined, status: string): string | null {
  if (status === 'denied') return 'Denied by user'
  // 出错但没有输出（超时 / 被 kill 的 shell 常常如此）不能读作 “Done”——那正是
  // 下面注释想消除的「符号是红色、文字却说成功」的误导场景。
  if (!output) return status === 'error' ? 'Failed (no output)' : 'Done'

  // 下面的每工具成功摘要都是为正常路径写的（如 "Wrote file"、
  // "Applied changes"）。当工具出错时——权限拒绝、hook 拒绝、异常——
  // 这些欢快的消息具有误导性：符号渲染成红色，但文字仍读作成功。
  // 改为展示有界的错误文本，让用户不开调试日志也能看到真正原因。
  if (status === 'error' || /^Error(?:\s|:)/i.test(output.trimStart())) {
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
    return lines.length <= 3 ? lines.join('\n') : lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  const n = normalizeToolName(toolName)

  if (n === 'writefile' || n === 'write') {
    const m = output.match(/\((\d+) lines?\)/)
    if (m) return `Wrote ${m[1]} lines`
    return 'Wrote file'
  }

  if (n === 'edit' || n === 'update') {
    return 'Applied changes'
  }

  if (n === 'readfile' || n === 'read') {
    const lineCount = (output.match(/\n/g) || []).length + 1
    return `${lineCount} lines`
  }

  if (n === 'fileingest') return output

  if (n === 'listdir' || n === 'ls') {
    const entries = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return entries.length <= 6
      ? entries.join('\n')
      : entries.slice(0, 3).join('\n') + `\n... +${entries.length - 3} items`
  }

  if (n === 'glob') {
    const files = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${files.length} file${files.length !== 1 ? 's' : ''} matched`
  }

  if (n === 'grep' || n === 'search') {
    const lines = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    return `${lines.length} result${lines.length !== 1 ? 's' : ''}`
  }

  if (n === 'task') {
    const statsMatch = output.match(/<task_stats\s+tool_calls="(\d+)"\s+tokens="(\d+)"\s+duration_ms="(\d+)"\s*\/>/)
    const resultMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/)
    const body = resultMatch ? resultMatch[1]! : output.replace(/<task_stats[^/]*\/>/, '').trim()
    const lines = body
      .trim()
      .split('\n')
      .filter((l) => l.trim())

    if (statsMatch) {
      const toolCalls = parseInt(statsMatch[1]!, 10)
      const tokens = parseInt(statsMatch[2]!, 10)
      const durationMs = parseInt(statsMatch[3]!, 10)
      const toolStr = toolCalls === 1 ? '1 tool use' : `${toolCalls} tool uses`
      const tokenStr = formatTokenCount(tokens)
      const durStr = formatDuration(durationMs, { compact: true, precision: 0 })
      return `Done (${toolStr} · ${tokenStr} tokens · ${durStr})`
    }

    if (lines.length === 0) return 'Done'
    if (lines.length <= 3) return lines.join('\n')
    return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
  }

  if (n === 'websearch') {
    return 'Did 1 search'
  }

  if (n === 'webfetch') {
    return 'Fetched page'
  }

  if (n === 'shell' || n === 'bash') {
    // shell 结果的真实头部是 `Chunk ID: <uuid>` / `Wall time: 0.12s` /
    // `Process exited with code 0` / `Output:`（见 core 的
    // shell-session/format.ts），并不存在字面量 `exit code: 0` 开头的格式。
    // 不过滤这些元数据行，它们会被当成正文显示（含随机 uuid），`+N lines` 的
    // 行数也会被虚增。
    const text = output
      .trim()
      .replace(/^(?:chunk id:|wall time:|process exited with (?:code|signal|unknown status)|full output)[^\n]*$/gim, '')
      // `Output:` 只在独占一行时才是头部标签；正文里 `Output: 42` 这类内容要保留。
      .replace(/^Output:[ \t]*$/gim, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return 'Done'
    if (looksLikeTableOutput(lines)) return summarizeTableOutput(lines)
    if (lines.length <= 4) return lines.join('\n')
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  const lines = output
    .trim()
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return 'Done'
  if (lines.length <= 3) return lines.join('\n')
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
}

function looksLikeTableOutput(lines: readonly string[]): boolean {
  if (lines.length < 3) return false
  if (lines.some((line) => /[┌┬┐├┼┤└┴┘]/.test(line))) return true
  const markdownRows = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line))
  if (
    markdownRows.length >= 2 &&
    lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  ) {
    return true
  }
  return lines.filter((line) => /^\s*\+[-=+]+\+\s*$/.test(line)).length >= 2
}

function summarizeTableOutput(lines: readonly string[]): string {
  if (lines.length <= TABLE_OUTPUT_MAX_LINES) return lines.join('\n')
  const bottom = lines.at(-1)
  if (bottom && isTableBottomBorder(bottom)) {
    const head = lines.slice(0, TABLE_OUTPUT_MAX_LINES - 2)
    const omitted = lines.length - head.length - 1
    return [...head, `... +${omitted} lines`, bottom].join('\n')
  }
  const head = lines.slice(0, TABLE_OUTPUT_MAX_LINES - 1)
  return [...head, `... +${lines.length - head.length} lines`].join('\n')
}

function isTableBottomBorder(line: string): boolean {
  const trimmed = line.trim()
  return /[└┴┘]/.test(trimmed) || /^\+[-=+]+\+$/.test(trimmed)
}
