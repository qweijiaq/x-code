// ChatInput 单元格 diff 渲染器使用的宽度/路径/ANSI 辅助函数。`isWide` /
// `charWidth` / `visualWidth` / `sliceByWidth` 位于 `../../text-width.js`——聊天输入
// 帧、滚动区 diff、markdown 表格布局的唯一事实来源。下面的辅助函数建立在这些原语
// 之上。
import { GLYPH_ELLIPSIS } from '../render/terminal-glyphs.js'
import { charWidth, graphemes, visualWidth } from '../render/text-width.js'
import type { Cell } from './cells.js'

/** 省略号的显示宽度。所有按列计算的裁剪都必须用它（而不是硬编码 1），否则
 *  `GLYPH_ELLIPSIS` 一旦变成多列字形，预算就会悄悄超出一列。 */
const ELLIPSIS_WIDTH = visualWidth(GLYPH_ELLIPSIS)

export function truncateCellRow(cells: Cell[], maxWidth: number): Cell[] {
  let w = 0
  for (let i = 0; i < cells.length; i++) {
    if (w + cells[i]!.width > maxWidth) {
      const truncated = cells.slice(0, i)
      if (w + 1 <= maxWidth) {
        truncated.push({ char: GLYPH_ELLIPSIS, style: cells[i]!.style, width: 1 })
      }
      return truncated
    }
    w += cells[i]!.width
  }
  return cells
}

/** 把 `cells` 硬折到最多 `maxRows` 行、每行 `maxWidth` 宽。内容超出行预算时，裁掉
 *  最后一行的尾部单元格并追加省略号。按字符折行（无词边界）——与 `truncateCellRow`
 *  同模型，只是多行。 */
export function wrapCellsToRows(cells: Cell[], maxWidth: number, maxRows: number): Cell[][] {
  if (maxRows <= 0 || maxWidth <= 0) return []
  const rows: Cell[][] = []
  let current: Cell[] = []
  let currentWidth = 0
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (currentWidth + c.width > maxWidth) {
      rows.push(current)
      if (rows.length >= maxRows) {
        const last = rows[rows.length - 1]!
        let lastW = currentWidth
        const ellipsisStyle = last.length > 0 ? last[last.length - 1]!.style : c.style
        while (last.length > 0 && lastW + 1 > maxWidth) {
          lastW -= last.pop()!.width
        }
        last.push({ char: GLYPH_ELLIPSIS, style: ellipsisStyle, width: 1 })
        return rows
      }
      current = []
      currentWidth = 0
    }
    current.push(c)
    currentWidth += c.width
  }
  if (current.length > 0) rows.push(current)
  return rows
}

export function skipByWidth(str: string, skipCols: number): number {
  let w = 0,
    i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += charWidth(ch)
    i += ch.length
  }
  return i
}

/** 从开头截断斜杠分隔的路径，让 basename 始终保留。
 *  `packages/core/src/agent/very-long-name.ts` → `…/agent/very-long-name.ts`。
 *  仅供 @-补全菜单使用——读者关心是哪个文件，远胜过关心它的顶层包，所以丢掉前导
 *  目录反而保留了最有信息量的字符。仅当 basename 自身溢出时才回退到尾裁剪。 */
export function truncatePathFromStart(p: string, maxCols: number): string {
  if (visualWidth(p) <= maxCols) return p
  // 预算比省略号本身还窄时，任何形式的裁剪都会超出 maxCols，只能退化为省略号
  // （或空串）——否则调用方所在帧会多占一列并触发终端自动换行。
  if (maxCols <= 0) return ''
  if (maxCols <= ELLIPSIS_WIDTH) return GLYPH_ELLIPSIS
  const segs = p.split('/')
  const basename = segs[segs.length - 1] ?? ''
  // 仅 basename 就溢出：尾裁剪它（罕见——basename 很少超过终端宽度，但单个超长
  // 文件名不该让渲染崩溃）。
  if (visualWidth(basename) >= maxCols - ELLIPSIS_WIDTH) {
    // 按字素簇从尾部回填而不是 `slice(length - N)`：`basename.length` 是 UTF-16
    // 码元数，CJK/emoji 的 basename 会被截出孤立代理项（乱码），且 2 列宽的字符
    // 按码元数目预算会让结果宽度翻倍溢出，触发调用方（补全菜单、permission
    // 提示）所在帧的终端自动换行。
    const keep = maxCols - ELLIPSIS_WIDTH
    const gs = graphemes(basename)
    let tail = ''
    for (let i = gs.length - 1; i >= 0; i--) {
      const next = gs[i]! + tail
      if (visualWidth(next) > keep) break
      tail = next
    }
    return GLYPH_ELLIPSIS + tail
  }
  let acc = basename
  for (let i = segs.length - 2; i >= 0; i--) {
    const next = segs[i] + '/' + acc
    if (visualWidth(GLYPH_ELLIPSIS + '/' + next) > maxCols) break
    acc = next
  }
  return GLYPH_ELLIPSIS + '/' + acc
}

