// ChatInput 直写 stdout 的单元格 diff 渲染器所用的单元格风格调色板。
//
// 颜色风格作为 `let` 绑定从 `ui/tokens.ts`（唯一事实来源）派生——`rebuildPalette()`
// 会在运行时 `/theme` 切换时重新派生它们。单元格 diff 发射器不能跑 chalk，所以这些
// 保持原始转义字符串；tokens.ts 保证它们以 `\x1b[0m` 开头，这样没有单元格会继承
// 前一个单元格的 SGR 状态。
//
// 再往下的结构性（非颜色）常量保留手调的字节序列，以及解释为什么的注释。
import { cellFg } from '../render/tokens.js'

// ── 派生颜色风格（主题切换时重建） ─────────────────────

/** 提示框边框（`╭╮╰╯` 角、`─` 横线、`│` 竖线）。 */
export let S_BORDER = cellFg('border')
/** 品牌主色——实时工具 `(preview)`、补全/选中标签。 */
export let S_PRIMARY = cellFg('primary')
export let S_PRIMARY_BOLD = cellFg('primary', { bold: true })
/** 页脚状态栏颜色（Codex CLI 风格）：模型标签用柔和的黄色，相邻信息用柔和的
 *  绿色——明亮、不调暗，让页脚读起来像实时状态而非元文本。 */
export let S_MODEL = cellFg('model')
export let S_USAGE = cellFg('usage')
/** 素净的近白强调色——权限对话框标题和 Yes 选项。 */
export let S_TEXT_STRONG = cellFg('textStrong')
export let S_TEXT_STRONG_BOLD = cellFg('textStrong', { bold: true })
/** 主力元信息/提示灰——页脚模型标签、菜单描述、权限选项标签。用显式的 textDim
 *  十六进制色而非 ANSI dim 属性：`\x1b[2m` 在终端默认前景色上会渲染成变暗的默认
 *  色阶（暗色主题下常约为 #808080），用户读起来觉得「太暗看不清」。十六进制色保持
 *  同样的「先重置」保证（cellFg 总是先发 `\x1b[0m`），所以没有单元格会继承前一
 *  个单元格的 SGR 状态。 */
export let S_DIM = cellFg('textDim')
/** 旋转器字形。与 S_PRIMARY 同色，但占一个独立的语义槽，这样旋转器以后可以分叉
 *  演化，而不必改动强调样式。 */
export let S_SPINNER = cellFg('primary')
export let S_SUCCESS = cellFg('success', { bold: true })
// SUCCESS 的非加粗变体——用于实时工具 `•` 圆点，使它和已提交的
// `stdout-writer.formatToolCall` 输出完全一致（那里 `paint('success')(GLYPH_TOOL_BULLET)`
// 是不加粗的）。如果实时侧用了加粗变体，圆点会在工具结束那一刻明显「褪去加粗」。
export let S_SUCCESS_DOT = cellFg('success')
// 运行中工具圆点脉冲动画的「暗」半帧。与 S_SUCCESS_DOT 同绿色，但叠加了 ANSI
// dim 属性 (2)，让终端把它渲染成同一颜色的柔和暗影，而不是完全不同的另一种颜色。
// 每隔几帧 spinner 在它和 S_SUCCESS_DOT 之间切换，产生 CC 用来表示工具正在运行
// 的亮↔暗「心跳」，让用户一眼看出滚动区里哪条已提交行变成了实时行。
export let S_SUCCESS_DOT_DIM = cellFg('success', { dim: true })
export let S_WARNING = cellFg('warning')
export let S_WARNING_BOLD = cellFg('warning', { bold: true })
/** 非加粗错误文本——与已提交的 `paint('error')` 输出一致。 */
export let S_ERROR = cellFg('error')
export let S_ERROR_BOLD = cellFg('error', { bold: true })
/** `/theme` 切换后，从 tokens 重新派生每一种颜色风格。ESM 活绑定会把新字符串
 *  传播给所有导入方。 */
export function rebuildPalette(): void {
  S_BORDER = cellFg('border')
  S_PRIMARY = cellFg('primary')
  S_PRIMARY_BOLD = cellFg('primary', { bold: true })
  S_MODEL = cellFg('model')
  S_USAGE = cellFg('usage')
  S_TEXT_STRONG = cellFg('textStrong')
  S_TEXT_STRONG_BOLD = cellFg('textStrong', { bold: true })
  S_DIM = cellFg('textDim')
  S_SPINNER = cellFg('primary')
  S_SUCCESS = cellFg('success', { bold: true })
  S_SUCCESS_DOT = cellFg('success')
  S_SUCCESS_DOT_DIM = cellFg('success', { dim: true })
  S_WARNING = cellFg('warning')
  S_WARNING_BOLD = cellFg('warning', { bold: true })
  S_ERROR = cellFg('error')
  S_ERROR_BOLD = cellFg('error', { bold: true })
}

// ── 结构性风格（非颜色——固定字节序列） ──────────────

