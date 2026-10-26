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
// 每个 token 有三个值：深色 hex、浅色 hex，以及给 *-ansi 主题用的 16 色
// ANSI 关键字（后者遵循用户终端调色板而非强行 hex——对标 Claude Code 的
// ansi 主题理由）。`/theme` 在运行时切换；palette.ts 在每次切换时都从这里
// 重建它派生的转义。
//
// 设计规则（借鉴自 Kimi Code 的 DESIGN.md / Codex / CC）：
//   - 层级来自 dim/bold/italic 修饰符，而不是更多色相。
//   - `primary` 是屏幕上同一时刻唯一的品牌强调色；语义色
//     （success/warning/error）只在真正的状态出现。
//   - 次要文本使用灰色阶梯 textDim → textMuted → border。
import { Chalk } from 'chalk'

import { getTheme } from './theme.js'

// NO_COLOR (https://no-color.org) 禁用所有颜色输出；FORCE_COLOR 优先于它
// （CI 日志查看器会同时设置两者）。强制 level 3 会绕过 chalk 自己的环境
// 检测，所以我们必须自己遵循该约定。只读一次——环境变量不会在进程中途改变。
const COLORS_ENABLED = !process.env.NO_COLOR || !!process.env.FORCE_COLOR

/** 所有 UI 表面共享的 chalk 实例。集中一处，让 NO_COLOR / FORCE_COLOR
 *  处理只在一个地方——此前每个渲染器都创建自己的 `new Chalk({ level: 3 })`
 *  并同时忽略两者。 */
export const chalk = new Chalk({ level: COLORS_ENABLED ? 3 : 0 })
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

/** chalk 和 `cellFg` 代码表都认识的 16 色 ANSI 关键字。仅 *-ansi 主题使用。 */
type AnsiKeyword = 'blue' | 'blueBright' | 'green' | 'yellow' | 'red' | 'white' | 'gray'

interface TokenDef {
  dark: string
  light: string
  ansi: AnsiKeyword | null
}

const TOKENS: Record<ChromeToken, TokenDef> = {
  // 品牌天蓝色（取自 logo）——spinner、链接、行内代码、工具预览、
  // 选择指针、聚焦边框、权限预览。
  primary: { dark: '#89b4fa', light: '#2f6fdd', ansi: 'blueBright' },
  primaryDim: { dark: '#5c7cb8', light: '#7a9cd8', ansi: 'blue' },
  // 页脚状态行色调，对标 Codex CLI 默认的 catppuccin-mocha 状态行
  // （带推理的模型名 + 当前目录）：模型标签用柔黄（entity.name.type scope），
  // 相邻信息用柔绿（string scope）。全亮度柔色——不做压暗。
  model: { dark: '#f9e2af', light: '#df8e1d', ansi: 'yellow' },
  usage: { dark: '#a6e3a1', light: '#40a02b', ansi: 'green' },
  // 显式「比终端默认更亮」，用于罕见的强调；普通正文文本保持终端
  // 自己的默认前景色。
  textStrong: { dark: '#f8f8f2', light: '#1f2328', ansi: 'white' },
  // 灰色阶梯：textDim 用于元信息/提示，textMuted 用于占位符/侧槽/分隔线，
  // border 用于输入框边线和 › 回显箭头。深色值比 CC 原版提亮了一档
  // （border #888 → #a0a0，textDim #999 → #b3b3，textMuted #5c5c → #8f8f）：
  // 在 CC 的深度下这条阶梯在许多深色终端上显得发闷，而 dim 属性
  // （此前用于实时 UI 元信息）会更暗。
  textDim: { dark: '#b3b3b3', light: '#6a737d', ansi: 'white' },
  textMuted: { dark: '#8f8f8f', light: '#959da5', ansi: 'gray' },
  border: { dark: '#a0a0a0', light: '#c8cdd3', ansi: 'gray' },
  success: { dark: '#4eba65', light: '#248a3d', ansi: 'green' },
  warning: { dark: '#ffc107', light: '#9a6700', ansi: 'yellow' },
  error: { dark: '#ff6b80', light: '#cf222e', ansi: 'red' },
}

