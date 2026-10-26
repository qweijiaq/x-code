// @x-code-cli/cli — 直接写 stdout 的消息写入器。
//
// 为什么要有它：Ink 的布局引擎会算错宽（CJK）字符的视觉宽度，所以 Ink
// 渲染器重绘某个区域时可能按错误行数回卷并覆盖之前的内容。在较长的中文
// 回复上就表现为「符号被拼接」和工具结果文本错乱。
//
// Claude Code 通过内置一个带字形感知 stringWidth + 软换行元数据的定制 Ink
// fork 来规避同类 bug。我们走更简单的路线：完全在 Ink 之外渲染消息历史，
// 通过 Ink `useStdout()` hook 返回的 `write` 函数把原始 ANSI 写到 stdout。
// 该函数文档描述为「类似 <Static>，只是……它只能处理字符串」——它经过 Ink
// 内部的 writeToStdout，能与 log-update 正确协同（清空动态区 → 写入 →
// 重渲染）。我们避开 `console.log` + `patchConsole`，因为观察到那个 patch
// 库的内部字符串处理在非常大的多行写入时会丢内容。
//
// Ink 仍然拥有屏幕底部的动态区（spinner、进行中的工具调用、权限对话框、
// 聊天输入框）。那个区域很短且几乎全是 ASCII，所以 Ink 自己的测量够用了。
import { debugLog, stripTerminalControls } from '@x-code-cli/core'
import type { DisplayMessage, DisplayToolCall } from '@x-code-cli/core'

import { authorityVisibleText } from '../chat-input/authority-display.js'
import {
  RESULT_INDENT,
  formatDuration,
  formatReadGroupSummary,
  getToolInputPreview,
  getToolLabel,
  getToolResultSummary,
  isCollapsibleReadOnlyTool,
  isShellToolName,
  normalizeLineEndings,
} from '../utils.js'
import { renderEditDiff } from './render-diff.js'
import { renderInlineMarkdown, renderMarkdown } from './render-markdown.js'
import { highlightShellCommand } from './shiki-highlight.js'
import { GLYPH_ELLIPSIS, GLYPH_PROMPT_ARROW, GLYPH_RESULT_BRACKET, GLYPH_TOOL_BULLET } from './terminal-glyphs.js'
import { sliceByWidth, visualWidth } from './text-width.js'
import { chalk as c, paint, paintEchoArrow, paintEchoBg, paintEchoFg } from './tokens.js'

/** 通过 Ink 的 log-update 协同写 stdout 的函数。 */
export type InkWrite = (data: string) => void

/**
 * 截断 `s`，使其在视觉上不超过 `maxLen` 个可打印单元格。我们用 UTF 省略号
 * （…）作为截断标记——单单元格，看起来比三个点更紧凑，与 CC 的截断预览一致。
 */
