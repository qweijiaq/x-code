import { ansiTextToCells, textToCells } from '../src/ui/chat-input/cells.js'
import { inputReducer } from '../src/ui/chat-input/reducer.js'
import { truncatePathFromStart } from '../src/ui/chat-input/text-helpers.js'
import { renderMarkdown } from '../src/ui/render/render-markdown.js'
import { detectFenceLanguage, detectLanguage } from '../src/ui/render/syntax-highlight.js'
import { visualWidth } from '../src/ui/render/text-width.js'

const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')

describe('ansiTextToCells grapheme granularity', () => {
  it('does not split supplementary-plane characters or ZWJ sequences into lone surrogates', () => {
    const cells = ansiTextToCells('\x1b[31mhi 😀 世界\x1b[0m 🇨🇳')
    expect(cells.filter((cell) => /^[\uD800-\uDFFF]$/.test(cell.char))).toHaveLength(0)
    // 同一个文本经两个构建器必须给出同样的单元格宽度——否则混排时列对齐漂移。
    expect(cells.reduce((total, cell) => total + cell.width, 0)).toBe(
      textToCells('hi 😀 世界 🇨🇳', 'x').reduce((total, cell) => total + cell.width, 0),
    )
  })

  it('keeps SGR styling per cell while collapsing clusters', () => {
    const cells = ansiTextToCells('\x1b[31m世\x1b[0m')
    expect(cells).toHaveLength(1)
    expect(cells[0]!.char).toBe('世')
    expect(cells[0]!.width).toBe(2)
    expect(cells[0]!.style).toContain('\x1b[31m')
  })
})

describe('truncatePathFromStart width budget', () => {
  it('never exceeds the column budget for wide (CJK / emoji) basenames', () => {
    const path = 'packages/core/src/非常长的中文文件名字非常长的中文文件名字.ts'
    for (const cols of [4, 10, 20, 30]) {
      expect(visualWidth(truncatePathFromStart(path, cols))).toBeLessThanOrEqual(cols)
    }
    expect(visualWidth(truncatePathFromStart('x😀😀😀😀😀😀😀😀.ts', 10))).toBeLessThanOrEqual(10)
  })
})

describe('inputReducer BACKSPACE_REF clamping', () => {
  it('ignores a delete range that starts at or before the buffer head', () => {
    const state = { text: 'hello', cursor: 5 }
    expect(inputReducer(state, { type: 'BACKSPACE_REF', pos: 0, deleteCount: 3 })).toBe(state)
    expect(inputReducer(state, { type: 'BACKSPACE_REF', pos: 1, deleteCount: 5 })).toEqual({
      text: 'ello',
      cursor: 0,
    })
  })

  it('never produces a negative cursor', () => {
    const next = inputReducer({ text: 'abc', cursor: 3 }, { type: 'BACKSPACE_REF', pos: 2, deleteCount: 9 })
    expect(next.cursor).toBe(0)
    expect(next.text).toBe('c')
  })
})

describe('renderMarkdown list markers', () => {
  it('keeps the bullet for loose lists (list_item → paragraph → inline tokens)', () => {
    const loose = stripAnsi(renderMarkdown('- item one\n\n- **bold** item two'))
    expect(loose).toContain('• item one')
    // 标记只应出现一次：paragraph 发标记，子 token 不再重复发。
    expect(loose.match(/•/g)).toHaveLength(2)
  })

  it('keeps ordered numbers for loose lists', () => {
    expect(stripAnsi(renderMarkdown('1. one\n\n2. two'))).toBe('1. one\n2. two\n')
  })

  it('still renders tight lists unchanged', () => {
    expect(stripAnsi(renderMarkdown('- alpha\n- beta'))).toBe('• alpha\n• beta\n')
  })
})

describe('language lookup prototype safety', () => {
  it('ignores Object.prototype keys when mapping extensions', () => {
    expect(detectLanguage('x.constructor')).toBeNull()
    expect(detectLanguage('x.toString')).toBeNull()
    expect(detectLanguage('x.py')).toBe('python')
  })

  it('ignores Object.prototype keys when mapping fence languages', () => {
    expect(detectFenceLanguage('constructor')).toBeNull()
    expect(detectFenceLanguage('valueOf')).toBeNull()
    expect(detectFenceLanguage(' rust ')).toBe('rust')
  })
})
