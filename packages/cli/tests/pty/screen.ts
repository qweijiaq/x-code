import type { Terminal } from '@xterm/headless'

export function terminalScreen(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(
      buffer
        .getLine(buffer.viewportY + row)
        ?.translateToString(true)
        .trimEnd() ?? '',
    )
  }
  return lines
}

/** 实时提示行精简到只剩可编辑内容：剥离输入框边框（`│ …… │`）与
 *  `› ` 提示字形，并移除尾部填充。测试断言针对用户“输入”的内容，
 *  而不是它周围的边框。 */
export function promptContent(line: string): string {
  return line.replace(/^│ /, '').replace(/^\| /, '').replace(/ │$/, '').replace(/ \|$/, '').trimEnd()
}

export function screenText(terminal: Terminal): string {
  return terminalScreen(terminal).join('\n')
}

export function lastPromptLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (line === '>' || line.startsWith('> ') || line === '›' || line.startsWith('› ')) return line
    // 带框提示：`│ › …… │` — 边框属于实时输入框。
    // 权限对话框的选项行也以 `│ ` 开头，但它们的指针缩进 4 个空格，
    // 所以不会误匹配 `│ ›`。
    if (line.startsWith('│ ›') || line.startsWith('│ >') || line.startsWith('| >')) return line
  }
  return ''
}

export function occurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count++
    offset += needle.length
  }
  return count
}