function truncatePreview(s: string, maxLen: number): string {
  if (maxLen < 4 || s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + GLYPH_ELLIPSIS
}

function formatToolCall(tc: DisplayToolCall): string {
  const label = authorityVisibleText(getToolLabel(tc.toolName))
  const rawPreview = authorityVisibleText(getToolInputPreview(tc.toolName, tc.input))
  // 给预览设上限，避免过长的 Bash 命令 / 文件路径在滚动区里折成参差不齐的
  // 多行块。预算按终端宽度计算，宽终端能获得更多空间。line1 前缀是
  // ` ● <label>(`，结尾是 `)`，所以要为装饰预留 label.length + 5 个单元格；
  // 再留一点安全余量给终端可能附加的 `\x1b[K` / 光标定位。
  const cols = Math.max(40, process.stdout.columns ?? 120)
  const decoration = label.length + 5
  const safetyMargin = 4
  const maxPreviewLen = Math.max(40, cols - decoration - safetyMargin)
  const inputPreview = truncatePreview(rawPreview, maxPreviewLen)
  const rawResultSummary = getToolResultSummary(tc.toolName, tc.output, tc.status)
  const resultSummary = rawResultSummary === null ? null : stripTerminalControls(rawResultSummary)
  const isDenied = tc.status === 'denied'
  const isError = tc.status === 'error'
  const isFailure = isDenied || isError
  const durationStr = tc.durationMs != null ? formatDuration(tc.durationMs) : null

  const dotStyle = paint(isFailure ? 'error' : 'success')
  // Shell 命令获得 codex 风格的语法高亮（它们的 `Ran …` 行把命令走一遍
  // syntect 的 bash 语法）：字符串、选项标志和变量获得语法色，命令词保持
  // 终端默认前景色。其他工具保持扁平的 primary 蓝色预览。两种情况括号都
  // 保持 primary 色。
  //
  // 失败（拒绝/出错）的调用跳过语法高亮：它们的预览经过了
  // authorityVisibleText，好让终端注入字节变得可见；如果插入 SGR 颜色序列
  // 会把那段消毒后的文本拆散——用户必须把转义尝试看成一段连续字符串。
  const previewSuffix = inputPreview
    ? isShellToolName(tc.toolName) && !isFailure
      ? `${paint('primary')('(')}${highlightShellCommand(inputPreview)}${paint('primary')(')')}`
      : paint('primary')(`(${inputPreview})`)
    : ''
  const line1 = ` ${dotStyle(GLYPH_TOOL_BULLET)} ${c.bold(label)}${previewSuffix}`

  // Edit / writeFile 成功路径：在符号下渲染结构化 diff，而不是普通的
  // "Wrote N lines" / "Applied changes" 摘要。只有当工具确实成功时才走这个
  // 分支——失败的编辑保留常规 markdown 摘要，让红色错误消息落在用户期望阅读
  // 的位置。
  if (tc.editPayload && !isFailure) {
    const cols = Math.max(40, process.stdout.columns ?? 120)
    const diffLines = renderEditDiff(tc.editPayload, cols)
    const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${diffLines[0] ?? ''}`
    const body = diffLines.slice(1)
    const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
    const combined = body.length > 0 ? [head, ...body] : [head]
    combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
    return `${line1}\n${combined.join('\n')}`
  }

  if (!resultSummary) return line1

  // 让结果走一遍 markdown 管线，这样带标题 / 列表 / 行内代码等的工具输出
  // 能以样式显示，而不是原始的 `### ...` / `**...**` 字符。拒绝和出错的结果
  // 渲染成纯红文本，让失败在滚动区里显眼——与 Claude Code 在非零 shell 退出
  // 时把 stderr/退出码块标红的行为一致。
  const rendered = isFailure ? resultSummary : renderMarkdown(resultSummary).replace(/\n+$/, '')

  // 去掉空行——markdown 渲染会在块之间插入段落间距，让工具结果摘要显得稀疏
  // （标题、空行、URL、空行、"... +7 lines"）。我们想要紧凑的 2-3 行摘要，
  // 而不是分段的正文。
  const lines = normalizeLineEndings(rendered)
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const durSuffix = durationStr ? c.gray(` (${durationStr})`) : ''
  // 出错行在按行拆分之后才应用 ERROR hex 颜色——若在拆分前应用，会在样式中途
  // 内嵌的 ANSI 重置序列处断开，导致正文一半不着色。逐行应用。
  const paintLine = isFailure ? paint('error') : (s: string) => s
  const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${paintLine(lines[0] ?? '')}`
  const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${paintLine(l)}`)
  // 时长放在正文最后一条可见行上，这样截断摘要读起来像 "... +13 lines (1.2s)"。
  const combined = tail.length > 0 ? [head, ...tail] : [head]
  combined[combined.length - 1] = combined[combined.length - 1] + durSuffix
  return `${line1}\n${combined.join('\n')}`
}

/** 把每个 LF 替换成 CRLF。用于防御 stdout 的 ONLCR 输出转换被禁用的终端
 *  （Ink 把 stdin 置于 raw 模式，但 stdout 的 termios 设置可能依实现而异，
 *  尤其观察到 VS Code 终端不会把裸 LF 转成 CRLF）。没有显式的 `\r`，光标会
 *  停在该行结束的那一列，随后单元格缓冲重绘通过 `\x1b[1G` 定位到第 1 列——
 *  只覆盖前几列，刚写入文本的尾部就「出现在」下一行内容的右侧（看起来像
 *  Working 旁边的残缺文本）。 */
function toCRLF(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}

/**
 * 上一次滚动区写入是否在其最后一行内容下方留下了一整行空白？用于让相邻实体
 * 之间始终恰好保留一行空白，无论哪个实体先写。
 *
 * 为什么需要这个标志：流式文本块每个都以单个 `\n` 结尾（光标在下一行，无尾随
 * 空白），所以紧跟流之后提交的工具调用会紧贴文本。用户消息和已完成的工具/
 * 文本写入已经留下尾随空白，因此背靠背的块不需要额外间隔。这个标志让下一个
 * 实体决定：如果上一次写入没有在自身下方留空白，就补一个；否则不补。
 *
 * 初始化为 `true`，这样会话的第一次写入不会在终端顶部画出一行前导空白。
 */
let prevWriteEndedWithBlankRow = true

/**
 * 上一次写入是流式文本块吗？当下一次写入也是流式块时，我们把它当作同一条
 * assistant 消息的延续，不补 `prevWriteEndedWithBlankRow` 机制本来会加的前导
 * 空白。每个流式块都以单个 `\n` 结尾（无尾随空白），没有这个守卫，空白会在
 * 每个块边界被注入——而且流缓冲是按节奏刷新而非按 markdown 结构刷新的，这些
 * 边界落在相邻列表项 / 段落行之间，会在模型本来没有空行的地方产生可见的行间
 * 空隙。
 */
let prevWriteWasStreamingChunk = false

/** 重置间距标志——在滚动区被清空（如 /clear）时调用，让下一次写入不会以为
 *  上方还有空白。同时丢弃所有缓冲的读取组条目：/clear 之后它们指向的是已经
 *  不在滚动区里的清除前消息，提交它们的摘要会在现已为空的历史上方留下幽灵行。 */
export function resetScrollbackSpacing(): void {
  prevWriteEndedWithBlankRow = true
  prevWriteWasStreamingChunk = false
  pendingReadGroup = []
}

/** 最近一次滚动区写入是否在其最后一行内容下方留下了一整行空白？ChatInput 的
 *  帧构建器读取它，让实时工具/spinner 块能应用与已提交工具路径相同的
 *  前导空白规则——没有它，实时帧会紧贴流式文本绘制，空白只在工具完成时才
 *  「出现」（可见的间距跳变）。 */
export function lastWriteEndedWithBlankRow(): boolean {
  return prevWriteEndedWithBlankRow
}

/** 连续已完成只读工具调用的待提交缓冲。保存背靠背到达的 Read / Glob / Grep /
 *  ListDir（`isCollapsibleReadOnlyTool`）行，以便把它们折叠成一行
 *  `● Read 3 files (foo.ts, bar.ts, baz.ts)` 摘要。
 *
 *  为什么用模块级缓冲而不是渲染时变换：滚动区是只追加的终端历史——一行一旦
 *  通过 `process.stdout.write` 写出就无法重写。Claude Code 之所以能纯在渲染时
 *  做这个变换，是因为 Ink 拥有整个 transcript 并在每次状态变化时重渲染；我们
 *  没有这个能力，所以唯一「合并」的办法是推迟提交各行，直到知道后面还会不会有
 *  更多行。
 *
 *  冲刷在以下情况触发：(a) 任何不可折叠消息进入 `writeMessageToStdout`（assistant
 *  文本、写工具、用户消息——它们会打断链条），或 (b) 外部调用
 *  `flushPendingReadGroup`，例如 ChatInput 在轮次结束时的提交遍历。
 *
 *  用户可感知的后果：单个孤立的读取工具要等 assistant 输出其收尾文本（或轮次
 *  结束）才出现在滚动区里。链条运行期间由实时工具指示器覆盖这段空档，所以正常
 *  流程中这个延迟不可见。这个取舍对多读取链的收益是划算的，而多读取链正是
 *  促成这一机制的噪音来源。 */
let pendingReadGroup: DisplayToolCall[] = []

/** 当 `msg` 是只含已完成、非编辑、只读工具调用的单消息包且别无他物（无
 *  assistant 文本、无命令类型）时为 true。这类消息有资格进缓冲——其他消息
 *  会先冲刷缓冲再正常渲染。 */
function isCollapsibleMessage(msg: DisplayMessage): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.content) return false
  if (msg.kind) return false
  if (!msg.toolCalls || msg.toolCalls.length === 0) return false
  return msg.toolCalls.every(
    (tc) => tc.status === 'completed' && !tc.editPayload && isCollapsibleReadOnlyTool(tc.toolName),
  )
}

