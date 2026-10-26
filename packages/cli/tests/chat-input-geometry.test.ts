import { describe, expect, it } from 'vitest'

import { computePostContentScrollRows, moveCursorVisual } from '../src/ui/chat-input/geometry.js'

describe('ChatInput large commit geometry', () => {
  it('reserves the frame rows after content taller than the viewport', () => {
    expect(computePostContentScrollRows(1, 40, 35, 38)).toBe(4)
  })

  it('scrolls only rows overlapping the frame for a long tool summary', () => {
    expect(computePostContentScrollRows(1, 36, 34, 38)).toBe(3)
  })

  it('does not scroll when committed content ends above the frame', () => {
    expect(computePostContentScrollRows(12, 9, 21, 38)).toBe(0)
  })
})

describe('moveCursorVisual (soft-wrap aware up/down)', () => {
  // 'abcdefghij|klmno' — 一条逻辑行软换行成两行视觉行。
  const wrapped = 'abcdefghijklmno'

  it('moves up one visual line within a soft-wrapped single line', () => {
    expect(moveCursorVisual(wrapped, 12, -1, 10)).toBe(2)
  })

  it('round-trips down to the same column', () => {
    expect(moveCursorVisual(wrapped, 2, 1, 10)).toBe(12)
  })

  it('returns null on the first visual line so Up falls through to history', () => {
    expect(moveCursorVisual(wrapped, 4, -1, 10)).toBeNull()
  })

  it('returns null on the last visual line so Down falls through to history', () => {
    expect(moveCursorVisual(wrapped, 12, 1, 10)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(moveCursorVisual('', 0, -1, 10)).toBeNull()
    expect(moveCursorVisual('', 0, 1, 10)).toBeNull()
  })

  it('treats the wrap boundary as the next visual line leading position', () => {
    // 光标在 offset 10 = 'abcdefghij' 末尾 = 'klmno' 开头。
    // 归属给续行，所以 Up 落到第 0 列。
    expect(moveCursorVisual(wrapped, 10, -1, 10)).toBe(0)
  })

  it('moves across hard newlines and wrapped lines alike', () => {
    // raw：'abc' + '\n' + 'defghijklm|no'（第二个 raw 行在第 10 列换行）
    const text = 'abc\ndefghijklmno'
    // v2 'no' 第 2 列（raw offset 4+10+2=16，文本末尾）→ v1 'defghijklm' 第 2 列 → 4+2=6
    expect(moveCursorVisual(text, 16, -1, 10)).toBe(6)
    // v1 第 2 列 → v0 'abc' 第 2 列
    expect(moveCursorVisual(text, 6, -1, 10)).toBe(2)
    // v0 → null（顶边）
    expect(moveCursorVisual(text, 2, -1, 10)).toBeNull()
    // v0 第 2 列 → v1 第 2 列
    expect(moveCursorVisual(text, 2, 1, 10)).toBe(6)
  })

  it('clamps the column when the target visual line is shorter', () => {
    // 'abcd' + '\n' + 'xy'：从第 3 列向下落到 'xy' 末尾（offset 5+2=7）。
    expect(moveCursorVisual('abcd\nxy', 3, 1, 10)).toBe(7)
  })

  it('handles CJK wide chars (two terminal cells each)', () => {
    // 8 个宽字符，宽度 16；vpWidth 10 → v0 = 5 字符，v1 = 3 字符。
    const cjk = '你好世界你好世界'
    // 输入末尾（v1 第 3 列，显示列 6）→ v0 显示列 6 = 第 3 字符。
    expect(moveCursorVisual(cjk, 8, -1, 10)).toBe(3)
    // 往返：v0 第 3 字符（显示列 6）→ v1 末尾。
    expect(moveCursorVisual(cjk, 3, 1, 10)).toBe(8)
    // 顶边仍穿透。
    expect(moveCursorVisual(cjk, 2, -1, 10)).toBeNull()
  })
})
