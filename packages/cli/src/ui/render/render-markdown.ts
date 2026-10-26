// @x-code-cli/cli — Markdown 到 ANSI 的渲染器（基于 token）
//
// 移植自 Claude Code 的 src/utils/markdown.ts 里 formatToken()，适配为直接
// 写 stdout（无 React/Ink 包装）。用 marked.lexer() 把 Markdown 解析成 AST，
// 再用 chalk 把每个 token 递归渲染成 ANSI 样式文本。
//
// 样式选择：h1 是 bold+underline，h2/h3+ 是 bold（Codex 的档位——CC 的
// bold+italic+underline 三重叠加读起来太重）。引用用 U+258E ▎ 作为低调的
// 前缀竖条并配斜体文本，代码块原样输出文本且不缩进，行内代码和链接用品牌
// `primary` token，列表符号落在 `textDim` 灰色档（颜色保留给语义），链接
// 变成 OSC 8 超链接。所有颜色都通过 tokens.ts 解析，因此 `/theme` 切换对
// 已提交的 markdown 同样生效。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Token, type Tokens, marked } from 'marked'

import { stripTerminalControls } from '@x-code-cli/core'

import { highlightCodeShiki } from './shiki-highlight.js'
import { detectFenceLanguage, highlightLine } from './syntax-highlight.js'
import { GLYPH_BLOCKQUOTE_BAR, GLYPH_LIST_BULLET } from './terminal-glyphs.js'
import { visualWidth } from './text-width.js'
import { chalk as c, paint } from './tokens.js'

const EOL = '\n'

const BLOCKQUOTE_BAR = GLYPH_BLOCKQUOTE_BAR

let markedConfigured = false
function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  // 禁用删除线：模型经常用 ~N 表示「大约 N」，几乎从不是真正的删除线。
  // 与 Claude Code 一致。
  marked.use({
    tokenizer: {
      del() {
        return undefined as any
      },
    },
  })
}

