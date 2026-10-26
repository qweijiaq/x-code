import { countSpillRiskRows } from '../src/ui/chat-input/text-helpers.js'

// Spill-heal 修正：渲染尾部落在右边缘附近的行，在某些终端上可能比
// countContentRows 预测的晚一行换行（延迟换行的幽灵行、宽/模糊宽度不一致）。
// MINIMAL-WRITE 提交路径会强制重绘等量的顶部帧行，避免溢出的字符残留在帧内。

const COLS = 80

describe('countSpillRiskRows', () => {
  it('returns 0 for short lines well clear of the right edge', () => {
    expect(countSpillRiskRows('short line\nanother one\n', COLS)).toBe(0)
  })

  it('flags a line whose width is an exact multiple of the terminal width', () => {
    expect(countSpillRiskRows('x'.repeat(COLS), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS * 2), COLS)).toBe(1)
  })

  it('flags a line ending within the safety margin of the edge', () => {
    expect(countSpillRiskRows('x'.repeat(COLS - 1), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS - 4), COLS)).toBe(1)
    expect(countSpillRiskRows('x'.repeat(COLS - 5), COLS)).toBe(0)
  })

  it('measures CJK lines by visual width, not code-unit length', () => {
    // 37 个宽字符 = 74 格 → 远离边缘；40 字符 = 80 → 恰好贴合。
    expect(countSpillRiskRows('冒'.repeat(37), COLS)).toBe(0)
    expect(countSpillRiskRows('冒'.repeat(40), COLS)).toBe(1)
  })

  it('accumulates risk across lines', () => {
    const content = ['x'.repeat(COLS), 'safe', 'y'.repeat(COLS - 2)].join('\n')
    expect(countSpillRiskRows(content, COLS)).toBe(2)
  })

  it('always flags tab-containing lines (tab stops defeat width math)', () => {
    expect(countSpillRiskRows('a\tb', COLS)).toBe(1)
  })

  it('ignores ANSI styling when measuring width', () => {
    expect(countSpillRiskRows(`\x1b[1m${'x'.repeat(COLS)}\x1b[0m`, COLS)).toBe(1)
    expect(countSpillRiskRows('\x1b[1mshort\x1b[0m', COLS)).toBe(0)
  })

  it('does not count the empty segment after a trailing newline', () => {
    expect(countSpillRiskRows('safe\n', COLS)).toBe(0)
  })
})