type ThemeKind = 'dark' | 'light' | 'ansi'

function themeKind(): ThemeKind {
  const name = getTheme()
  if (name.endsWith('-ansi')) return 'ansi'
  return name.startsWith('light') ? 'light' : 'dark'
}

// ANSI 关键字 → SGR 前景色代码（亮色变体在 90 段）。
const ANSI_FG: Record<AnsiKeyword, number> = {
  blue: 34,
  blueBright: 94,
  green: 32,
  yellow: 33,
  red: 31,
  white: 37,
  gray: 90,
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** 提交/滚动区路径的 chalk 样式器。在调用时解析当前主题，这样 `/theme`
 *  切换会应用到之后提交的所有内容。 */
export function paint(token: ChromeToken): (s: string) => string {
  const def = TOKENS[token]
  const kind = themeKind()
  if (kind === 'ansi') {
    if (def.ansi === null) return (s) => s
    return c[def.ansi] as (s: string) => string
  }
  return (s) => c.hex(def[kind])(s)
}

// ── 用户回显块 ───────────────────────────────────────────────────
//
// 滚动区中已提交的 `› user question` 块用整行背景，让问题在助手 markdown
// 旁边读起来是独立的块（后者已经自由使用 bold/primary，排除了文本级
// 高亮）。与 codex-rs 的 `user_message_style` 同理，只不过 codex 通过
// OSC 11 探测终端背景并在运行时混色。
//
// 这张卡片刻意与主题无关：深色和浅色主题都用深暖灰 #3c3836
// （gruvbox 深色 bg1），里面的文本/箭头是固定的浅色 hex。这是经过真实
// 用户迭代选定的：按主题的浅色面板在白色终端上要么几乎看不见
// （#eee4cf / #f0ece1）要么刺眼（#ebdbb2），而冷色调（catppuccin
// surface0 #313244）在中性镶边旁显得发闷。浅色主题下终端默认前景是深色
// ——放在深色卡片上会读不清，所以内容必须自带浅色。
const USER_ECHO_BG = '#3c3836'
const USER_ECHO_FG = '#f8f8f2'
const USER_ECHO_ARROW_FG = '#b3b3b3'

/** 用户消息回显块的背景样式器。对 *-ansi 主题（它们遵循终端自己的 16 色
 *  调色板——强行 hex 背景会冲突）和禁用颜色时返回 null；此时调用方回退到
 *  粗体文本。 */
export function paintEchoBg(): ((s: string) => string) | null {
  if (!COLORS_ENABLED) return null
  if (themeKind() === 'ansi') return null
  return (s) => c.bgHex(USER_ECHO_BG)(s)
}

/** 回显卡片问题文本的固定浅色前景——与卡片本身一样，与主题无关。 */
export function paintEchoFg(): (s: string) => string {
  return (s) => c.hex(USER_ECHO_FG)(s)
}

/** 回显卡片的固定浅灰箭头色（在 USER_ECHO_BG 上对比度约 5:1）。按主题解析
 *  的 border/textDim 值在浅色主题下会掉到约 1.3:1。 */
export function paintEchoArrow(): (s: string) => string {
  return (s) => c.hex(USER_ECHO_ARROW_FG)(s)
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
export function cellFg(token: ChromeToken, mods: CellMods = {}): string {
  const def = TOKENS[token]
  const kind = themeKind()
  const attrs = `${mods.bold ? ';1' : ''}${mods.dim ? ';2' : ''}${mods.italic ? ';3' : ''}`
  // NO_COLOR 会去掉颜色序列但保留属性修饰——该约定管的是颜色，不是强调。
  if (!COLORS_ENABLED) return `\x1b[0m${attrs ? `\x1b[${attrs.slice(1)}m` : ''}`
  if (kind === 'ansi') {
    if (def.ansi === null) return '\x1b[0m'
    return `\x1b[0m\x1b[${ANSI_FG[def.ansi]}${attrs}m`
  }
  const [r, g, b] = hexToRgb(def[kind])
  return `\x1b[0m\x1b[38;2;${r};${g};${b}${attrs}m`
}
