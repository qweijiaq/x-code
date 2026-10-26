// @x-code-cli/cli — 平台感知的 Unicode 字形回退。
//
// 旧版 ConHost（cmd.exe / Windows Terminal 之外的 Windows PowerShell 宿主）
// 默认字体（Lucida Console、Consolas、SimSun、NSimSun、MS Gothic）缺少
// CP437 / Latin-1 Supplement 范围之外的许多 Unicode 字形。像 ●、›、⎿、
// ✢、✶、✓、◼、•、▎ 这类字符要么渲染成缺字方框（□），要么宽度不对，
// 产生用户描述的「难看」/「破碎」的视觉伪影。
//
// 本模块把 TUI 中用到的所有装饰性 Unicode 统一收口到一个能力检测闸门后面。
// 每条渲染路径（ChatInput 单元格缓冲、stdout-writer 滚动区、render-markdown、
// AppHeader）都从这里导入字形，而不是硬编码字面量。
//
// 检测逻辑与 ChatInput.tsx 里已有的 spinner ASCII 回退一致：WT_SESSION →
// Windows Terminal（Cascadia Mono，完整 Unicode）；TERM_PROGRAM=vscode →
// VSCode 集成终端；win32 上两者都没有 → 旧版 ConHost。非 Windows 平台
// 始终使用完整字形。

/** 当终端是无法可靠渲染 CP437 / Latin-1 Supplement（U+0000–U+00FF）和
 *  制表符块（U+2500–U+257F）之外 Unicode 的旧版 ConHost 时为 true。 */
const IS_LEGACY_TERMINAL =
  process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode'

// ── 字形表 ─────────────────────────────────────────────────────────
//
// 每对导出：`GLYPH_NAME` = 完整 Unicode，回退 = ASCII/Latin-1。
// 使用者导入该名字，模块加载时即得到正确的变体。

/** 选择器对话框中的「当前选中」单选标记：`●` (U+25CF) → `*` */
export const GLYPH_BULLET = IS_LEGACY_TERMINAL ? '*' : '●'

/** 滚动区和实时帧中行首的状态符号（工具调用、折叠的读取组、peer 消息）：
 *  `•` (U+2022) → `*`。视觉尺寸是 GLYPH_BULLET 的一半——全尺寸的 `●`
 *  在单行工具行旁边显得过大。U+2022 在 CP437/Windows-1252 中，所以即使是
 *  旧版 ConHost 字体也有它；保留 `*` 回退是为了与表格其余部分保持一致。 */
export const GLYPH_TOOL_BULLET = IS_LEGACY_TERMINAL ? '*' : '\u2022'

/** 用户消息提示箭头：`›` (U+203A) → `>`。与 codex CLI 输入框的提示符一致。 */
export const GLYPH_PROMPT_ARROW = IS_LEGACY_TERMINAL ? '>' : '\u203a'

/** 工具结果 / 子项括号：`⎿` (U+23BF) → `|` */
export const GLYPH_RESULT_BRACKET = IS_LEGACY_TERMINAL ? '|' : '⎿'

/** 权限 / 选项选择指针：`›` (U+203A) → `>`。与 GLYPH_PROMPT_ARROW 和
 *  codex CLI 的选择指针一致。 */
export const GLYPH_SELECT_POINTER = IS_LEGACY_TERMINAL ? '>' : '\u203a'

/** 待办已完成勾选：`✓` (U+2713) → `+` */
export const GLYPH_TODO_CHECK = IS_LEGACY_TERMINAL ? '+' : '\u2713'

/** 待办进行中的实心方块：`◼` (U+25FC) → `#` */
export const GLYPH_TODO_IN_PROGRESS = IS_LEGACY_TERMINAL ? '#' : '\u25fc'

/** 待办待处理空心方块：`◻` (U+25FB) → `-` */
export const GLYPH_TODO_PENDING = IS_LEGACY_TERMINAL ? '-' : '\u25fb'

/** 待办面板角落括号：`⎿` (U+23BF) → `|`（与结果括号相同） */
export const GLYPH_TODO_BRACKET = IS_LEGACY_TERMINAL ? '|' : '\u23bf'

/** 引用左侧竖条：`▎` (U+258E) → `|` */
export const GLYPH_BLOCKQUOTE_BAR = IS_LEGACY_TERMINAL ? '|' : '\u258e'

/** 无序列表符号：`•` (U+2022) → `-` */
export const GLYPH_LIST_BULLET = IS_LEGACY_TERMINAL ? '-' : '\u2022'

/** 头部隔断竖线：`│` (U+2502) → `|` */
export const GLYPH_HEADER_PIPE = IS_LEGACY_TERMINAL ? '|' : '\u2502'

/** 会话选择器中的 fork 谱系箭头：`↳` (U+21B3) → `->` */
export const GLYPH_FORK_ARROW = IS_LEGACY_TERMINAL ? '->' : '\u21b3'

/** 省略号：`…` (U+2026)——Windows-1252 和所有 ConHost 字体都有它，
 *  无需回退。导出仅为保持一致，避免使用者硬编码字面量；该值在各平台相同。 */
export const GLYPH_ELLIPSIS = '\u2026'

// Spinner 帧——ChatInput.tsx 里原本就有一份部分回退，现在收口到这里。
// ConHost 默认字体缺少 U+2722–U+273D（dingbats 装饰符号）。
const SPINNER_BASE_RICH = ['·', '✢', '*', '✶', '✻', '✽']
const SPINNER_BASE_ASCII = ['·', ':', '+', '*', '+', ':']
const BASE = IS_LEGACY_TERMINAL ? SPINNER_BASE_ASCII : SPINNER_BASE_RICH

/** 完整 spinner 帧序列（正向 + 反向，用于呼吸循环）。 */
export const SPINNER_FRAMES = [...BASE, ...[...BASE].reverse()]

// ── 制表符（render-markdown 中的表格）──────────────────
//
// 细制表符范围 U+2500–U+257F 在所有 ConHost 字体（Lucida Console、
// Consolas、SimSun 及全部 CJK 回退字体）中都存在——它们是 CP437（最初的
// IBM PC 字符集）的一部分。AppHeader logo 用的双线范围 U+2550–U+256C
// 同理。这些字符不需要回退。
//
// 水平线字符 `─` (U+2500) 和表格字符 `┌┐└┘├┤┬┴┼│` 都在这个安全范围内。
// 无需导出——它们在我们支持的所有终端上都能正确渲染。
