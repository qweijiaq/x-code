// @x-code-cli/cli — 启动 header 横幅
//
// printHeader() 在 Ink 启动之前直接把横幅写到 stdout。这避免了 Ink <Static>
// 的重渲染 bug——动态区域高度变化时 header 会重复出现。
import { VERSION } from '../../version.js'
import { GLYPH_HEADER_PIPE } from '../render/terminal-glyphs.js'
import { chalk as c, paint } from '../render/tokens.js'

// ── 不同终端宽度下的 ASCII logo ──

const LOGO_WIDE = `
  ██╗  ██╗       ██████╗ ██████╗ ██████╗ ███████╗
  ╚██╗██╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ╚███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗  
   ██╔██╗ ╚════╝██║     ██║   ██║██║  ██║██╔══╝  
  ██╔╝ ██╗      ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`

const LOGO_NARROW = '  ╳ X-Code CLI'

/**
 * 返回启动横幅占用的终端行数。ChatInput 需要它来正确初始化
 * blank-rows-above-frame 追踪器（否则补全菜单 / 对话框第一次长高时，它会预滚动
 * 实际是空白的行，浪费 viewport 空间，并把横幅不必要地推进真正的 scrollback）。
 */
export function getHeaderRowCount(modelId: string): number {
  return renderHeader(modelId).split('\n').length - 1 // 最后的 '\n' 会多出一个空 split
}

/**
 * 把启动横幅构建成一个字符串。
 */
function renderHeader(modelId: string): string {
  const cols = process.stdout.columns ?? 80

  const isWide = cols >= 52
  const logo = isWide ? LOGO_WIDE : LOGO_NARROW

  // 从 "provider:model-name" 中提取 provider 与 model
  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  // Newline 快捷键提示：
  //   - 结尾的 `\` + Enter 是通用回退（在每个终端都有效——ConHost、
  //     Terminal.app、整个 xterm 家族）。
  //   - Alt/Option+Enter 在多数现代终端有效（Windows Terminal、带 Esc+
  //     Option 的 iTerm2、GNOME Terminal、kitty、WezTerm）。在 macOS
  //     Terminal.app 上，用户必须在 profile 设置里开启 "Use Option as Meta
  //     key"——否则只有 `\` 形式有效。
  // 为什么没有 Ctrl/Cmd+Enter：原装终端对普通 Enter 和 Ctrl+Enter 发送同一个
  // 字节，所以我们无法区分。modifyOtherKeys / kitty CSI-u 形式是接受的（见
  // use-prompt-input.ts），但它们需要终端特定的 opt-in，这里就不展示了。
  const isMac = process.platform === 'darwin'
  const abortKey = isMac ? '⌃C' : 'Ctrl+C'
  const newlineKey = isMac ? '⌥⏎ or \\⏎' : 'Alt+Enter or \\+Enter'

  const primary = paint('primary')
  // Meta 文本（版本、模型标签、提示）使用提亮的 textDim token，而不是 chalk 的
  // dim ATTRIBUTE：该属性会渲染成终端自身默认前景色加深一档的效果，在许多暗色
  // 主题上显得过于暗淡。textDim 会根据活动主题解析，所以 `/theme` 切换能让横幅
  // 保持一致。
  const dim = paint('textDim')

  const lines = [
    primary(c.bold(logo)),
    '', // logo 与状态信息之间的呼吸空间
    `  ${dim(`v${VERSION}`)} ${dim(GLYPH_HEADER_PIPE)} ${dim('model:')} ${primary(`${provider}/${modelName}`)}`,
    `  ${dim(`/help commands · ${abortKey} abort · ${newlineKey} newline`)}`,
    '', // header 之后的空行
  ]

  return lines.join('\n') + '\n'
}

/**
 * 把启动 header 横幅直接打印到 stdout。
 * 在 Ink 的 render() 之前调用一次，这样它就永远不会被重绘。
 */
export function printHeader(modelId: string): void {
  // 在写入之前，把终端 viewport 里既有的内容推进 scrollback，并把光标停在 (1,1)。
  // 没有这一步，当启动发生在嘈杂的前奏之后（pnpm dev 构建日志、用户的命令回显
  // 等）时，光标会停在 viewport 底部附近——横幅也落在那儿，而 ChatInput 的
  // 底部固定帧会画在横幅最后几行之上。这正是之前只有 logo 上半部分显示的原因。
  //
  // `\n`×(rows-1) 把之前的 viewport 内容自动滚进真正的 scrollback 历史（在终端里
  // 向上滚动仍可访问）；`\x1b[H` 随后把光标归位，让横幅写在第 1 行，把下面所有行
  // 留空给 ChatInput 用作它的 pin-to-bottom 领地。
  //
  // 在这样做之前试过并否决的两条路径：
  //   - `\x1b[2J\x1b[H`（清屏 + 归位）：概念上更干净，但 Windows 上若干终端/代码页
  //     组合把 CSI 2J 解释成同时也清除上方可见 scrollback；用户丢失了上下文（他们
  //     输入的命令消失了）。
  //   - `fs.writeSync(1, ...)` 强制同步写：绕过了 Node 对 Windows TTY 的 UTF-16
  //     转换路径，logo 里的制表线字符在 CP936（zh-CN PowerShell 默认）下被渲染成
  //     GBK 字节对。结果是满屏乱码加可见的 scrollback 损坏。
  //
  // 通过 Node tty 层的 process.stdout.write 仍是唯一能在各 Windows 代码页之间
  // 正确处理 Unicode 的路径。
  const rows = process.stdout.rows ?? 25
  if (process.stdout.isTTY && rows > 1) {
    process.stdout.write('\n'.repeat(rows - 1) + '\x1b[H')
  }
  process.stdout.write(renderHeader(modelId))
}
