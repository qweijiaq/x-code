// @x-code-cli/cli — CJK 感知的视觉宽度辅助。
//
// JavaScript 的 `string.length` 统计的是 UTF-16 码元，但终端用两个单元格
// 渲染东亚宽字符。混用两者会破坏任何按列填充或按列预算截断的代码——
// 行宽超限、终端换行，于是每条含 CJK / 全角标点的行上都会出现一条多余
// 的空白「行」以及错位的列。
//
// 范围遵循 Unicode East_Asian_Width=Wide / Fullwidth（终端普遍按双宽渲染
// 的子集）。这是所有渲染器的唯一事实来源——chat-input 帧、滚动区 diff
// （render-diff）和 markdown 表格布局（render-markdown）。只在一处添加范围
// 而漏了另一处，正是本模块当初抽取出来要修复的对齐漂移。

function isWide(cp: number): boolean {
  return (
    // CJK 统一表意文字 + 扩展 A + 兼容表意文字
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // 谚文：字母 + 音节
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // 半角与全角形式（全角半区：0xff00-0xff60，符号：0xffe0-0xffe6）
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK 扩展 B-F
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // CJK 部首补充 + 康熙部首 + 表意文字描述符
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK 符号 + 平假名 + 片假名 + 注音符号 + 带圈 CJK + 兼容
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    // 彝文音节 + 彝文部首
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK 兼容形式
    (cp >= 0xfe30 && cp <= 0xfe4f)
  )
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const emojiRe = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const markRe = /^\p{Mark}+$/u

export function graphemes(str: string): string[] {
  return [...graphemeSegmenter.segment(str)].map((part) => part.segment)
}

export function graphemeAt(str: string, index: number): string | null {
  for (const part of graphemeSegmenter.segment(str)) {
    if (part.index === index) return part.segment
    if (part.index > index) break
    if (index < part.index + part.segment.length) return part.segment
  }
  return null
}

export function previousGraphemeBoundary(str: string, index: number): number {
  let previous = 0
  for (const part of graphemeSegmenter.segment(str)) {
    if (part.index >= index) break
    previous = part.index
  }
  return previous
}

export function nextGraphemeBoundary(str: string, index: number): number {
  for (const part of graphemeSegmenter.segment(str)) {
    const end = part.index + part.segment.length
    if (part.index >= index || end > index) return end
  }
  return str.length
}

export function charWidth(ch: string): number {
  if (!ch) return 0
  if (emojiRe.test(ch)) return 2
  for (const codePoint of ch) {
    if (markRe.test(codePoint)) continue
    return isWide(codePoint.codePointAt(0)!) ? 2 : 1
  }
  return 0
}

export function visualWidth(str: string): number {
  let w = 0
  for (const ch of graphemes(str)) w += charWidth(ch)
  return w
}

/** 取 `str` 视觉宽度不超过 `maxCols` 的最长前缀。
 *  在会跨边界的宽字符之前停下——绝不让一个宽单元格被拆到两行。 */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of graphemes(str)) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}