// 快速路径：当文本不含任何 Markdown 标记时跳过完整 lexer。
// 覆盖短平句式的助手回复（最常见的情况）。
const MD_SYNTAX_RE = /[#*`|[>_~\-]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

// 去掉渲染器生成的 CSI 和 OSC 8 序列，让视觉宽度计算只统计可打印单元格。
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

function safeHyperlinkHref(href: string): string | null {
  if (!href || href.length > 4096) return null
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}

// 表格布局调用 text-width.js 的 `visualWidth`——唯一事实来源，让 `运算`
// 这类表头与 chat-input 帧和滚动区 diff 的计数一致。没有它，只要某个
// 渲染器的宽字符表缺少另一个渲染器有的 CJK 字符，表格右边框就会逐行左移。

function formatToken(
  token: Token,
  listDepth: number = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
      const bar = paint('textMuted')(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${c.italic(line)}` : line))
        .join(EOL)
    }

    case 'code': {
      const code = token as Tokens.Code
      const text = code.text ?? ''
      // 把围栏语言提示（` ```typescript`、` ```bash` 等）映射到我们支持的
      // 某个分词器。未知 / 缺失的语言落到纯文本——与之前的行为一致，
      // 只是不再是全局默认。
      // 引擎预热后优先用 shiki（TextMate 语法，约 50 种语言，跨行状态）；
      // 它对未知语言、超大代码块或 `ansi` 调色板返回 null——这些都会落到
      // 下面的内置正则路径。
      const shikiHighlighted = highlightCodeShiki(text, code.lang)
      if (shikiHighlighted !== null) return shikiHighlighted + EOL
      const lang = detectFenceLanguage(code.lang)
      if (!lang) return text + EOL
      // 逐行高亮，这样 `text` 里内嵌的 \n 不会被当成源码内容喂给分词器
      // （分词器的正则都是面向行的）。
      const highlighted = text
        .split('\n')
        .map((line) => highlightLine(line, lang))
        .join('\n')
      return highlighted + EOL
    }

    case 'codespan':
      return paint('primary')((token as Tokens.Codespan).text ?? '')

    case 'em':
      return c.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''))

    case 'strong':
      return c.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''))

    case 'heading': {
      const h = token as Tokens.Heading
      const content = (h.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
      // 标题后始终输出一个空行。即使源码是 `# H\n\nbody`，marked 也从不
      // 在标题和后续块之间产生 `space` token——空白被折进标题自己的 `raw`。
      // 没有这第二个 EOL，`# H\nbody` 会渲染成两个相邻且无间隔的行。
      // 与 Claude Code 一致。
      if (h.depth === 1) {
        return c.bold.underline(content) + EOL + EOL
      }
      return c.bold(content) + EOL + EOL
    }

    case 'hr': {
      // 全宽的低调分隔线（Codex 的轮次分隔比例），而非任意固定长度的横线。
      // `---` 需要自己的换行终止符——缺了它会让 `hr` 不输出换行，下一个
      // 块的内容就会落到与分隔线同一行。
      const cols = Math.max(20, (process.stdout.columns ?? 80) - 1)
      return paint('textMuted')('─'.repeat(cols)) + EOL
    }

    case 'image':
      return (token as Tokens.Image).href ?? ''

    case 'link': {
      const l = token as Tokens.Link
      if (l.href?.startsWith('mailto:')) {
        return l.href.replace(/^mailto:/, '')
      }
      const linkText = (l.tokens ?? []).map((t) => formatToken(t, 0, null, l as Token)).join('')
      const href = l.href ?? ''
      const plain = stripAnsi(linkText)
      const styled = c.underline(paint('primary')(plain && plain !== href ? linkText : href))
      // OSC 8 超链接：现代终端把显示文本渲染成可点击链接，悬停 / Ctrl+点击
      // 时显示 `href`。不支持 OSC 8 的旧终端会剥掉转义字节，只显示带下划线
      // 的显示文本——两个方向都是优雅降级。内联输出原始 URL 会让 web-fetch
      // 结果变成杂乱的 `text (url)text (url)...`。
      const safeHref = safeHyperlinkHref(href)
      return safeHref ? `\x1b]8;;${safeHref}\x1b\\${styled}\x1b]8;;\x1b\\` : styled
    }

    case 'list': {
      const list = token as Tokens.List
      return list.items
        .map((item, index) =>
          formatToken(item as Token, listDepth, list.ordered ? Number(list.start ?? 1) + index : null, list as Token),
        )
        .join('')
    }

    case 'list_item':
      return (token.tokens ?? [])
        .map((t) => `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token)}`)
        .join('')

    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('') + EOL

    case 'space':
      return EOL

    case 'br':
      return EOL

    case 'text': {
      const tx = token as Tokens.Text
      if (parent?.type === 'link') {
        // 链接内部——不要再包一层；link 处理器已经输出 OSC 8 序列。
        return tx.text
      }
      if (parent?.type === 'list_item') {
        // 视觉上可区分的符号，让渲染输出不会与原始 markdown 源码混淆。
        // 无序项在 textDim 灰色档得到 U+2022 •；有序项保留「N.」并以同样
        // 方式压暗。标记刻意不上色——颜色保留给语义（Codex/Kimi 约定），
        // 而且 unicode 标记已经能让人一眼看出 marked.lexer 解析过这个列表
        // （否则用户在渲染前后都看到 `-`，会以为什么都没发生）。
        const marker =
          orderedListNumber === null
            ? paint('textDim')(GLYPH_LIST_BULLET)
            : paint('textDim')(`${getListNumber(listDepth, orderedListNumber)}.`)
        const content = tx.tokens
          ? tx.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token)).join('')
          : tx.text
        return `${marker} ${content}${EOL}`
      }
      return tx.text
    }

    case 'table': {
      const tb = token as Tokens.Table

      const displayWidthOf = (tokens?: Token[]): number =>
        visualWidth(stripAnsi((tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')))

      const colWidths = tb.header.map((header, index) => {
        let max = displayWidthOf(header.tokens)
        for (const row of tb.rows) {
          max = Math.max(max, displayWidthOf(row[index]?.tokens))
        }
        return Math.max(max, 3)
      })

      // 制表符：画一个真正的 CLI 表格，而不是把 markdown 的竖线原样回显给用户。
      const TL = '\u250c',
        TR = '\u2510',
        TM = '\u252c'
      const BL = '\u2514',
        BR = '\u2518',
        BM = '\u2534'
      const ML = '\u251c',
        MR = '\u2524',
        MM = '\u253c'
      const H = '\u2500',
        V = '\u2502'

      const makeDivider = (left: string, mid: string, right: string): string =>
        left + colWidths.map((w) => H.repeat(w + 2)).join(mid) + right + EOL

      const padCell = (
        cell: { tokens?: Token[] },
        width: number,
        align: 'left' | 'center' | 'right' | null | undefined,
      ): string => {
        const content = (cell.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
        const displayWidth = displayWidthOf(cell.tokens)
        return padAligned(content, displayWidth, width, align)
      }

      const dim = paint('textMuted')
      let out = dim(makeDivider(TL, TM, TR))

      out += dim(V) + ' '
      tb.header.forEach((header, index) => {
        if (index > 0) out += ' ' + dim(V) + ' '
        out += c.bold(padCell(header, colWidths[index]!, tb.align?.[index]))
      })
      out += ' ' + dim(V) + EOL

      out += dim(makeDivider(ML, MM, MR))

      tb.rows.forEach((row) => {
        out += dim(V) + ' '
        row.forEach((cell, index) => {
          if (index > 0) out += ' ' + dim(V) + ' '
          out += padCell(cell, colWidths[index]!, tb.align?.[index])
        })
        out += ' ' + dim(V) + EOL
      })

      out += dim(makeDivider(BL, BM, BR))
      // `out` 已经以最后一条分隔线的 EOL 结尾——返回 `out + EOL` 会多加
      // 一个空行，然后相邻的 `space` token 又再翻一倍。
      return out
    }

    case 'escape':
      return (token as Tokens.Escape).text ?? ''

    case 'def':
    case 'del':
    case 'html':
      return ''
  }
  return ''
}

/**
 * 轻量的仅行内 markdown 到 ANSI 的转换。
 *
 * 处理 **bold**、*italic* 和 `code`——不处理块级内容。
 * 返回含 ANSI 转义序列的字符串，适合交给 ansiTextToCells() 使用。
 */
export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  text = stripTerminalControls(text)

  return (
    text
      // bold：**text** 或 __text__
      .replace(/(\*\*|__)(.+?)\1/g, (_m, _d, inner) => c.bold(inner as string))
      // italic：*text* 或 _text_（但 _ 不匹配词内）
      .replace(/(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\1(?!\w)/g, (_m, _d, inner) => c.italic(inner as string))
      // 行内代码：`code`
      .replace(/`([^`]+)`/g, (_m, inner) => paint('primary')(inner as string))
  )
}

/**
 * 把 Markdown 字符串转换为 ANSI 样式的终端文本。
 *
 * 保留 token 格式化器输出的末尾换行——调用方（stdout-writer）依赖它们
 * 做流式块边界判断。
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  text = stripTerminalControls(text)

  configureMarked()

  try {
    // 快速路径——纯文本的单段落
    if (!hasMarkdownSyntax(text)) {
      return text + EOL
    }
    const tokens = marked.lexer(text) as Token[]
    return tokens.map((t) => formatToken(t, 0, null, null)).join('')
  } catch {
    // 流式传输中出现部分/无效 Markdown——回退到原始文本，让用户仍能看到内容。
    return text
  }
}
