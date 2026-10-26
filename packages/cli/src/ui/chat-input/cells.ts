// 单元格 diff 渲染器的 Cell 表示 + 单元格构建器。
//
// 每一帧都是 Cell 的 2D 网格。ChatInput.tsx 里的 diff 循环遍历网格，只为自上一帧
// 以来 `(char, style)` 对发生变化的单元格输出 SGR/文本字节。`width` 让 diff 循环
// 能跳过 CJK 字符对的后半部分，而不必重发该字形。
import { stripTerminalControls } from '@x-code-cli/core'

import { charWidth, graphemes } from '../render/text-width.js'
import { S_NONE } from './palette.js'

export interface Cell {
  char: string
  style: string
  width: number
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

/** 把一行单元格渲染成单个 ANSI 样式字符串（无光标移动、无尾部擦除）。供滚动区
 *  提交的内联流路径使用，让帧行可以作为 `content + frame` 流的一部分发出。 */
export function renderRowToAnsi(cells: Cell[]): string {
  let out = '\x1b[0m'
  let lastStyle = '\x1b[0m'
  for (const cell of cells) {
    if (cell.style !== lastStyle) {
      out += cell.style
      lastStyle = cell.style
    }
    out += cell.char
  }
  return out + '\x1b[0m'
}

export function textToCells(text: string, style: string): Cell[] {
  const cells: Cell[] = []
  for (const ch of graphemes(stripTerminalControls(text))) cells.push({ char: ch, style, width: charWidth(ch) })
  return cells
}

/** 把已经含 ANSI SGR 转义的字符串解析成 Cell[]。供 select-options 对话框的
 *  预览窗格使用，让 render-diff 构建的 `/theme` 预览行（满是 fg/bg 颜色转义）
 *  能画进单元格缓冲，每个字符都带着它正确的活动样式。
 *
 *  每个单元格的 `style` 是 `\x1b[0m` 后跟此刻所有活动的 SGR 转义——单元格 diff
 *  发射器依赖每个单元格的样式自包含（它在转换时只 blit `cell.style` 而不先重置），
 *  所以我们总是以重置开头，抹掉上一个单元格留在终端 SGR 状态里的东西。SGR 重置
 *  （`\x1b[0m` / `\x1b[m`）清空活动栈；非重置转义则追加（我们懒得对 fg-vs-bg-vs-
 *  attr 桶做 diff，因为 ANSI 本身就处理了后写转义覆盖先写转义——这一行可能多发
 *  几个冗余字节，但总能正确渲染）。 */
export function ansiTextToCells(text: string): Cell[] {
  const cells: Cell[] = []
  const active: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b' && text[i + 1] === '[') {
      let j = i + 2
      while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++
      if (j >= text.length) {
        // 未终止——当作字面量处理并退出转义模式。
        i++
        continue
      }
      const escape = text.slice(i, j + 1)
      if (/^\x1b\[0?m$/.test(escape)) {
        active.length = 0
      } else if (/^\x1b\[[0-9;]*m$/.test(escape)) {
        active.push(escape)
      }
      // 非 SGR 的 CSI 序列直接跳过——它们本不该出现在预览行里，但我们不想让
      // 它们变成可见文本。
      i = j + 1
      continue
    }
    const unit = text.charCodeAt(i)
    if (unit <= 0x1f || unit === 0x7f || (unit >= 0x80 && unit <= 0x9f)) {
      i++
      continue
    }
    const style = active.length === 0 ? S_NONE : '\x1b[0m' + active.join('')
    cells.push({ char: ch, style, width: charWidth(ch) })
    i++
  }
  return cells
}
