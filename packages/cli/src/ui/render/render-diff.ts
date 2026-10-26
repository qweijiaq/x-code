// @x-code-cli/cli — 把 writeFile / edit 的 diff 负载渲染成 ANSI 文本。
//
// 输出是准备好交给滚动区写入器的多行字符串。布局仿照 Claude Code 的
// StructuredDiff：每行的槽位带右对齐行号 + 记号，然后是语法高亮的代码。红/绿背景
// 用 BCE 擦除（bg span 内的 `\x1b[K`）而不是空格填充铺到右边缘，这样终端调整大小
// 时的滚动区重排就没有可打印的填充单元格可拆成幽灵行。
//
// 每行渲染结果都加 RESULT_INDENT 前缀，让 diff 在滚动区里正好坐在工具调用圆点下方
// （`   ⎿  Added X lines, removed Y` 头，然后是 6 空格缩进的 diff 主体）。
//
// 两条渲染路径共享同样的槽位 / 列 / 高亮管线：
//   - update 路径（`renderHunks`）：带绿/红背景 + 记号的 hunk
//   - create 路径（`renderCreatePreview`）：新内容的前 N 行，无 diff 背景（整个文件
//     都是「新」的——每行都上背景色会是视觉噪音），但同样的语法高亮和槽位风格。
import { stripTerminalControls } from '@x-code-cli/core'
import type { EditDiffHunk, EditDiffPayload } from '@x-code-cli/core'

import { RESULT_INDENT } from '../utils.js'
import { type SyntaxThemeName, applyColor, detectLanguage, highlightLine } from './syntax-highlight.js'
import { sliceByWidth, visualWidth } from './text-width.js'
import { type ThemeName, getThemeColors } from './theme.js'
import { chalk as c } from './tokens.js'

/** 把主题的 diff 背景色应用到文本。三种取值形态：
 *   - `'#rrggbb'` — 真彩十六进制，经 chalk.bgHex
 *   - `'ansi:default'` — 背景保持不动（终端默认）。仅 ANSI 的主题用这个，并依赖彩
 *     色 DECORATION 前景来标记 `-` 行；上背景色会过度覆盖用户的终端背景。
 *   - `'ansi:green'` / `'ansi:red'` — 命名 ANSI 背景（当前未用，但为完整起见保留）。 */
function applyBg(text: string, color: string): string {
  if (color === 'ansi:default') return text
  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    if (name === 'green') return c.bgGreen(text)
    if (name === 'red') return c.bgRed(text)
    if (name === 'blue') return c.bgBlue(text)
    if (name === 'yellow') return c.bgYellow(text)
    return text
  }
  return c.bgHex(color)(text)
}

/** 应用主题的槽位（行号 + 记号）前景色。与 applyBg 对应——同样的取值形态，前景侧。
 *  CC 用饱和的装饰色涂槽位，让行号列从近黑背景上跳出来；没有它，「1 +」会消失在
 *  diff 背景里。 */
function applyGutterFg(text: string, color: string): string {
  if (color === 'ansi:green') return c.green(text)
  if (color === 'ansi:red') return c.red(text)
  if (color === 'ansi:blue') return c.blue(text)
  if (color === 'ansi:yellow') return c.yellow(text)
  if (color.startsWith('#')) return c.hex(color)(text)
  return text
}

/** 封顶单个 diff 主体的高度。数百行的多 hunk 补丁在滚动区里没用（用户反正会滚过大
 *  部分）；封顶后我们折叠成 `… +N more lines` 行。与 Claude Code 裁剪长结构化 diff
 *  的行为一致。 */
const MAX_DIFF_LINES = 60

/** create 模式内容预览的封顶。Claude Code 的 FileWriteToolCreatedMessage 用
 *  MAX_LINES_TO_RENDER = 10；我们沿用同样数字，让新建的 package.json / 配置文件显示
 *  到足够有用，又不至于霸占滚动区。 */
const MAX_CREATE_PREVIEW_LINES = 10

/** 格式化计数摘要行（"Added 3 lines, removed 1 line"）。 */
function formatCounts(p: EditDiffPayload): string {
  if (p.isCreate) {
    const n = p.additions
    return `Created ${c.bold(String(n))} ${n === 1 ? 'line' : 'lines'}`
  }
  const parts: string[] = []
  if (p.additions > 0) {
    parts.push(`Added ${c.bold(String(p.additions))} ${p.additions === 1 ? 'line' : 'lines'}`)
  }
  if (p.removals > 0) {
    const verb = parts.length > 0 ? 'removed' : 'Removed'
    parts.push(`${verb} ${c.bold(String(p.removals))} ${p.removals === 1 ? 'line' : 'lines'}`)
  }
  if (parts.length === 0) return 'No changes'
  return parts.join(', ')
}

