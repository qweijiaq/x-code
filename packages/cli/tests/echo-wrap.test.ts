import { countContentRows } from '../src/ui/chat-input/text-helpers.js'
import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'
import { GLYPH_PROMPT_ARROW } from '../src/ui/render/terminal-glyphs.js'
import { visualWidth } from '../src/ui/render/text-width.js'

const { originalNoColor } = vi.hoisted(() => {
  const originalNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  return { originalNoColor }
})

// 回归修复：过宽的 echo 行过去交给终端自动换行 — 换行后的剩余行保留了文字
// 背后的背景色，却没有尾部填充，撕裂了卡片右边缘。现在 echo 在 cols-3 处
// 硬换行，并用 span 内的 `\x1b[K`（BCE 擦除）把背景色带到右边缘，而不是
// 全宽空格填充，这样终端变窄回流时就没有旧宽度的填充格可拆成幽灵空行。

const COLS = 80
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')

function echo(content: string): string {
  let out = ''
  writeMessageToStdout(
    (chunk) => {
      out += chunk
    },
    { id: 'u', role: 'user', content, timestamp: 0 },
  )
  return out
}

function physicalRows(out: string): string[] {
  const rows = stripAnsi(out).replace(/\r\n/g, '\n').split('\n')
  // 丢弃由末尾换行符产生的尾部空段。
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

describe('user echo card wrapping', () => {
  let originalColumns: number | undefined

  afterAll(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  })

  beforeEach(() => {
    resetScrollbackSpacing()
    originalColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  })

  it('hard-wraps a long CJK line and never pads rows to full width', () => {
    const out = echo(
      '我通过 /ps 命令来查看后台 shell 的时候，发现执行的时候只是打印了一下当前后台 shell 的执行情况，codex cli 也是这样的吗 还是说一直实时显示状态的 先确认我们产品和 codex cli 的实现是 /ps 只打印当前状态还是实时显示状态的  d:\\res\\codex',
    )
    const rows = physicalRows(out)
    // 填充行含一个可打印的锚定空格，所以非空白行正好就是长行换行后的文本块。
    expect(rows.filter((r) => r.trim().length > 0).length).toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      // 任何可打印格都不得落在最后一列（延迟换行防护）——
      // 行也不带全宽空格填充 —— span 内的 \x1b[K（此处已剥离）把背景色带到右边缘。
      expect(visualWidth(row)).toBeLessThanOrEqual(COLS - 1)
    }
    // 帧几何使用的行计数必须与实际相符。
    expect(countContentRows(out, COLS)).toBe(rows.length)
    // 背景色已应用（深色卡片 #3c3836 → 48;2;60;56;54），擦除到行尾的序列
    // 位于 bg span 内，使行尾拾取到卡片颜色。
    expect(out).toContain('\x1b[48;2;60;56;54m')
    expect(out).toContain('\x1b[K\x1b[49m')
  })

  it('does not pad continuation rows of an explicit multi-line message', () => {
    const out = echo('第一行文本\nsecond line with ascii')
    const rows = physicalRows(out)
    expect(rows.filter((r) => r.trim().length > 0).length).toBe(2)
    for (const row of rows) {
      expect(visualWidth(row)).toBeLessThanOrEqual(COLS - 1)
    }
    expect(countContentRows(out, COLS)).toBe(rows.length)
  })

  it('aligns wrapped continuation text under the first row text (3-cell prefix)', () => {
    const out = echo('x'.repeat(COLS)) // 80 个 ascii 字符 → 在预算 76 处换行一次
    const rows = physicalRows(out).filter((r) => r.trim().length > 0)
    expect(rows.length).toBe(2)
    expect(rows[0]!.startsWith(` ${GLYPH_PROMPT_ARROW} `)).toBe(true)
    expect(rows[1]!.startsWith('   x')).toBe(true)
  })

  it('anchors vertical padding rows without padding them to the old terminal width', () => {
    const out = echo('hello')
    const rawRows = out.replace(/\r\n/g, '\n').split('\n')
    const anchoredPadRow = '\x1b[48;2;60;56;54m \x1b[K\x1b[49m'
    expect(rawRows[1]).toBe(anchoredPadRow)
    expect(rawRows[3]).toBe(anchoredPadRow)

    const rows = physicalRows(out)
    expect(rows).toEqual(['', ' ', ` ${GLYPH_PROMPT_ARROW} hello`, ' ', ''])
    expect(visualWidth(rows[1]!)).toBe(1)
    expect(visualWidth(rows[3]!)).toBe(1)
  })
})
