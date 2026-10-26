// 权限对话框的单元格构建器 + `formatElapsed`。
//
// 放在 ChatInput.tsx 之外，因为权限渲染是一块自包含的 data → Cell[] 映射，没有任何
// React 状态。
import { getPermissionLevel } from '@x-code-cli/core'

import { highlightShellCommand } from '../render/shiki-highlight.js'
import { GLYPH_ELLIPSIS } from '../render/terminal-glyphs.js'
import { type Cell, ansiTextToCells, textToCells } from './cells.js'
import { S_DIM, S_ERROR_BOLD, S_NONE, S_PRIMARY, S_SUCCESS } from './palette.js'
import { truncatePathFromStart } from './text-helpers.js'

// Codex 风格的问句标题（「Would you like to run the following command?」）——
// 对话框读起来像用户要回答的请求，而不是一条状态行。
export function permissionTitle(toolName: string, mcp?: { serverName: string; rawName: string }): string {
  if (mcp) return `Would you like to use MCP tool ${mcp.serverName}/${mcp.rawName}?`
  switch (toolName) {
    case 'shell':
      return 'Would you like to run the following command?'
    case 'writeFile':
      return 'Would you like to write the following file?'
    case 'edit':
      return 'Would you like to edit the following file?'
    case 'enterPlanMode':
      return 'Would you like to enter plan mode?'
    default:
      return `Would you like to use ${toolName}?`
  }
}

// 每次调用都重新解析（而不是模块级表），因为调色板风格是 `let` 绑定，会在
// `/theme` 切换时重新派生——捕获的表会把模块加载时的字符串冻结下来。
function permissionLevelStyle(level: string): { label: string; style: string } {
  switch (level) {
    case 'always-allow':
      return { label: 'read-only', style: S_SUCCESS }
    case 'deny':
      return { label: 'dangerous', style: S_ERROR_BOLD }
    default:
      return { label: 'write', style: S_PRIMARY }
  }
}

/** MCP 工具输入的单行 `key: value, key: value` 摘要。值经 JSON 编码，这样字符串
 *  会连同引号一起渲染，嵌套对象也保持可读；长值在拼接前先裁剪，以免单个超大字段
 *  吞掉所有其他键。`permissionContentCells` 里外层「截到终端宽度」随后封顶整行。 */
function mcpInputPreview(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return '(no args)'
  const PER_VALUE_MAX = 60
  const parts = keys.map((k) => {
    let v: string
    try {
      v = JSON.stringify(input[k])
    } catch {
      v = String(input[k])
    }
    if (v === undefined) v = 'undefined'
    if (v.length > PER_VALUE_MAX) v = v.slice(0, PER_VALUE_MAX - 1) + '…'
    return `${k}: ${v}`
  })
  return parts.join(', ')
}

export function permissionContentCells(
  toolName: string,
  input: Record<string, unknown>,
  termWidth: number,
  mcp?: { serverName: string; rawName: string },
): Cell[] | null {
  // 帧几何假设每条权限内容行恰好占一行。当字符串长于 termWidth 时，终端会自动把
  // 它折到下一物理行，这会破坏所有下游的绝对光标位置（Yes/No 行、输入分隔线、提示
  // 框本身）——对话框显得「缺了一半」，只看得见标题。在这里截断，让单元格矩阵与屏
  // 幕行保持 1:1。与下方实时工具列表渲染里的工具气泡预览截断一致。
  const truncateToWidth = (text: string, reservedCols: number): string => {
    const maxLen = Math.max(10, termWidth - reservedCols)
    return text.length > maxLen ? text.slice(0, maxLen - 1) + GLYPH_ELLIPSIS : text
  }
  if (mcp) {
    // 输入的单行 `key: value, key: value` 预览。MCP 工具可以有任意 schema，所以我
    // 们回退到通用序列化器，而不是试图猜「哪个字段重要」。空输入仍渲染该行（带
    // `(no args)`），这样对话框高度与 shell/edit 一致，always-allow 行也停在用户预
    // 期的位置。
    const preview = mcpInputPreview(input)
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncateToWidth(preview, 2 + 2), S_PRIMARY))
    return cells
  }
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = permissionLevelStyle(level)
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const rawCommand = String(input.command ?? '')
    // 前导 2 空格 + `$ ` + 尾随空格 + `[label]` + 2 列安全余量。`$ ` 是在截断之后
    // 才前置的，所以必须算进预算——否则最大长度的命令会溢出 boxedRow 的内容宽度，
    // truncateCellRow 会裁掉 `[label]` 标签的尾部。
    const decoration = 2 + 2 + 1 + (info.label.length + 2) + 2 + 2
    const command = truncateToWidth(rawCommand, decoration)
    // 与实时/已提交工具行相同的 codex 风格 shell 高亮。
    cells.push(...textToCells('$ ', S_PRIMARY))
    cells.push(...ansiTextToCells(highlightShellCommand(command)))
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(`[${info.label}]`, info.style))
    return cells
  }
  if (toolName === 'writeFile') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    const suffix = ' (new file)'
    const truncated = truncatePathFromStart(fp, Math.max(10, termWidth - (2 + suffix.length + 2)))
    cells.push(...textToCells(truncated, S_PRIMARY))
    cells.push(...textToCells(suffix, S_DIM))
    return cells
  }
  if (toolName === 'edit') {
    const fp = String(input.filePath ?? '')
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells(truncatePathFromStart(fp, Math.max(10, termWidth - 4)), S_PRIMARY))
    return cells
  }
  if (toolName === 'enterPlanMode') {
    // 进入 plan 模式没有每次调用的输入——描述后果，让用户知道 Yes/No 实际意味着
    // 什么。
    const cells: Cell[] = []
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push({ char: ' ', style: S_NONE, width: 1 })
    cells.push(...textToCells('Read-only exploration; no edits until you approve a plan.', S_DIM))
    return cells
  }
  return null
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}
