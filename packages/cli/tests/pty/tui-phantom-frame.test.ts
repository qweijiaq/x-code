import { describe, expect, it } from 'vitest'

import type { TuiHarness } from './harness.js'
import { occurrences } from './screen.js'
import { submitInput, typeInput, withTui } from './test-context.js'

// submitInput 会等待单行提示回显完整文本，但对软换行的长输入永远不会发生 —
// 所以这里直接写入并等待尾部。
async function submitLong(harness: TuiHarness, text: string): Promise<void> {
  harness.write(text)
  await harness.waitForScreen((screen) => screen.includes('d:\\res\\codex'), 'long input tail')
  harness.key('enter')
}

// 复现用户报告：提交一条长消息（终端换行）后，普通打字 / 方向键历史导航
// 有时会在 scrollback 区域残留一个多余的输入框。
const LONG_CJK =
  '我通过 /ps 命令来查看后台 shell 的时候，发现执行的时候只是打印了一下当前后台 shell 的执行情况，codex cli 也是这样的吗 还是说一直实时显示状态的 先确认我们产品和 codex cli 的实现是 /ps 只打印当前状态还是实时显示状态的  d:\\res\\codex'

function countSeparatorRows(screen: string[]): number {
  // 输入框的上下边框：`╭───…╮` / `╰───…╯`。
  return screen.filter((line) => /^[╭╰]─{18,}[╮╯]$/.test(line)).length
}

describe('TUI phantom input frame', () => {
  it('keeps exactly one input box after long-echo commit + typing + history arrows', async () => {
    await withTui(
      'input-phantom-frame',
      [
        { type: 'completion', text: 'answer-1' },
        { type: 'completion', text: 'answer-2' },
      ],
      async ({ harness }) => {
        await submitLong(harness, LONG_CJK)
        await harness.waitForText('answer-1')
        await submitInput(harness, 'second question')
        await harness.waitForText('answer-2')

        await typeInput(harness, 'DRAFT')
        // 调出长输入（帧因软换行而变高），再向下返回。
        harness.key('up')
        await harness.settle()
        harness.key('up')
        await harness.settle()
        harness.key('down')
        await harness.settle()
        harness.key('down')
        await harness.settle()

        expect(countSeparatorRows(harness.screen())).toBe(2)
      },
      { columns: 100, rows: 32 },
    )
  })

  it('keeps exactly one input box when typing while the answer streams', async () => {
    const streamedLines = Array.from({ length: 40 }, (_, i) => `streamed line ${i} 内容`).join('\n')
    await withTui(
      'input-phantom-frame-stream',
      [{ type: 'completion', text: streamedLines, chunks: streamedLines.split('\n'), chunkDelayMs: 40 }],
      async ({ harness }) => {
        await submitLong(harness, LONG_CJK)
        // 在流式提交落地时打字并导航。
        harness.write('DRAFT')
        await harness.waitForScreen((screen) => screen.includes('DRAFT'), 'draft echo during stream')
        harness.key('up')
        harness.key('down')
        await harness.settle()
        harness.write('-TAIL')
        await harness.waitForText('streamed line 39 内容', 15000)
        await harness.settle()

        expect(occurrences(harness.text(), 'DRAFT-TAIL')).toBe(1)
        expect(countSeparatorRows(harness.screen())).toBe(2)
      },
      { columns: 100, rows: 32 },
    )
  })
})
