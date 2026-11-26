// ─── 语义颜色 token——UI 镶边的唯一事实来源 ──────
//
// 取代了旧的「两个脑袋」设置：`theme.ts` 存 hex 常量，而
// `chat-input/palette.ts` 存手工同步的原始 ANSI 转义。现在一张表驱动
// 两条渲染路径：
//
//   - `paint(token)`      → 滚动区/提交路径的 chalk 样式器
//                           （stdout-writer、render-markdown、AppHeader）
//   - `cellFg()`           → ChatInput 单元格 diff 渲染器用的原始 SGR 转义
//                           （它跑不了 chalk）
//
// 每个 token 有两个值：深色 hex 和浅色 hex。`/theme` 在运行时切换；
// palette.ts 在每次切换时都从这里重建它派生的转义。
//
// 设计规则（借鉴自 Kimi Code 的 DESIGN.md / Codex / CC）：
//   - 层级来自 dim/bold/italic 修饰符，而不是更多色相。
//   - `primary` 是屏幕上同一时刻唯一的品牌强调色；语义色
//     （success/warning/error）只在真正的状态出现。
//   - 次要文本使用灰色阶梯 textDim → textMuted → border。
import { Chalk } from 'chalk'

import { getTheme } from './theme.js'

// chalk 按终端能力自动选择 0/1/2/3 级。不要强制 level 3：macOS Terminal
// 只支持 256 色，会把 `38;2;r;g;b` 的 RGB 分量当成独立 SGR 码——其中
// 40 会变成黑色背景、106 会变成亮青色背景，整屏就会出现莫名其妙的色块。
// NO_COLOR (https://no-color.org) 和 FORCE_COLOR 都由 chalk 自己处理。
/** 解析显式 FORCE_COLOR。chalk 在 TERM_PROGRAM=Apple_Terminal 时会先返回 2，
 *  连 FORCE_COLOR=3 都压不过去，所以测试 / CI 需要自己解析。 */
function forcedColorLevel(): number | undefined {
  const value = process.env.FORCE_COLOR
  if (value === undefined) return undefined
  if (value === 'true') return 1
  if (value === 'false') return 0
  if (value === '') return 1
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : Math.min(parsed, 3)
}

const forcedLevel = forcedColorLevel()
const detectedLevel = new Chalk().level
// 即使全局设置了 COLORTERM=truecolor，Terminal.app 也不支持 24 位色，
// 必须封顶到 256 色，否则上面的 RGB 误解析会再次出现。
const level = (forcedLevel ??
  (process.env.TERM_PROGRAM === 'Apple_Terminal' ? Math.min(detectedLevel, 2) : detectedLevel)) as 0 | 1 | 2 | 3
export const chalk = new Chalk({ level })
const COLORS_ENABLED = level > 0
const c = chalk

export type ChromeToken =
  | 'primary'
  | 'primaryDim'
  | 'model'
  | 'usage'
  | 'textStrong'
  | 'textDim'
  | 'textMuted'
  | 'border'
  | 'success'
  | 'warning'
  | 'error'

interface TokenDef {
  dark: string
  light: string
}

const TOKENS: Record<ChromeToken, TokenDef> = {
  // 品牌蓝：只用于焦点、链接和运行中状态，屏幕上同时只出现一种强调色。
  primary: { dark: '#7aa2f7', light: '#2563eb' },
  primaryDim: { dark: '#5b6b8c', light: '#93b4f5' },
  // 页脚模型名和上下文用量都用中性灰，避免黄/绿两色把状态栏弄花。
  model: { dark: '#a9b1d6', light: '#4c566a' },
  usage: { dark: '#8b949e', light: '#6a737d' },
  textStrong: { dark: '#e6edf3', light: '#1f2328' },
  // 灰色阶梯：textDim 用于元信息，textMuted 用于占位符/分隔线，
  // border 用于输入框边线。层级靠亮度而不是更多色相。
  textDim: { dark: '#9aa5b1', light: '#57606a' },
  textMuted: { dark: '#6e7681', light: '#8c959f' },
  border: { dark: '#3b4048', light: '#d0d7de' },
  success: { dark: '#7ec699', light: '#1a7f37' },
  warning: { dark: '#e0af68', light: '#9a6700' },
  error: { dark: '#f7768e', light: '#cf222e' },
}

type ThemeKind = 'dark' | 'light'

function themeKind(): ThemeKind {
  return getTheme() === 'light' ? 'light' : 'dark'
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** 提交/滚动区路径的 chalk 样式器。在调用时解析当前主题，这样 `/theme`
 *  切换会应用到之后提交的所有内容。 */
export function paint(token: ChromeToken): (s: string) => string {
  const def = TOKENS[token]
  // 主题必须在返回的闭包里解析，而不是在 `paint()` 被调用时：调用方一旦把
  // 样式器缓存/提升（模块常量、useMemo），早解析就会把主题固化，`/theme` 之后
  // 提交的内容仍是旧配色。
  // 先重置背景再上色：header 在 TUI 之前写入，可能继承 shell 提示符留下的
  // 背景色；显式发 49（默认背景）可以避免整段文字带上意外的色块。
  return (s) => `\x1b[49m${c.hex(def[themeKind()])(s)}`
}

export interface CellMods {
  bold?: boolean
  dim?: boolean
  italic?: boolean
}

/** ChatInput 单元格 diff 渲染器的原始 SGR 转义。始终以 `\x1b[0m` 开头：
 *  palette.ts 的长注释说明了原因——裸颜色序列会继承上一个单元格遗留的
 *  属性（bold 渗入下一行、dim 元信息在 spinner 单元格后闪蓝）。先重置才能
 *  让每个单元格处于已知状态。 */
/** RGB → xterm 256 色索引（6×6×6 色立方 + 灰阶）。 */
function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
}

const ANSI16_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

/** RGB → 16 色 SGR 前景码（30-37 / 90-97）。 */
function rgbToAnsi16(r: number, g: number, b: number): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ANSI16_RGB.length; i++) {
    const [cr, cg, cb] = ANSI16_RGB[i]!
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best < 8 ? 30 + best : 90 + (best - 8)
}

export function cellFg(token: ChromeToken, mods: CellMods = {}): string {
  const def = TOKENS[token]
  const kind = themeKind()
  const attrs = `${mods.bold ? ';1' : ''}${mods.dim ? ';2' : ''}${mods.italic ? ';3' : ''}`
  // NO_COLOR 会去掉颜色序列但保留属性修饰——该约定管的是颜色，不是强调。
  if (!COLORS_ENABLED) return `\x1b[0m${attrs ? `\x1b[${attrs.slice(1)}m` : ''}`
  const [r, g, b] = hexToRgb(def[kind])
  // 按 chalk 检测到的能力降级：macOS Terminal 只到 256 色，绝不能发 38;2。
  if (chalk.level === 1) return `\x1b[0m\x1b[${rgbToAnsi16(r, g, b)}${attrs}m`
  if (chalk.level === 2) return `\x1b[0m\x1b[38;5;${rgbToAnsi256(r, g, b)}${attrs}m`
  return `\x1b[0m\x1b[38;2;${r};${g};${b}${attrs}m`
}