/** 渲染一行工具行（单工具冲刷路径）——形状与 `writeMessageToStdout` 工具循环
 *  里 `formatToolCall` 产出的一致。抽取出来让冲刷可以复用，无需重新推导补空
 *  规则。 */
function writeToolRow(write: InkWrite, tc: DisplayToolCall): void {
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** 渲染折叠组摘要行，例如
 *    ` ● Read 3 files (foo.ts, bar.ts, baz.ts)`
 *  格式对标常规工具行以保持视觉节奏：绿色符号（所有成员都已完成）、粗体标签、
 *  primary 色带括号的详情。没有 `⎿` 结果体——折叠的全部意义就是丢掉每调用的
 *  结果行。 */
function writeCollapsedGroup(write: InkWrite, tools: readonly DisplayToolCall[]): void {
  const { label, detail } = formatReadGroupSummary(tools)
  const detailSuffix = detail ? paint('primary')(`(${authorityVisibleText(detail)})`) : ''
  const line = ` ${paint('success')(GLYPH_TOOL_BULLET)} ${c.bold(authorityVisibleText(label))}${detailSuffix}`
  const lead = prevWriteEndedWithBlankRow ? '' : '\n'
  write(toCRLF(lead + line + '\n'))
  prevWriteEndedWithBlankRow = false
  prevWriteWasStreamingChunk = false
}

/** 把任何缓冲的连续只读工具调用提交到滚动区。单个工具 → 渲染成普通工具行
 *  （带其结果体，让孤立的读取不丢失结果简述）。两个或更多 → 折叠成一行摘要。
 *  幂等——缓冲为空时调用也安全。
 *
 *  在 `writeMessageToStdout` 顶部对每条不可折叠消息自动调用，也由 ChatInput
 *  的提交遍历在 `isLoading` 为 false 时外部调用（这样没有收尾文本消息就结束的
 *  链条——例如用户中止——其摘要仍会提交，而不是留在缓冲里悬着）。 */
export function flushPendingReadGroup(write: InkWrite): void {
  if (pendingReadGroup.length === 0) return
  const buffered = pendingReadGroup
  pendingReadGroup = []
  if (buffered.length === 1) {
    writeToolRow(write, buffered[0]!)
  } else {
    writeCollapsedGroup(write, buffered)
  }
}

/** 把一条 DisplayMessage 打印到 stdout。 */
export function writeMessageToStdout(write: InkWrite, msg: DisplayMessage): void {
  if (msg.content) {
    msg = { ...msg, content: stripTerminalControls(msg.content) }
  }
  if (msg.kind === 'peer-message' || msg.kind === 'peer-status') {
    msg = {
      ...msg,
      ...(msg.peer
        ? {
            peer: {
              name: stripTerminalControls(msg.peer.name),
              address: stripTerminalControls(msg.peer.address),
              ...(msg.peer.summary === undefined ? {} : { summary: stripTerminalControls(msg.peer.summary) }),
            },
          }
        : {}),
    }
  }
  // 读取组缓冲：只包含已完成、非编辑、只读工具调用的消息被留在
  // `pendingReadGroup` 里，直到下一条不可折叠消息到来或外部调用
  // `flushPendingReadGroup`。每个其他分支顶部的冲刷会在当前消息渲染前提交
  // 累积的读取，让链条摘要以正确的滚动区顺序落位
  // （` ● Read 3 files` 在 ` …final assistant text` 之上）。
  if (isCollapsibleMessage(msg)) {
    for (const tc of msg.toolCalls!) pendingReadGroup.push(tc)
    return
  }
  flushPendingReadGroup(write)

  if (msg.kind === 'peer-message') {
    const content = normalizeLineEndings(msg.content)
    const peer = msg.peer
    const heading = peer ? `Peer message · ${peer.name} · ${peer.address}` : 'Peer message'
    const summary = peer?.summary ? `\n   ${c.gray(`Summary: ${peer.summary}`)}` : ''
    const body = content
      .split('\n')
      .map((line) => `   ${line}`)
      .join('\n')
    const lead = prevWriteEndedWithBlankRow ? '' : '\n'
    write(toCRLF(`${lead} ${paint('warning')(GLYPH_TOOL_BULLET)} ${c.bold(heading)}${summary}\n${body}\n\n`))
    prevWriteEndedWithBlankRow = true
    prevWriteWasStreamingChunk = false
    return
  }

  if (msg.kind === 'peer-status') {
    const content = normalizeLineEndings(msg.content)
    write(toCRLF(`   ${c.gray(GLYPH_RESULT_BRACKET)}  ${renderInlineMarkdown(content)}\n`))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  if (msg.role === 'user') {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.user', content)
    writeUserMessage(write, content, msg.kind === 'command-echo')
    // writeUserMessage 总是输出尾随的 `\n\n`（紧凑斜杠回显是 `\n`）——两种情况
    // 下一个实体都会落在新行，且前面的空白已经就位。
    prevWriteEndedWithBlankRow = msg.kind !== 'command-echo'
    prevWriteWasStreamingChunk = false
    return
  }

  // 紧凑斜杠命令结果——渲染成紧凑的 `   ⎿  text` 行，让 `> /cmd` + 结果这对
  // 显示为 Claude 风格的 2 行块，而不是命令 + 空行 + 缩进正文 + 空行。3 空格
  // 前缀与 formatToolCall 的结果块缩进一致，所以复用该类型的独立通知（后台
  // shell 生命周期行、压缩摘要、中断）能保持它们的 ⎿ 与上方的工具块对齐，而不是
  // 左移一个单元格；头部文本于是正好落在 RESULT_INDENT，与尾行一致。
  //
  // 正文行经过 `renderInlineMarkdown`，让斜杠命令处理器输出的 `**name**` /
  // `` `code` `` / `_italic_` 标记以样式显示，而不是原始的 `**` / 反引号字符。
  // 我们有意不用 `c.gray(...)` 包裹正文，尽管那是常规的「次要信息」色调：灰色
  // 底色会压暗里面的所有内容（包括 bold 和真彩行内代码），于是 markdown 渲染
  // 视觉上消失——灰色上的粗体灰读起来只是灰，蓝紫色行内代码在灰色背景旁也失去
  // 对比。`⎿` 字形保持灰色作为结构标记；正文内容用终端默认前景色，让 bold 和
  // 行内代码能在其上凸显。
  if (msg.kind === 'command-result' && msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog('stdout.command-result', content)
    const lines = content.split('\n')
    const head = `   ${c.gray(GLYPH_RESULT_BRACKET)}  ${renderInlineMarkdown(lines[0] ?? '')}`
    const tail = lines.slice(1).map((l) => `${RESULT_INDENT}${renderInlineMarkdown(l)}`)
    write(toCRLF([head, ...tail].join('\n') + '\n'))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  // Assistant 消息——可能带工具调用、文本正文，或两者都有。
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      debugLog('stdout.tool-call-line', `${tc.toolName} ${tc.status}`)
      // 如果上一次写入（通常是 assistant 文本体的最后一块流式块）没有在下方
      // 留下空行，就补一个 `\n`。没有这个守卫，文本→工具的过渡会把符号行直接
      // 贴在文本下面——正是用户提出的「工具上方没有呼吸空间」问题。对于已经以
      // `\n\n` 结尾的写入，标志为 true，我们跳过前导换行以免出现双重空行。
      const lead = prevWriteEndedWithBlankRow ? '' : '\n'
      write(toCRLF(lead + normalizeLineEndings(formatToolCall(tc)) + '\n'))
      prevWriteEndedWithBlankRow = false
      prevWriteWasStreamingChunk = false
    }
  }

  if (msg.content) {
    const content = normalizeLineEndings(msg.content)
    debugLog(msg.streamingChunk ? 'stdout.assistant-chunk' : 'stdout.assistant-full', content)
    // 当本块是同一条 assistant 消息中上一个流式块的延续时跳过前导空白——前一个
    // 块已经通过其尾随 `\n` 把光标留在下一行，再补一个 `\n` 会在相邻列表项 /
    // 段落行之间渲染成可见空白，而它们在模型源码里的分隔只是一个换行。空白在
    // 跨非流式实体的文本→文本过渡（工具结果 → 最终文本）时仍会补上，避免任何
    // 内容紧贴。
    const isStreamContinuation = !!msg.streamingChunk && prevWriteWasStreamingChunk
    if (!prevWriteEndedWithBlankRow && !isStreamContinuation) {
      write(toCRLF('\n'))
      prevWriteEndedWithBlankRow = true
    }

    // 特判纯空白流式块（例如裸 "\n" = 两段散文之间的段落分隔标记）。Markdown
    // 渲染会把它折叠成空字符串，从而丢掉视觉段落分隔——所以改为直接把空白
    // 透传。
    if (msg.streamingChunk && content.trim() === '') {
      // 一个裸段落分隔 token。它已经编码了一行空白（仅空白的 `\n` 或 `\n\n`）；
      // 写完它之后光标位于空行下方，所以下一个实体无需再补一个。
      write(toCRLF(content))
      prevWriteEndedWithBlankRow = content.endsWith('\n\n') || content.endsWith('\n')
      prevWriteWasStreamingChunk = true
      return
    }

    // 两空格缩进与各处使用的 assistant 正文间距一致。
    const body = renderMarkdown(content)
    const indented = normalizeLineEndings(body)
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')
    if (msg.streamingChunk) {
      // 流式块自带其尾随换行——renderMarkdown 对列表项输出 "line\n"、对标题
      // 输出 "line\n"，对后面跟着段落分隔 space token 的块输出 "line\n\n"。
      // 缩进的 `  ${line}` 映射原样保留这些尾随 \n。
      //
      // 我们必须确保块至少以一个 \n 结尾，让光标前进到下一行：后续帧重绘从
      // writeMessage 留下光标的位置开始，如果我们输出不带换行的文本，帧的下一个
      // row-0 会覆盖块文本。双保险：如果 renderMarkdown 返回没有尾随换行的正文
      // （未知 token 形状或 catch 回退纯文本路径在理论上可能出现），就补一个 \n。
      const out = indented.endsWith('\n') ? indented : indented + '\n'
      write(toCRLF(out))
      // 以 `\n\n` 结尾的流式块是段落分隔边界（renderMarkdown 在标题 + 空行对
      // 之后放 \n\n，等等）——下一个实体位于真正的空行之下。其他情况只以单个
      // `\n` 结尾，所以仍需要下一个实体自己在上方画空白。
      prevWriteEndedWithBlankRow = out.endsWith('\n\n')
      prevWriteWasStreamingChunk = true
    } else {
      // renderMarkdown 已经用一个或多个换行终止块输出。先规范化该后缀，再添加
      // 分隔滚动区内容和下一个输入帧的那一行空白。
      write(toCRLF(indented.replace(/\n+$/, '') + '\n\n'))
      prevWriteEndedWithBlankRow = true
      prevWriteWasStreamingChunk = false
    }
  }
}

/**
 * 完整回显一条用户消息。多行内容时，我们缩进续行，让它们对齐到第一行 `›`
 * 提示符后的文本下方。假定 `content` 已经规范化使用 `\n` 行分隔符。
 *
 * 每行都有一个细腻的整行背景（内边距画在 bg span 内部），让问题在 assistant
 * markdown 旁读起来是实心块——codex-rs 通过 `user_message_style` 做同样的事。
 * 块在文本之外留有呼吸空间：上下各一行全宽背景作为垂直内边距，外加 `›` 左侧
 * 一个单元格的内缩。在 *-ansi 主题和 NO_COLOR 下，`paintEchoBg()` 返回 null，
 * 我们回退到粗体文本，而不是把 hex 背景强加到终端自己的调色板上。
 *
 * `compact` 用于斜杠命令回显：我们去掉尾随空行，让紧随其后的 `  ⎿  result`
 * 行直接贴在回显底部内边距行之下，与 Claude Code 的 2 行命令块一致。
 */
function writeUserMessage(write: InkWrite, content: string, compact = false): void {
  const bg = paintEchoBg()
  const cols = process.stdout.columns ?? 0
  const arrow = paint('border')(GLYPH_PROMPT_ARROW)
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  if (!bg) {
    const body = [`${arrow} ${c.bold(first)}`, ...rest.map((line) => `  ${c.bold(line)}`)].join('\n')
    const trailing = compact ? '\n' : '\n\n'
    write(toCRLF('\n' + body + trailing))
    return
  }
  // 卡片与主题无关，其内容也一样：固定的浅色箭头 + 文本（见 tokens.ts 里的
  // paintEchoArrow/paintEchoFg）——浅色主题下终端默认前景是深色，会在深色
  // 卡片上消失。
  const bgArrow = paintEchoArrow()(GLYPH_PROMPT_ARROW)
  const echoText = paintEchoFg()
  // 两个前缀都是 3 单元格宽（` › ` / 三个空格），所以折行的续行会对齐到第一行
  // 文本下方。
  const PREFIX_CELLS = 3
  // 卡片的背景带通过 bg span 内部发出的 `\x1b[K` 到达右边缘：在支持 BCE 的
  // 终端（xterm.js、WT、conhost）上，擦除会用卡片色填充。我们有意不用背景色
  // 空格填充——被填充的行可打印到旧终端宽度，所以终端之后变窄时，其滚动区
  // 重排会把每个填充行拆成内容 + 一行游离的背景色空行（每张卡片行一条幽灵
  // 行）。在不支持 BCE 的终端上，卡片就在文本之后结束。
  //
  // 我们仍然绝不让可打印单元格落到终端最后一列：一行恰好 `cols` 宽会进入延迟
  // 换行状态，conhost / Windows Terminal 在某些配置下会把它算作一次真正的换行，
  // 插入一条滚动区几何（countContentRows）不知道的幽灵行——实时帧随之漂移并
  // 撕裂成上方重复的输入框（render-diff.ts 为其 diff 行也预留了同样的 1 单元格
  // 边距）。
  const paintRow = (chunk: string, isFirst: boolean): string => {
    const visible = isFirst ? ` ${bgArrow} ${echoText(chunk)}` : `   ${echoText(chunk)}`
    return cols > 0 ? bg(visible + '\x1b[K') : bg(visible)
  }
  // 自己硬折行超宽的行，而不是交给终端的自动换行：在已知预算处拆分能保持
  // countContentRows 的滚动区记账精确——不依赖终端在我们以为的位置换行。含
  // 制表符的行完全跳过折行：charWidth 把 `\t` 算作 1 单元格，但终端会跳到
  // 下一个 8 列制表位，所以任何计算出的折点都是错的。
  const renderLine = (text: string, isFirst: boolean): string[] => {
    if (cols <= 0 || text.includes('\t')) return [paintRow(text, isFirst)]
    const budget = Math.max(1, cols - 1 - PREFIX_CELLS)
    if (visualWidth(text) <= budget) return [paintRow(text, isFirst)]
    const chunks: string[] = []
    let remaining = text
    while (visualWidth(remaining) > budget) {
      const head = sliceByWidth(remaining, budget)
      // budget >= 1 时非空输入不可能产生空 head；这个 break 纯粹是防止死循环
      // 的保险。
      if (head.length === 0) break
      chunks.push(head)
      remaining = remaining.slice(head.length)
    }
    chunks.push(remaining)
    return chunks.map((chunk, i) => paintRow(chunk, isFirst && i === 0))
  }
  // 全宽空白背景行作为垂直内边距。在 BCE 擦除前于 bg span 内保留一个可打印
  // 空格：终端在调整大小/重排时可能丢弃纯擦除行的背景属性，导致卡片上下内边距
  // 消失。一个单元格即可锚定该行，而不必恢复旧宽度的空格填充（及其幽灵换行）。
  // 终端宽度未知（管道输出）时跳过。
  const padRow = cols > 0 ? bg(' \x1b[K') : null
  const rows = lines.flatMap((line, i) => renderLine(line, i === 0))
  if (padRow !== null) rows.unshift(padRow)
  if (padRow !== null) rows.push(padRow)
  const body = rows.join('\n')
  // 前导 \n 提供一行空白的上边距，让回显不会挤到上一条 assistant 回复的最后
  // 一行内容。显式 CRLF 换行——理由见上面的 toCRLF()。
  const trailing = compact ? '\n' : '\n\n'
  write(toCRLF('\n' + body + trailing))
}
