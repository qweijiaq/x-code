import { describe, expect, it } from 'vitest'

import { submitInput, typeInput, withTui } from './test-context.js'

// 回归修复：TUI 全局隐藏硬件光标，但 macOS 终端仍会在硬件光标位置渲染
// IME 组词预览（标记文本）。因此每次 flush 结束时都必须把光标停放在可见
// 插入符格上 — 否则 diff 循环会让它停在 Working 行中间（spinner tick）
// 或输入框右轨外一格（按键），拼音预览就会画在那里。

function lastCursorPosition(raw: string): { row: number; col: number } {
  const matches = [...raw.matchAll(/\x1b\[(\d+);(\d+)H/g)]
  const last = matches[matches.length - 1]
  if (!last) throw new Error('no cursor-position escape in output')
  return { row: Number(last[1]), col: Number(last[2]) }
}

describe('IME cursor park', () => {
  it('parks the hidden hardware cursor on the caret cell after typing', async () => {
    await withTui('ime-park', [], async ({ harness }) => {
      await typeInput(harness, 'ab中文')
      await harness.settle()

      const { row, col } = lastCursorPosition(harness.raw())
      // 插入符视觉列：1 基的 col 5 是第一个文本格
      //（│ 空格 › 空格），随后 a(1) b(1) 中(2) 文(2) → 插入符在 col 11。
      expect(col).toBe(11)

      // 停放的行必须是包含所输入文本的屏幕行。
      const inputRowIdx = harness.screen().findIndex((line) => line.includes('ab中文'))
      expect(inputRowIdx).toBeGreaterThanOrEqual(0)
      expect(row).toBe(inputRowIdx + 1) // screen[] 是 0 基，CSI 是 1 基
    })
  })

  it('keeps the cursor parked on the caret while the spinner ticks mid-stream', async () => {
    const streamed = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    await withTui(
      'ime-park-stream',
      [{ type: 'completion', text: streamed, chunks: streamed.split('\n'), chunkDelayMs: 120 }],
      async ({ harness }) => {
        await submitInput(harness, 'go')
        await harness.waitForText('Working')
        await typeInput(harness, 'xy')
        // 让 spinner tick + 流式提交落在我们最后一次按键之后 —
        // 最终 flush 就是 spinner/commit flush，正是过去把光标留在 Working
        // 行中间的那个场景。
        await harness.settle()
        await harness.settle()

        const { row, col } = lastCursorPosition(harness.raw())
        // "xy" 之后的插入符：第一个文本格是 col 5，+2 字符 → col 7。
        expect(col).toBe(7)
        const inputRowIdx = harness.screen().findIndex((line) => line.includes('xy'))
        expect(inputRowIdx).toBeGreaterThanOrEqual(0)
        expect(row).toBe(inputRowIdx + 1)
      },
    )
  })
})