/** 剥离 ANSI CSI + OSC 转义序列，让视觉宽度计算忽略它们。用于统计一段滚动区负载
 *  会占多少个终端行，它驱动预滚动行数——多算或少算会留下可见空隙，或让内容溢出到
 *  帧区域。 */
function stripAnsi(s: string): string {
  return (
    s
      // CSI：参数字节含 `:`（真彩色 `38:2::r:g:b`）与 `<`/`>`/`=` 私有参数，
      // 中间字节 0x20–0x2F，终止字节是 0x40–0x7E（`@`、`` ` `` 等也是合法终止符）。
      .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, '')
      // OSC：以 BEL 或 ST（`ESC \`）终止；串尾被截断时再兜底吞掉剩余部分。
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\][\s\S]*$/, '')
  )
}

/** 制表位宽度：终端把 `\t` 推进到下一个 8 列的整数倍位置。 */
const TAB_WIDTH = 8

/** 一行的显示宽度，按终端的制表位语义展开 `\t`。
 *  `charWidth('\t')` 返回 1，与终端实际的跳格行为不符；`countSpillRiskRows` 的
 *  注释已经承认这一点并给 `\t` 单独分支，本函数必须与它口径一致，否则预滚动行数
 *  会被低估、内容溢出到帧区域。 */
function lineDisplayWidth(line: string): number {
  if (!line.includes('\t')) return visualWidth(line)
  let width = 0
  for (const ch of line) {
    width = ch === '\t' ? (Math.floor(width / TAB_WIDTH) + 1) * TAB_WIDTH : width + charWidth(ch)
  }
  return width
}

/** 统计可能被行数被低估的滚动区提交物理覆盖的帧顶行。MINIMAL-WRITE 提交路径会把
 *  内容直接写到实时帧上方；当终端比 countContentRows 预测的晚一行折行时，被折的尾
 *  部会溅到帧的顶部行上。单元格 diff 循环看不到这个溅出——它 diff 的是内存里的
 *  prevFrame，而不是屏幕——所以它只重写有差异的单元格，把溅出的第一列和尾部字符留
 *  在帧行里画着。
 *
 *  当一行的尾部落在右边缘或接近右边缘时，它就是溅出风险：恰好是 `termWidth` 的整数
 *  倍会触发延迟折行角落，某些终端把它实体化为真实行（conhost / Windows Terminal——
 *  见 writeUserMessage 的最后一列防护）；而末尾落在距边缘几个单元格之内的一行，在
 *  宽/歧义宽度与我们表格不一致的终端上会晚一行折行（常见的 CJK 场景）。制表符始终
 *  有风险：charWidth 把 `\t` 算作 1 个单元格，但终端会跳到下一个 8 列制表位，所以
 *  任何计算出的折行点都不可靠。 */
export function countSpillRiskRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const w = Math.max(1, termWidth)
  const margin = Math.min(4, w - 1)
  let risk = 0
  for (const line of clean.split('\n')) {
    if (line.includes('\t')) {
      risk++
      continue
    }
    const width = visualWidth(line)
    if (width === 0) continue
    const rem = width % w
    if (rem === 0 || rem >= w - margin) risk++
  }
  return risk
}

/** 统计 `content` 写到空白区域顶部时会占的显示行数。用视觉（CJK 感知）宽度计入
 *  在 `termWidth` 处的折行。尾部 `\n` 不算一行（光标只是前进到下一行，但那一行没有
 *  内容）。 */
export function countContentRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = clean.split('\n')
  const effective = clean.endsWith('\n') ? lines.slice(0, -1) : lines
  const w = Math.max(1, termWidth)
  let rows = 0
  for (const line of effective) {
    rows += Math.max(1, Math.ceil(lineDisplayWidth(line) / w))
  }
  return rows
}
