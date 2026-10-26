import { describe, expect, it } from 'vitest'

import { submitInput, typeInput, withTui } from './test-context.js'

const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `LINE-${String(i + 1).padStart(2, '0')}`).join('\n')

describe('TUI /clear behavior', () => {
  // 回归修复：/clear 的渲染携带一次性的擦除+滚动字节，过去挂在可取消的
  // 延迟 flush 路径上。附近的一次重渲染（输入重置、回合收尾状态）会覆盖它，
  // clear 字节就永久丢失，而刚消费的 justCleared 种子仍把新帧锚定在第 1 行 —
  // 旧对话依旧可见地留在下面。下面的第二个回合就是用来制造这些竞争渲染的。
  it('clears the visible viewport even with racing renders around the clear', async () => {
    await withTui(
      'clear-viewport',
      [
        { type: 'completion', text: LONG_TEXT },
        {
          type: 'tool-call',
          name: 'PowerShell',
          input: { command: 'git tag -d v0.5.0' },
          finalText: 'done',
        },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'hi')
        await harness.waitForText('LINE-60')

        await submitInput(harness, 'delete the tag')
        await harness.waitForText('done')
        await harness.settle()

        // 在补全菜单打开时提交 /clear，模拟真实使用。
        await typeInput(harness, '/clear')
        await harness.waitForScreen((screen) => screen.includes('Clear conversation history'), 'slash menu open')
        harness.key('enter')

        await harness.waitForScreen(
          (screen) => !screen.includes('LINE-01') && !screen.includes('PowerShell(') && screen.includes('test-model'),
          'viewport cleared after /clear',
        )

        const lines = harness.screen()
        expect(harness.text()).not.toContain('LINE-01')
        expect(harness.text()).not.toContain('done')
        // 保留的 /clear 回声作为新视口的第一个内容渲染 — 与其它命令回声
        // 相同的填充卡片：空行、全宽 bg 填充行、文本行、bg 填充行 —
        // 其下方紧挨着新的输入框。
        const echoRow = lines.findIndex((line) => /[›>] \/clear/.test(line))
        expect(echoRow).toBeGreaterThanOrEqual(2)
        expect((lines[echoRow - 1] ?? 'x').trim()).toBe('')
        expect((lines[echoRow + 1] ?? 'x').trim()).toBe('')
        expect(lines[echoRow + 2] ?? '').toMatch(/^╭/)
        // 卡片的 bg 行必须真的在 clear 的 home 光标跳转之后发出
        //（过去它们被推入 scrollback，而有些终端会从历史中丢弃仅 bg 的行）。
        const postClear = harness.raw().slice(harness.raw().lastIndexOf('\x1b[H'))
        expect(postClear.split('\x1b[48;2;60;56;54m').length - 1).toBeGreaterThanOrEqual(3)
      },
      { columns: 80, rows: 40 },
    )
  })
})
