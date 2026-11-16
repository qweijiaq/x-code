// @x-code-cli/cli — 启动 header 横幅
//
// printHeader() 在 Ink 启动之前直接把横幅写到 stdout。这避免了 Ink <Static>
// 的重渲染 bug——动态区域高度变化时 header 会重复出现。
import { VERSION } from '../../version.js'
import { paint } from '../render/tokens.js'

/**
 * 返回启动横幅占用的终端行数。ChatInput 需要它来正确初始化
 * blank-rows-above-frame 追踪器（否则补全菜单 / 对话框第一次长高时，它会预滚动
 * 实际是空白的行，浪费 viewport 空间，并把横幅不必要地推进真正的 scrollback）。
 */
export function getHeaderRowCount(): number {
  return renderHeader().split('\n').length - 1 // 最后的 '\n' 会多出一个空 split
}

/**
 * 把启动横幅构建成一个字符串。
 *
 * 只保留一行 wordmark + 版本：用户明确要求简洁，把纵向空间留给对话本身。
 * 模型名和上下文用量在输入框下方的 footer 里常驻显示，不需要在这里重复。
 */
function renderHeader(): string {
  const primary = paint('primary')
  const strong = paint('textStrong')
  const muted = paint('textMuted')
  const line = `  ${primary('◆')} ${strong('X-Code')}  ${muted(`v${VERSION}`)}`
  return `\n${line}\n\n`
}

/**
 * 把启动 header 横幅直接打印到 stdout。
 * 在 Ink 的 render() 之前调用一次，这样它就永远不会被重绘。
 */
export function printHeader(): void {
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
  process.stdout.write('\x1b[0m' + renderHeader())
}