// 加粗但无前景色——与已提交的 `c.bold(label)` 一致。
// 必须以 `\x1b[0m` 开头，重置任何先前的前景色，这样加粗就不会继承前一个单元格的
// 颜色（与上面派生风格同理）。
export const S_BOLD = '\x1b[0m\x1b[1m'
// ANSI 90（亮黑）。等价于 chalk 的 `c.gray()` 输出——`c.gray('⎿')` 发
// `\x1b[90m...\x1b[39m`。用于那些必须与已提交滚动区里 `c.gray()` 风格字形在视觉
// 上一致的单元格（当前：工具行里的 `⎿` 连接符和 `(duration)` 后缀）。S_DIM
// （`\x1b[2m` = 默认前景上的 dim 属性）在多数终端上渲染出的色阶与 `\x1b[90m`
// （显式调色板条目）明显不同——工具结束、其行从实时帧切到滚动区的那一刻，用户会
// 察觉到一次颜色闪烁。
export const S_GRAY_90 = '\x1b[0m\x1b[90m'
// S_NONE 表示「默认风格——无前景色、无属性」，且必须是非空转义，否则单元格 diff
// 循环里的 `if (cell.style !== lastStyle) buf += cell.style` 分支会发空字符串，让
// 终端 SGR 状态继承自之前任何内容。这曾渲染出类似
// `[' '(NONE)][glyph(BLUE)][' '(NONE)][T(BLUE)]…` 的行，尾部的 NONE 空格继承了
// BLUE——在非原子终端上，冗余 SGR 码紧跟字符之后到达，用户会看到 "Working" 文本
// 在帧与帧之间闪白→蓝。把 S_NONE 设成显式 DEC 重置（`\x1b[0m`，与 S_RESET 同字
// 节），让每个 NONE 单元格在字形前显式清除风格，从而消除继承和可感知的闪烁。
// 行尾重置所有属性（\x1b[0m），而不只是前景色（\x1b[39m）。加粗单元格（如权限
// 对话框的 Yes/No 高亮）否则会把加粗属性渗漏到下一行。单元格 diff 发射器会在下一
// 行首单元格重发任何非空风格，所以这里全量重置是安全的。
export const S_RESET = '\x1b[0m'
export const S_NONE = '\x1b[0m'
// 反显块，用来把输入光标位置「画」成一个普通单元格。真正的终端光标在应用范围内
// 是隐藏的（见组件挂载时的 useEffect），所以这是用户唯一看到的「光标」。与单元格
// diff 帧的其余部分一起原子更新，因此它自身从不闪烁。仿照 Gemini CLI 的
// `<Text terminalCursorFocus>` 做法（在插入符位置渲染一个反显块），以及 Claude
// Code 同样的隐藏光标策略。
export const S_CURSOR = '\x1b[7m'

// NOTE：`\x1b7` / `\x1b8`（DECSC / DECRC）在本文件任何地方都刻意不用。终端只提供
// 一个保存寄存器，而 Ink 自己的 log-update 每个渲染周期都会复用它——两处共同占用会
// 产生「幽灵」恢复位置。我们用相对移动（CUU / CUD / \r / \x1b[NG 绝对列）重建光标
// 位置，并把对话框之后的过渡当作全新的首帧（清空 prevFrameRef），从而彻底消除跨写入
// 方的争用。过渡场景的推理见 ChatInput 里的 wasHidden 处理器。

/** DEC 2026「同步更新模式」。在 BSU 与 ESU 之间，支持的终端会缓冲全部输出并把它
 *  渲染成单个原子帧。这消除了 eraseRegion 擦掉帧与随后全量重渲染之间的闪烁——用户
 *  只看到最终状态，永远不会看到中间的空白区域。不支持的终端会静默忽略这些序列。
 *
 *  光标可见性刻意不在每次渲染周围切换。早期版本在 BSU 里循环 `\x1b[?25l`、在 ESU
 *  里循环 `\x1b[?25h`，以掩盖那些不能完全原子化 DEC 2026 的终端上 diff 循环的中间
 *  光标位置。在 80ms 的 spinner 节奏下，这产生了一个 12Hz 的隐藏/显示抖动，用户
 *  感知为输入行周围的「上下抖动」闪烁——而同步模式批量处理已经在我们目标的每台
 *  终端（xterm.js / VSCode、Windows Terminal、iTerm2、Ghostty）上隐藏了中间位置。
 *  所以：光标全程保持显示；同步模式负责原子性；缓冲区末尾的停靠会在 ESU 提交前把
 *  光标放到输入列。当没有活动锚点（禁用 / 对话框）时，ESU_HIDE 显式隐藏。 */
export const BSU = '\x1b[?2026h'
export const ESU_HIDE = '\x1b[?2026l\x1b[?25l'

// NOTE：一个基于 DECSTBM 的 `buildInsertHistoryAbove` 曾短暂存在于这里（仿照
// codex-rs 的 insert_history.rs），但被回退了，因为它要求单元格缓冲锚定在终端最底
// 部——这在 codex-rs 里成立（ratatui 的 Terminal 管理一个视口矩形），但在我们这里
// 不成立：横幅 + 部分滚动状态可能让单元格缓冲停在屏幕中部。设置滚动区域
// `[1, termRows - cellBufH]` 后会与实时单元格缓冲行重叠，于是历史写入撕穿了帧。
// 要正确重做这个修复，需要一次「每次渲染都用绝对光标定位把单元格缓冲强制到最后一
// N 行」的重构——已单独跟踪。