/** 挑出所有 hunk 里最大的可见行号，让每个槽位等宽——保持记号列跨 hunk 对齐。 */
function maxLineNumber(hunks: EditDiffHunk[]): number {
  let max = 1
  for (const h of hunks) {
    const o = h.oldStart + h.oldLines - 1
    const n = h.newStart + h.newLines - 1
    if (o > max) max = o
    if (n > max) max = n
  }
  return max
}

/** 遍历 hunk 的 `lines` 数组，给每行分配它相对文件的行号。遵循标准统一 diff 约定：
 *  `-` 行按 OLD 文件编号，`+` 行和上下文行按 NEW 文件编号。每个计数器独立推进，这样
 *  连续的 remove 行得到不同的旧文件行号。 */
function numberLines(h: EditDiffHunk): { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] {
  const out: { sigil: ' ' | '+' | '-'; code: string; lineNum: number }[] = []
  let oldN = h.oldStart
  let newN = h.newStart
  for (const raw of h.lines) {
    const sigil = raw[0] === '+' ? '+' : raw[0] === '-' ? '-' : ' '
    const code = stripTerminalControls(raw.slice(1))
    if (sigil === '-') {
      out.push({ sigil, code, lineNum: oldN })
      oldN++
    } else if (sigil === '+') {
      out.push({ sigil, code, lineNum: newN })
      newN++
    } else {
      out.push({ sigil, code, lineNum: newN })
      oldN++
      newN++
    }
  }
  return out
}

/** 截断单行代码，让渲染行放进列内。宽度预算是终端宽度减去缩进和槽位。我们用 UTF
 *  省略号标记截断处，与工具输入预览一致。
 *
 *  适配检查和切片都按视觉列操作，而不是 JS 字符串单位。CJK / 全角字符占 2 个单元
 *  格但 `length === 1`，所以基于长度的检查会让 50 字符的中文行溜过 100 单元格的预算，
 *  实际却超了 50 个单元格——终端随后会在行中间折行，并在每条 diff 行下面产生一行多余
 *  的空白。 */
function fitCode(code: string, width: number): string {
  if (visualWidth(code) <= width) return code
  if (width < 1) return ''
  return sliceByWidth(code, Math.max(0, width - 1)) + '…'
}

/**
 * 渲染 diff 主体。返回有 N 行的字符串（无前导或尾随换行）。每行已经用 RESULT_INDENT
 * 缩进。
 *
 * `terminalWidth` 是完整终端宽度——函数为缩进预留 RESULT_INDENT.length 个单元格，并
 * 从剩余部分计算槽位 + 代码列。终端宽度未知 / 不合理时回退到 120。
 */
