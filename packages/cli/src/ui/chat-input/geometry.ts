import { nextGraphemeBoundary, sliceByWidth, visualWidth } from '../render/text-width.js'

type VisualLine = { text: string; rawLineIdx: number; startCol: number }

export function computePostContentScrollRows(
  startRow: number,
  contentRows: number,
  frameTop: number,
  terminalRows: number,
): number {
  const naturalScroll = Math.max(0, startRow + contentRows - 1 - terminalRows)
  const effectiveContentEnd = Math.min(terminalRows, startRow + contentRows - 1 - naturalScroll)
  return Math.max(0, effectiveContentEnd - frameTop + 1)
}

/** 按 `vpWidth` 列把每条原始行软折成视觉行。 */
export function buildVisualLines(rawLines: string[], vpWidth: number): VisualLine[] {
  // 视口宽度为 0（或负数）时 `sliceByWidth` 对每个切片都返回空串，`advance` 退化
  // 成 1 个 grapheme——一条 10k 字符的行会产出 10k 条空文本视觉行（内存/渲染爆炸，
  // 文本还完全不可见）。先归一为至少 1 列。
  const width = vpWidth > 0 ? vpWidth : 1
  const visualLines: VisualLine[] = []
  for (let r = 0; r < rawLines.length; r++) {
    const line = rawLines[r]
    if (line.length === 0) {
      visualLines.push({ text: '', rawLineIdx: r, startCol: 0 })
      continue
    }
    let pos = 0
    while (pos < line.length) {
      const chunk = sliceByWidth(line.slice(pos), width)
      // `sliceByWidth` 可能返回空串（视口比行首那个宽字符还窄）：此时必须至少前进
      // 一个 grapheme。退回 `line.length - pos` 会把该行剩余内容整段丢掉——只
      // push 一条 `text: ''` 的视觉行，用户输入的文本在 UI 上「凭空消失」，
      // `locateVisualCursor` 也会算出错误的光标位置。
      const advance = chunk.length > 0 ? chunk.length : Math.max(1, nextGraphemeBoundary(line, pos) - pos)
      visualLines.push({ text: chunk, rawLineIdx: r, startCol: pos })
      pos += advance
    }
  }
  return visualLines
}

/** 把原始光标偏移映射到 (视觉行, 视觉行内的列)。 */
export function locateVisualCursor(
  visualLines: VisualLine[],
  rawLines: string[],
  cursor: number,
): { line: number; col: number } {
  // 先把光标夹到合法范围：越界偏移会让下面的匹配全部落空，函数静默返回
  // `{ line: 0, col: 0 }`，调用方看到的是「光标突然跳到文本开头」。
  const totalLength = Math.max(
    0,
    rawLines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, rawLines.length - 1),
  )
  cursor = Math.max(0, Math.min(cursor, totalLength))
  let rawCursorLine = 0
  let cursorColInRaw = cursor
  let charsSoFar = 0
  for (let i = 0; i < rawLines.length; i++) {
    if (cursor >= charsSoFar && cursor <= charsSoFar + rawLines[i].length) {
      rawCursorLine = i
      cursorColInRaw = cursor - charsSoFar
      break
    }
    charsSoFar += rawLines[i].length + 1
  }
  for (let v = 0; v < visualLines.length; v++) {
    const visualLine = visualLines[v]
    if (visualLine.rawLineIdx !== rawCursorLine) continue
    const endCol = visualLine.startCol + visualLine.text.length
    const isLastChunkOfRawLine = v + 1 >= visualLines.length || visualLines[v + 1].rawLineIdx !== rawCursorLine
    if (
      cursorColInRaw >= visualLine.startCol &&
      (cursorColInRaw < endCol || (cursorColInRaw === endCol && isLastChunkOfRawLine))
    ) {
      return { line: v, col: cursorColInRaw - visualLine.startCol }
    }
  }
  // 兜底到最后一条视觉行的行尾，而不是开头：`line === 0` 会被 `moveCursorVisual`
  // 用来计算 `desiredWidth`，退回开头会连带丢掉「保持列位置」的语义。
  const last = visualLines[visualLines.length - 1]
  return last ? { line: visualLines.length - 1, col: last.text.length } : { line: 0, col: 0 }
}

/** 按视觉行移动光标，同时保持显示列不变。 */
export function moveCursorVisual(text: string, cursor: number, delta: number, vpWidth: number): number | null {
  const rawLines = text.length === 0 ? [''] : text.split('\n')
  const visualLines = buildVisualLines(rawLines, vpWidth)
  const { line, col } = locateVisualCursor(visualLines, rawLines, cursor)
  const targetLine = Math.max(0, Math.min(visualLines.length - 1, line + delta))
  if (targetLine === line) return null
  const target = visualLines[targetLine]
  const desiredWidth = visualWidth(visualLines[line].text.slice(0, col))
  const targetCol = sliceByWidth(target.text, desiredWidth).length
  let newPos = 0
  for (let i = 0; i < target.rawLineIdx; i++) newPos += rawLines[i].length + 1
  return newPos + target.startCol + targetCol
}
