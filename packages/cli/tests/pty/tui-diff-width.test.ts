import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { submitInput, withTui } from './test-context.js'

// 回归守卫：已提交的 diff 色带（增删行的背景色）必须在提交时延伸到终端右边缘。
// 它通过 span 内的 BCE 擦除（bg 复位前的 `\x1b[K`）而非空格填充实现 —
// 空格填充的行会在终端变窄时被 scrollback 回流拆成幽灵空行。色带的可打印
// 宽度仍须遵守预留的 1 格延迟换行边距。
describe('diff band width', () => {
  it('diff bg band extends to the terminal edge on a wide terminal', async () => {
    const COLS = 200
    await withTui(
      'diff-width',
      [
        {
          type: 'tool-call',
          name: 'edit',
          input: { filePath: 'a.ts', oldString: 'line2', newString: 'line2 modified' },
        },
        { type: 'completion', text: 'done-all' },
      ],
      async ({ harness }) => {
        await submitInput(harness, 'edit the file')
        await harness.waitForText('Would you like to edit the following file?', 30000)
        harness.write('y')
        await harness.waitForText('done-all', 30000)
        await harness.settle()

        const raw = harness.raw()
        // 删除行：`\x1b[48;2;<removed-bg>m` … `\x1b[49m`。实时帧可能在流中
        // 更早处绘制其它 bg span — 取最后一个，即已提交的 diff 行。
        const matches = [...raw.matchAll(/\x1b\[48;2;\d+;\d+;\d+m([\s\S]*?)\x1b\[49m/g)]
        expect(matches.length).toBeGreaterThan(0)
        const span = matches[matches.length - 1]![1]!
        // 色带通过 span 内擦除到达右边缘，该擦除必须是 bg span 内的最后一项。
        expect(span.endsWith('\x1b[K')).toBe(true)
        const bandWidth = span.replace(/\x1b\[[0-9;]*m/g, '').replace('\x1b[K', '').length
        // 无空格填充：可打印宽度是 gutter + code，上界为
        // COLS - 1（延迟换行边距）再减去 6 格的 RESULT_INDENT。
        expect(bandWidth).toBeLessThanOrEqual(COLS - 1 - 6)
        harness.key('ctrl-c')
      },
      {
        columns: COLS,
        rows: 30,
        beforeStart: async (ws) => {
          await fs.writeFile(path.join(ws.cwd, 'a.ts'), 'line1\nline2\nline3\n', 'utf-8')
        },
      },
    )
  }, 60000)
})