function renderHunks(
  payload: EditDiffPayload,
  terminalWidth: number,
  syntaxTheme?: SyntaxThemeName,
  /** 用来读取 diff 背景色的 UI 主题。`undefined` → 使用模块级活动主题（真实渲染）。
   *  `/theme` 选择器在构建预览时传入每个候选主题的名字，让用户并排看到每个主题实际
   *  的 diff 颜色。 */
  uiTheme?: ThemeName,
): string[] {
  const themeColors = getThemeColors(uiTheme)
  // ANSI 模式由 `'ansi:default'` 背景哨兵检测——这些主题不能涂十六进制背景（16 色兼
  // 容），所以它们改用 dim 风格来表示 remove 行。对应 CC 的 color-diff/index.ts:924。
  const isAnsiMode = themeColors.diffAdded === 'ansi:default'
  // CC 用 `Theme.foreground`（暗 #f8f8f2 / 亮 #333333）涂 diff 行里未高亮的文本。没有
  // 它，我们未匹配的字符会回退到终端默认的 `#cccccc`，读起来比 CC 明显更暗。ANSI 主
  // 题传 null（尊重终端调色板）。
  const defaultFg = themeColors.defaultFg
  const cols = Math.max(40, terminalWidth)
  const lineNumWidth = Math.max(1, String(maxLineNumber(payload.hunks)).length)
  // 槽位格式：" <num> <sigil> " — 1 前导空格 + num + 1 空格 + sigil + 1 尾随空格。
  const gutterWidth = lineNumWidth + 4
  // 预留 1 个尾随安全单元格：如果行的可打印宽度恰好命中 `cols`，终端会在最后一列进
  // 入延迟折行状态；某些配置下的 Windows conhost / Windows Terminal 会把它算作一次折
  // 行，并在每条 `-`/`+` 行下面插入一行幽灵空白行。把预算保持在 cols-1，让光标严格停
  // 在行内。
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth - 1)
  const lang = detectLanguage(payload.filePath)

  const out: string[] = []
  let emitted = 0
  let truncated = 0

  for (let hi = 0; hi < payload.hunks.length; hi++) {
    if (hi > 0) {
      // Hunk 分隔符——Claude Code 用一行调暗的 `...`。
      out.push(`${RESULT_INDENT}${c.gray('...')}`)
    }
    const hunk = payload.hunks[hi]!
    const numbered = numberLines(hunk)
    for (const { sigil, code, lineNum } of numbered) {
      if (emitted >= MAX_DIFF_LINES) {
        truncated++
        continue
      }
      emitted++

      const numStr = String(lineNum).padStart(lineNumWidth)
      const fitted = fitCode(code, codeWidth)
      // 背景带通过 bg span 内部发出的 `\x1b[K` 到达右边缘：在支持 BCE 的终端
      // （xterm.js、WT、conhost）上，擦除会填满该行的背景色。我们刻意不用背景色空格
      // 填充——填充行可打印到旧的终端宽度，所以终端后来变窄时，其滚动区重排会把每条
      // 填充行拆成内容 + 一行多余的背景色空白行（每条 diff 行一个幽灵行）。在非 BCE
      // 终端上，背景带就在代码文本后结束。
      const gutter = ` ${numStr} ${sigil} `
      // 语法高亮只应用于 CONTEXT 行。在 +/- 行上，我们在 diff 背景之上渲染纯文本——
      // 饱和红/绿带之上再叠多色高亮在视觉上互相打架，读起来像噪音。Claude Code 的回
      // 退 diff 也出于同样原因把 diff 主体渲染成背景上的纯文本；背景单独传达增/删，
      // 周围的上下文行给眼睛提供全色锚点。
      let styled: string
      if (sigil === '+') {
        // `+` 行：背景 + 装饰槽位 + 语法高亮代码。
        // CC 始终高亮 `+` 行（它们就是新代码）。
        // 我们在把整行包进背景之前，先用主题的 add 装饰色预涂槽位，让彩色前景站得住。
        // defaultFg 被贯穿传入，这样未匹配字符（`;`、`(`、`)`、`{`、`}`）和未装饰的
        // 标识符（例如 `console.log` 里的 `log`）得到 CC 的亮奶油色/暗灰，而不是终端
        // 默认白。
        const code = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        const coloredGutter = applyGutterFg(gutter, themeColors.diffAddedDecoration)
        styled = applyBg(coloredGutter + code + '\x1b[K', themeColors.diffAdded)
      } else if (sigil === '-') {
        // `-` 行：背景 + 装饰槽位 + 纯代码（永不做语法高亮——包括在选择器预览里）。
        // CC 的 color-diff/index.ts:916-918 总是把 `-` 行经过 `defaultStyle(theme)` 而
        // 不是 highlightLine，所以删除文本在真实 diff 和主题预览里都是白字红底。饱和红
        // 背景上再叠多色前景同样在视觉上自相打架；纯文本读起来更像「这东西要被删掉」。
        // 不过我们确实应用 defaultFg——CC 的 `defaultStyle` 正是靠它让删除文本比终端
        // 默认更亮。
        const plainCode = defaultFg ? applyColor(fitted, defaultFg) : fitted
        const coloredGutter = applyGutterFg(gutter, themeColors.diffRemovedDecoration)
        let row = applyBg(coloredGutter + plainCode + '\x1b[K', themeColors.diffRemoved)
        // ANSI 模式没有背景来标记 remove 行，所以改为调暗整行——对应 CC 的
        // `dimContent`（color-diff/index.ts:924）。没有这个，ANSI 模式下的 `-` 行在视觉
        // 上与 `+` 行无法区分。
        if (isAnsiMode) row = c.dim(row)
        styled = row
      } else {
        // 上下文行：完整语法高亮、无背景、槽位用默认前景（对应 CC 对 marker===' '
        // 的 addLineNumber 路径）。这里的 defaultFg 让上下文行与 +/- 行的亮度保持一致
        // ——CC 三者都从同一个 Theme.foreground 上色。
        const highlighted = highlightLine(fitted, lang, syntaxTheme, defaultFg)
        styled = gutter + highlighted
      }
      out.push(`${RESULT_INDENT}${styled}`)
    }
  }

  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} more line${truncated === 1 ? '' : 's'}`)}`)
  }

  return out
}

