import { describe, expect, it } from 'vitest'

import { findSafeBoundary, hasOpenCodeFence, hasOpenMarkdownBlock } from '../src/ui/agent/use-stream-buffer.js'

describe('stream buffer markdown boundaries', () => {
  it('holds a long markdown table instead of treating it as a splittable code fence', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| ${index + 1} | row ${index + 1} | value |`).join('\n')
    const table = `| id | name | value |\n| --- | --- | --- |\n${rows}\n`

    expect(hasOpenMarkdownBlock(table)).toBe(true)
    expect(hasOpenCodeFence(table)).toBe(false)
    expect(findSafeBoundary(table)).toBe(-1)
  })

  it('still identifies a long open code fence for incremental commits', () => {
    const code = `\`\`\`text\n${'line of code\n'.repeat(100)}`

    expect(hasOpenCodeFence(code)).toBe(true)
  })

  it('treats the buffer as fence-internal when the opening fence was already committed', () => {
    // 强制中间提交把开栏行随代码一起送走后，缓冲里只剩围栏内部的行。计入 carry
    // 奇偶性后它们仍被判定为「在围栏内」，闭栏到达时则正确识别为已关闭。
    const interior = 'const a = 1\nconst b = 2\n'
    expect(hasOpenCodeFence(interior, 0)).toBe(false)
    expect(hasOpenCodeFence(interior, 1)).toBe(true)
    expect(hasOpenMarkdownBlock(interior, 1)).toBe(true)
    expect(findSafeBoundary(interior, 1)).toBe(-1)

    const closed = `const a = 1\n\`\`\`\n`
    expect(hasOpenCodeFence(closed, 1)).toBe(false)
    expect(findSafeBoundary(closed, 1)).toBe(closed.length)
  })

  it('lets prose after a committed fence through instead of holding it to the turn end', () => {
    const afterClose = `\`\`\`\nPlain prose after the block.\n`
    // 旧行为：把闭栏误判成开栏，于是闭栏之后的正文滞留在缓冲里直到回合结束。
    expect(hasOpenCodeFence(afterClose, 0)).toBe(true)
    expect(findSafeBoundary(afterClose, 0)).toBe(-1)
    expect(findSafeBoundary(afterClose, 1)).toBe(afterClose.length)
  })
})