/**
 * 把新建文件内容的前约 10 行渲染成预览块。与 update 路径同样的槽位风格 + 语法高亮
 * ——create 与 update 在视觉上的区别在于没有 diff 背景：给全新文件的每一行都上绿色背
 * 景会是视觉噪音，却不传达任何信息（没有东西可与之对比）。截断的尾部折叠成
 * `… +N lines`。
 */
function renderCreatePreview(
  filePath: string,
  content: string,
  terminalWidth: number,
  theme?: SyntaxThemeName,
): string[] {
  const cols = Math.max(40, terminalWidth)
  const allLines = stripTerminalControls(content).split('\n')
  // 丢掉单个尾随空行——多数文件内容以 `\n` 结尾，split 会产生一个我们不想渲染的空
  // 字符串。
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  if (allLines.length === 0) return []

  const visible = allLines.slice(0, MAX_CREATE_PREVIEW_LINES)
  const truncated = allLines.length - visible.length
  const lineNumWidth = Math.max(1, String(allLines.length).length)
  const gutterWidth = lineNumWidth + 2 // " <num> "
  const codeWidth = Math.max(1, cols - RESULT_INDENT.length - gutterWidth)
  const lang = detectLanguage(filePath)

  const out: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const numStr = String(i + 1).padStart(lineNumWidth)
    const fitted = fitCode(visible[i] ?? '', codeWidth)
    const highlighted = highlightLine(fitted, lang, theme)
    out.push(`${RESULT_INDENT}${c.gray(` ${numStr} `)}${highlighted}`)
  }
  if (truncated > 0) {
    out.push(`${RESULT_INDENT}${c.gray(`… +${truncated} ${truncated === 1 ? 'line' : 'lines'}`)}`)
  }
  return out
}

/**
 * 把完整 diff 块（计数头 + hunk 主体或内容预览）渲染为工具调用结果行的主体。第一行
 * 应当跟在 stdout-writer 发出的 `   ⎿  ` 前缀之后，所以我们不在这里前置该前缀——由
 * 调用方拼接一切。
 *
 * 返回：
 *   - line[0]：计数摘要（如 "Added 3 lines, removed 1 line" / "Created 20 lines"）
 *   - line[1..]：diff hunk（update 路径）或内容预览（create 路径）
 *
 * 没有 hunk 的 update 负载（diff 超时）折叠成仅头部——没有补丁可渲染。
 */
/** 在给定 UI 主题下渲染一个固定的 JS 片段 diff——供 `/theme` 和首次运行选择器显示
 *  聚焦选项的实时颜色预览。hunk 是手工构建的（4 行、1 处交换），而不是走
 *  computeEditDiff，这样选择器不会在冷路径上拖进 diff 库。
 *
 *  选择器传入候选主题的名字；我们查主题的 diff 颜色以及它关联的语法调色板，让预览
 *  同时展示主题的两个部分（背景 + 代码颜色）一起变化——这正是选择器的意义所在。
 *
 *  从每行去掉前导 RESULT_INDENT，让预览贴到对话框左边缘（它不是嵌在工具圆点下面——
 *  它是一个独立块）。 */
export function buildThemePreview(themeName: ThemeName, terminalWidth: number): string[] {
  const theme = getThemeColors(themeName)
  const payload: EditDiffPayload = {
    filePath: 'preview.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' function greet() {', '-  console.log("Hello, World!");', '+  console.log("Hello, X-Code!");', ' }'],
      },
    ],
    additions: 1,
    removals: 1,
    isCreate: false,
  }
  return renderHunks(payload, terminalWidth, theme.syntaxPalette, themeName).map((row) =>
    row.startsWith(RESULT_INDENT) ? row.slice(RESULT_INDENT.length) : row,
  )
}

export function renderEditDiff(payload: EditDiffPayload, terminalWidth: number, theme?: SyntaxThemeName): string[] {
  const header = formatCounts(payload)
  if (payload.isCreate) {
    if (!payload.content) return [header]
    return [header, ...renderCreatePreview(payload.filePath, payload.content, terminalWidth, theme)]
  }
  if (payload.hunks.length === 0) return [header]
  return [header, ...renderHunks(payload, terminalWidth, theme)]
}
