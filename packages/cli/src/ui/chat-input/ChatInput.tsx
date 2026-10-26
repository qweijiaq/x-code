// @x-code-cli/cli — 底部动态区域（spinner + 输入框）以及新消息的滚动区提交路径。
//
// 渲染策略 — 单元格级 diff，直接写 stdout：
//   Ink 的 Yoga 布局和 log-update 都会算错 CJK/IME 宽度。即便是 @jrichman/ink
//   分支也没能完全消除 Windows ConHost 上的抖动，因为终端级 CJK 渲染不是原子的。为
//   了绕开这两个引擎，我们亲自渲染整个底部区域：
//
//     - 每帧 = 2D 单元格网格（字符 + 样式 + 视觉宽度）
//     - 与上一帧逐单元格 diff
//     - 在单次 process.stdout.write() 中写入全部变化
//     - 未变化的 CJK 单元格从不重新发出 → 无重绘抖动
//
//   我们向 Ink 返回 `null`，让 Ink 的动态区域为空；用户已经看到过的滚动区下方的一切
//   都由我们掌控。
//
// 本组件（而不是 Ink）负责的东西：
//     - 加载 spinner 行（`isLoading` 为 true 时）
//     - 顶/底分隔线
//     - 带光标的输入文本
//     - 斜杠命令补全菜单
//     - 帧内的 Permission 和 SelectOptions 对话框
//     - 把新到达的 `messages` 提交到帧上方的滚动区（经 writeMessageToStdout，收集进
//       与帧重绘相同的原子负载 — 见 flush effect）
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { debugLog, suggestRuleLabel } from '@x-code-cli/core'

import { isSlashCommandAllowedWhileBusy } from '../busy-command.js'
import { renderInlineMarkdown } from '../render/render-markdown.js'
import { highlightShellCommand } from '../render/shiki-highlight.js'
import {
  flushPendingReadGroup,
  lastWriteEndedWithBlankRow,
  resetScrollbackSpacing,
  writeMessageToStdout,
} from '../render/stdout-writer.js'
import {
  GLYPH_ELLIPSIS,
  GLYPH_PROMPT_ARROW,
  GLYPH_RESULT_BRACKET,
  GLYPH_SELECT_POINTER,
  GLYPH_TODO_BRACKET,
  GLYPH_TODO_CHECK,
  GLYPH_TODO_IN_PROGRESS,
  GLYPH_TODO_PENDING,
  GLYPH_TOOL_BULLET,
  SPINNER_FRAMES,
} from '../render/terminal-glyphs.js'
import {
  charWidth,
  graphemeAt,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  sliceByWidth,
  visualWidth,
} from '../render/text-width.js'
import {
  formatTokenCount,
  getToolInputPreview,
  getToolLabel,
  isCollapsibleReadOnlyTool,
  isShellToolName,
} from '../utils.js'
import { authorityViewerLines, authorityVisibleText } from './authority-display.js'
import { type Cell, ansiTextToCells, cellsEqual, renderRowToAnsi, textToCells } from './cells.js'
import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank, useFileCompletion } from './file-completion.js'
import { buildVisualLines, computePostContentScrollRows, locateVisualCursor, moveCursorVisual } from './geometry.js'
import { useInputHistory } from './input-history.js'
import {
  BSU,
  ESU_HIDE,
  S_BOLD,
  S_BORDER,
  S_CURSOR,
  S_DIM,
  S_ERROR,
  S_ERROR_BOLD,
  S_GRAY_90,
  S_MODEL,
  S_NONE,
  S_PRIMARY,
  S_PRIMARY_BOLD,
  S_RESET,
  S_SPINNER,
  S_SUCCESS,
  S_SUCCESS_DOT,
  S_SUCCESS_DOT_DIM,
  S_TEXT_STRONG,
  S_TEXT_STRONG_BOLD,
  S_USAGE,
  S_WARNING,
  S_WARNING_BOLD,
} from './palette.js'
import { type PastedContents, expandPasteRefs, formatPasteRef, stripTrailingRef } from './paste-refs.js'
import { formatElapsed, permissionContentCells, permissionTitle } from './permission.js'
import { inputReducer } from './reducer.js'
import {
  countContentRows,
  countSpillRiskRows,
  skipByWidth,
  truncateCellRow,
  truncatePathFromStart,
  wrapCellsToRows,
} from './text-helpers.js'
import type { ChatInputProps, MenuItem } from './types.js'
import { usePromptInput } from './use-prompt-input.js'

const PASTE_REF_MIN_LINES = 3
const PASTE_REF_MIN_CHARS = 400
const MAX_VISIBLE_LINES = 10
// 供 render effect（帧布局）和上/下光标移动共享，这样两者用同样的方式计算软折行视口宽度。
const PROMPT_WIDTH = 2
// 圆角提示框把每个输入行包在 `│ ` … ` │` 里，在 `termWidth - 1` 宽的框内，围绕
// prompt+content 一行消耗 4 个单元格。
const BOX_INNER_PAD = 4
const inputViewportWidth = (termWidth: number): number => Math.max(20, termWidth - PROMPT_WIDTH - BOX_INNER_PAD - 1)
const MAX_AT_RESULTS = 50
const MAX_VISIBLE_MENU_ITEMS = 8

export function ChatInput({
  messages,
  initialContentRows = 0,
  onSubmit,
  onInterrupt,
  onEscapeCancel,
  isLoading = false,
  notice,
  peerInfluenced = false,
  trustMode = false,
  pendingPeerCount = 0,
  disabled,
  hidden,
  spinner,
  activeTurnOwner = null,
  hasStableForkBoundary = false,
  activeToolCalls,
  shellWaitStreak,
  backgroundTerminalCount = 0,
  backgroundTerminalWarningCount = 0,
  todos,
  queuedMessages,
  onPopQueued,
  draftRestore,
  errorMessage,
  permission,
  authorityRequest,
  selectRequest,
  commands = [],
  permissionMode = 'default',
  contextUsage,
  modelLabel,
}: ChatInputProps) {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 })
  const textRef = useRef('')
  const cursorRef = useRef(0)
  // 双击 Esc 清空输入（仅空闲模式；加载模式用单击 Esc 取消进行中的回合）。记录上一次
  // 尚未清空的 Esc 时间戳；在 DOUBLE_ESC_WINDOW_MS 内的第二次按下会触发 RESET。
  const lastEscapeAtRef = useRef(0)
  useLayoutEffect(() => {
    textRef.current = text
    cursorRef.current = cursor
  }, [cursor, text])

  // 在光标处插入文本，并同步镜像到 textRef/cursorRef。否则这些 ref 只在 React 提交之后
  // 由 layout effect 刷新，所以一次提交窗口内的连续插入（在不支持括号粘贴的 Windows
  // 终端上，一次粘贴被拆成快速的 onPaste/onText 调用）都会读到过期的光标，并把后面的
  // 分块拼到位置 0 — 打乱顺序。
  const insertAtCursor = (chunk: string): void => {
    const pos = cursorRef.current
    dispatch({ type: 'INSERT', pos, chunk })
    textRef.current = textRef.current.slice(0, pos) + chunk + textRef.current.slice(pos)
    cursorRef.current = pos + chunk.length
  }
  const [pastedContents, setPastedContents] = useState<PastedContents>({})
  // 一次性草稿恢复（Esc 中止时带着未注入的排队消息）。用 `nonce` 作键，这样文本相同的
  // 连续恢复仍然生效；无关重渲染导致的身份变化不会重新触发。
  // 注：刻意不触碰历史导航 ref —— 在 effect 里捕获它们会因它们在其他地方（已存在的）
  // 变更而触发 react-hooks/immutability，而导航中途的恢复是一个无害的边界情况。
  const lastDraftNonceRef = useRef(0)
  useEffect(() => {
    if (!draftRestore || draftRestore.nonce === lastDraftNonceRef.current) return
    lastDraftNonceRef.current = draftRestore.nonce
    dispatch({ type: 'SET_TEXT', text: draftRestore.text, cursor: draftRestore.text.length })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same one-shot restore; clears paste refs alongside the text.
    setPastedContents({})
  }, [draftRestore])
  const [completionIndex, setCompletionIndex] = useState(0)
  const [atCompletionIndex, setAtCompletionIndex] = useState(0)
  // 跟踪用户经 Esc 关闭的触发键（atIdx + query）。当 atTrigger.atIdx + query 等于该值时
  // 菜单隐藏；一旦用户打字或退格，触发键自然变化，菜单重新打开 —— 无需显式的「清除」
  // 路径。
  const [atDismissed, setAtDismissed] = useState<string | null>(null)
  const { entries: fileEntries } = useFileCompletion()
  const nextPasteIdRef = useRef(1)
  const activeRef = useRef(false)
  const prevFrameRef = useRef<Cell[][]>([])
  /** 最近一次真正写入终端的 stdout.write 的时间戳（毫秒）。用于合并那些会在滚动区提交
   *  写入之后立即触发的 spinner-tick 写入 —— 见 flush 部分。 */
  const lastFlushTimeRef = useRef(0)
  /** 待处理的延迟（非提交）写入，可被提交取代。 */
  const deferredFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 由已触发的延迟定时器排队的 setImmediate。到那时定时器 ref 已经为 null，所以需要
   *  这个句柄在取代渲染和卸载期间取消最终回调。 */
  const deferredImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null)
  /** 待处理的节流提交。当一次提交在上一次写入后的 MIN_COMMIT_GAP_MS 内触发时设置 ——
   *  提交的负载会等待足够长的时间，让它落入一个全新的终端绘制周期，而不是与上一次写入
   *  处在同一个 vsync 内。与 `deferredFlushRef` 区分开，因为 defer 路径绝不能取消一个
   *  被节流的提交（取消会丢失该提交的 preBuf 所携带的新滚动区内容）。 */
  const commitThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 每次成功 `doFlush` 都会递增的单调计数器。延迟写入路径在调度时捕获它，在触发时再
   *  次检查：如果值变了，说明期间运行过一次提交路径的 flush，我们只含 spinner 的帧已
   *  过期（提交已经重绘了该单元格）。这堵住了单纯 `clearTimeout` 取消堵不住的竞态 ——
   *  当延迟定时器的宏任务已经排队，同时某次提交的 useEffect 也在同一 tick 里排了一个
   *  flush，两次写入会相隔 1-2ms 落到 stdout，用户就会看到可见的闪烁。 */
  const flushGenRef = useRef(0)
  /** flush effect 看到的上一个 `spinnerFrame` 值。我们拿它与当前帧比较，来区分「本次渲染
   *  由 spinner tick 触发」（spinner 字形轮转）与「本次渲染由打字 / 内容变化触发」
   *  （spinner 未变）。两种情况需要不同的延迟 flush 窗口：spinner tick 应延迟更久
   *  （~24ms）以便下一次文本流提交吸收它们；但打字必须短暂延迟（~8ms），否则按住键时
   *  会明显卡顿。 */
  const lastFlushedSpinnerFrameRef = useRef<number | null>(null)
  /** 当前位于终端底部的帧的高度（即 prevFrameRef 最近一次被设成的值）。单独跟踪，因为
   *  prevFrameRef 在过渡时（隐藏之后、帧高度变化）会被重置为 []，而我们仍需要知道屏幕
   *  上物理帧从哪里开始，好让下一个 DECSTBM 滚动区域不与它重叠。 */
  const lastFrameHRef = useRef(0)
  /** 最近已知的终端尺寸。在 render effect 里与当前值比较，以检测 resize 并计算旧帧原来
   *  的位置，从而在新位置绘制之前先把它擦掉。 */
  const lastTermRowsRef = useRef(0)
  const lastTermWidthRef = useRef(0)
  /** resize 到达时屏幕上帧每一行的可打印长度，在 onResize 里、prevFrameRef 被清空之前
   *  捕获。render effect 的宽度变化分支用它们来计算 xterm.js 重排后旧帧占用的精确终端
   *  行数（每条长度 L 的硬行变成 ceil(L/newW) 行），这样擦除能覆盖每一处重排残留 —— 旧
   *  的启发式只数了 2 个分隔行，漏掉了折行的输入 / spinner 行。 */
  const prevFrameRowLensRef = useRef<number[]>([])
  /** 最后一个屏幕内容行与终端底部之间的空白行数。概念上与原来的「帧上方空白」是同一个
   *  值 —— 变化的是我们选择在那个空区域里把帧画在哪里：
   *
   *    - 当它为 0 时，帧位于终端底部（原来始终锚定底部的行为）。
   *    - 当它 > 0 时，帧上浮，紧挨最后一个内容行下方，freeBlanks 变成输入框下方的空行。
   *      这模仿 Claude Code 的 flex 布局行为（Box flexGrow=1 的 spacer 在消息填满屏幕
   *      之前不会把内容推到最底），并避免了用户开新对话时看到的「工具块锚定在空终端底
   *      部」的空隙。
   *
   *  在渲染代码的其余部分，它仍跟踪「下一次提交可以在不滚动真实历史的情况下写入的空行
   *  预算」 —— 无论帧停在该空区域的哪个位置，那个算术都是相同的。 */
  const freeBlanksAboveFrameRef = useRef(0)
  /** 当前紧贴帧上方的空白行数，由一次大收缩（deltaH > 3）留下 —— 那次收缩把帧吸附到底
   *  部并擦除了旧帧区域，但没有把它提交进滚动区。没有这个计数器，随后的 grow 会在
   *  termRows 发 LF 来「腾地方」—— 把那些空行推入终端滚动区变成永久空行（表现为子代理
   *  连续打开多个权限对话框时 Task() 结果下方的大片空白）。
   *
   *  grow 路径在决定发多少 LF 之前消耗它：帧通过单元格网格重新定位向上延伸进这些空白
   *  （不滚动），所以只有空白区域之外的行才需要滚入历史。在提交（提交后的滚动区现在占
   *  据帧正上方的行）、resize 和 /clear 时重置。 */
  const blankRowsAboveFrameRef = useRef(0)
  /** 最近一次实际写入终端的 frameTop 行。单独存储，因为 frameTop 不再能仅由
   *  (termRows, frameH) 推导 —— 它现在还依赖 freeBlanksAboveFrameRef。卸载清理
   *  （buildEraseRegion）和 resize 处理器会读它，这样它们能在旧屏幕帧的真实位置把它擦
   *  掉，而不是从 termRows 去猜。 */
  const lastFrameTopRef = useRef(0)
  /** 当权限对话框刚关闭、但它批准的工具还没提交结果时，在工具运行帧内保留垂直空间。没
   *  有这个保留，帧会从 14 行跳到 5 行（权限是 11 行 + 3 行输入，工具行是 2），旧权限区
   *  域顶部现在空掉的行会作为最后一条已提交滚动区条目与运行中工具之间的空白行闪烁 ——
   *  有那么一瞬间用户看到 "Running..." 钉在底部、上方留着一片空隙，直到工具结束、它的
   *  提交回填那些行。保留让帧保持旧尺寸，这样进行中的工具行仍然画在权限标题原来所在的
   *  位置；空行移到工具下方（工具与输入之间），由下一次提交 / grow 干净地消耗。在任何
   *  提交（工具结果落到保留槽里）或新权限到来（该权限自己重新填满槽）时清除。 */
  const permissionSlotReserveRef = useRef(0)
  const prevHadPermissionRef = useRef(false)
  /** 上一次渲染时正在显示 Permission/SelectOptions 对话框则为 true。当它消失时，我们需
   *  要在重绘前擦除旧帧 —— Ink 的 log.clear 会把光标送回对话框开始的那一行，那正是我们
   *  帧的底部行，所以按 prevFrame 的常规 eraseRegion 能干净地工作。 */
  const wasHiddenRef = useRef(false)
  /** 由收缩检测路径（/clear 清空了 messages）设置，好让下一次首次绘制为空视口播种
   *  freeBlanks，而不是在顶部保留 banner 大小的空间 —— 清屏 ANSI 写入之后屏幕上已没有
   *  banner。消耗后清除。 */
  const justClearedRef = useRef(false)
  /** 我们已经提交到滚动区的消息数。 */
  const writtenMessageCountRef = useRef(0)
  /** 本次渲染收集的、尚未到达 stdout 的滚动区字节。跨渲染存活，这样被取消的提交节流不
   *  会丢掉消息字节 —— 遍历新消息时 `writtenMessageCountRef` 会同步递增，所以后续渲染
   *  不会再经 `writeMessageToStdout` 重新收集它们。没有这个 ref，携带字节的唯一路径就是
   *  调度了节流的那次渲染的局部 `scrollbackContent`；如果 1ms 后那次节流被高度变化取代
   *  （`commit-throttle-superseded-by-height`），字节就消失了。在写入真正落地时于
   *  `doFlush` 内清除。它治好的症状：流式多行回复在最后一次提交收缩帧时（回合结束移除
   *  spinner）悄悄丢掉最后一条消息 —— 表现为回复在滚动区里于段落中间戛然而止，尽管全文
   *  都在 `state.messages` 里。 */
  const pendingScrollbackRef = useRef('')
  // 权限对话框：选中索引（0 = Yes，1 = No）。在我们的单元格缓冲里渲染 —— 不经 Ink ——
  // 这样对话框永远不会与我们的光标管理打架。每当提示变化（新工具调用）就用 React 的
  // 「渲染期间调整状态」模式重置为 0 —— React 会丢掉第一次渲染并立即重新渲染，这比级联
  // 的 setState-inside-effect 更便宜，也不会触发 react-hooks/set-state-in-effect lint。
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [permissionSelected, setPermissionSelected] = useState(0)
  /** 当「No, and tell X-Code what to do instead」行处于内联编辑模式（kimi-cli 的
   *  reject-with-feedback）时为非 null：输入的文本落到这里而不是解析对话框。 */
  const [permissionFeedback, setPermissionFeedback] = useState<{ text: string; cursor: number } | null>(null)
  const [authoritySelected, setAuthoritySelected] = useState(1)
  const [authorityPage, setAuthorityPage] = useState(0)
  const [lastPermissionKey, setLastPermissionKey] = useState<string | null>(null)
  const permissionKey = permission ? `${permission.toolName}:${JSON.stringify(permission.input)}` : null
  if (permissionKey !== lastPermissionKey) {
    setLastPermissionKey(permissionKey)
    setPermissionSelected(0)
    setPermissionFeedback(null)
  }
  const [lastAuthorityKey, setLastAuthorityKey] = useState<string | null>(null)
  const authorityKey = authorityRequest
    ? `${authorityRequest.requestId}:${authorityRequest.preview.canonicalCallSha256}`
    : null
  if (authorityKey !== lastAuthorityKey) {
    setLastAuthorityKey(authorityKey)
    setAuthoritySelected(1)
    setAuthorityPage(0)
  }

  // 帧内 select-options 对话框的选中索引。每次新对话框打开时重置（以问题字符串为键，因
  // 为变化的就是它）。
  const [selectIndex, setSelectIndex] = useState(0)
  const [lastSelectKey, setLastSelectKey] = useState<string | null>(null)
  // 「Other」自由文本选项的内联文本缓冲。以 {text, cursor} 捕获，让反色光标与主输入用
  // 同样的方式渲染。在同一个对话框的选项之间导航时保留（这样用户重新进入「Other」不会
  // 丢失已输入的内容），但新对话框打开时清空。
  const [freeform, setFreeform] = useState<{ text: string; cursor: number }>({ text: '', cursor: 0 })
  const selectKey = selectRequest ? selectRequest.question : null
  if (selectKey !== lastSelectKey) {
    setLastSelectKey(selectKey)
    setSelectIndex(0)
    setFreeform({ text: '', cursor: 0 })
  }

  // Spinner 动画 —— 自包含，这样父组件不必每秒重渲染 12 次。只在 `spinner` 为真时运行。
  //
  // 我们只保留一份 React state（`spinnerFrame`），因为它的变化才触发重绘单元格帧的重渲
  // 染。`elapsedMs` 在渲染时从 `loadingStartRef` 推导，这样我们绝不会在 effect 里做同步
  // 的 setState（那会触发级联渲染 / react-hooks/set-state-in-effect lint）。
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const loadingStartRef = useRef<number>(0)

  useEffect(() => {
    if (!spinner) {
      loadingStartRef.current = 0
      return
    }
    if (loadingStartRef.current === 0) loadingStartRef.current = Date.now()
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 200) // 每帧 200ms（5 Hz）。低于 8 Hz 的星号脉冲呼吸仍读作流畅动画，但每次单元格
    // 写入比 120ms 时少了 38% 的频率 —— 在弱终端（VSCode xterm.js、ConHost）上可测量的
    // 残留闪烁更少，那些终端里每次 spinner-cell 更新都会踢一下渲染器的状态机。一个完整
    // 呼吸周期现在是 12 帧 × 200ms = 2.4s，感觉仍然鲜活又不抖。
    return () => clearInterval(timer)
  }, [spinner])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80
  const authorityViewerRows = useMemo(() => {
    if (!authorityRequest) return []
    return authorityViewerLines(authorityRequest.preview).flatMap((line) => {
      const style = line.kind === 'metadata' ? S_PRIMARY : S_DIM
      const cells = textToCells(line.text, style)
      const rows = wrapCellsToRows(cells, Math.max(20, termWidth - 4), Math.max(1, cells.length))
      return rows.length > 0 ? rows : [[]]
    })
  }, [authorityRequest, termWidth])
  const authorityPageCount = Math.max(1, Math.ceil(authorityViewerRows.length / 8))

  // ── 终端 resize 处理 ──
  // resize 时强制一次重渲染 tick，好让 termWidth/termRows 取到新值。单元格矩阵失效，但
  // lastFrameHRef / lastTermRowsRef 保持原样 —— render effect 需要它们来计算旧帧所在的
  // 位置，从而在新位置绘制之前擦掉那些行。
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => {
      // 在丢弃屏幕帧之前捕获它每一行的可打印长度（见 prevFrameRowLensRef）。一行的缓冲
      // 长度是它最后一个非空单元格之后的位置；宽（CJK）单元格计 2。如果 prevFrameRef 已
      // 经为空（一次渲染前发生了两次 resize），保留之前捕获的长度 —— 它们仍比空描述屏幕
      // 上的帧残留更准确。
      if (prevFrameRef.current.length > 0) {
        prevFrameRowLensRef.current = prevFrameRef.current.map((row) => {
          let len = 0
          for (let i = 0; i < row.length; i++) {
            const cell = row[i]
            if (cell && cell.char.trim() !== '') len = i + Math.max(1, cell.width)
          }
          return len
        })
      }
      prevFrameRef.current = []
      forceRender()
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // ── 光标可见性生命周期（Claude-Code 模式）。──
  // 终端光标在整个 TUI 生命周期内隐藏，卸载时重新显示。我们从不每次渲染切换 `?25h` /
  // `?25l`，因为在 Windows Terminal / VSCode-xterm.js / ConHost 上每次处理它都会重置光
  // 标闪烁相位，用户会在光标最后位置感知到闪烁。「输入光标」由下方 cell-diff 循环在输入
  // 行上渲染成一个反色单元格 —— 视觉上它只是一个与帧其余部分一起原子更新的样式字符。
  // 参考：D:\res\claude-code\src\ink\components\App.tsx:184
  // （componentDidMount 时 HIDE_CURSOR 写入）和 :189（componentWillUnmount 时
  // SHOW_CURSOR）。
  useEffect(() => {
    try {
      process.stdout.write('\x1b[?25l')
    } catch {
      /* tty 已关闭 */
    }
    return () => {
      try {
        process.stdout.write('\x1b[?25h')
      } catch {
        /* tty 已关闭 */
      }
    }
  }, [])

  // ── 模糊匹配 ──
  //
  // 两阶段菜单：阶段 1 补全斜杠命令名本身（`/mc` → `/mcp`）；阶段 2 在用户输入空格后触
  // 发，为声明了子命令的命令补全子命令（`/mcp ` → `list / tools / auth / ...`）。第三阶
  // 段（服务器名、模型 id）需要一个异步的逐命令 `complete()` 回调 —— 有意不实现；第二阶
  // 段以十分之一的代码解决了 80% 的痛点（8 个子命令的 `/mcp` 块）。
  //
  // 条目携带 `applyText`，这样接受路径（Tab / Enter）能把输入设为完整路径（`/mcp auth`），
  // 不管用户是从哪个阶段选的。展示列仍用裸的 `name`（阶段 2 显示 `auth`，而不是
  // `/mcp auth`），让菜单保持可扫读。
  const matches = useMemo<MenuItem[]>(() => {
    if (!text.startsWith('/')) return []

    const fuzzyMatches = (name: string, query: string): boolean => {
      let qi = 0
      for (let ni = 0; ni < name.length && qi < query.length; ni++) {
        if (name[ni] === query[qi]) qi++
      }
      return qi === query.length
    }

    const firstSpace = text.indexOf(' ')
    if (firstSpace === -1) {
      // 阶段 1：正在输入命令名。对去掉 / 的名字匹配。
      const query = text.slice(1).toLowerCase()
      const filtered = !query ? commands : commands.filter((c) => fuzzyMatches(c.name.slice(1).toLowerCase(), query))
      return filtered.map<MenuItem>((c) => ({
        name: c.name,
        description: c.description,
        applyText: c.name,
        argumentHint: c.argumentHint,
      }))
    }

    // 阶段 2：正在输入子命令。`head` 是命令（例如 "/mcp"），`tail` 是第一个空格之后的任
    // 何内容。第二个空格意味着用户已经越过子命令槽；我们不会越过它自动补全（还没有第三
    // 阶段回调）。
    const head = text.slice(0, firstSpace)
    const tail = text.slice(firstSpace + 1)
    if (tail.includes(' ')) return []

    const cmd = commands.find((c) => c.name === head)
    if (!cmd?.subcommands) return []

    const query = tail.toLowerCase()
    const filtered = !query ? cmd.subcommands : cmd.subcommands.filter((s) => fuzzyMatches(s.name.toLowerCase(), query))
    return filtered.map<MenuItem>((s) => ({
      name: s.name,
      description: s.description,
      applyText: `${head} ${s.name}`,
    }))
  }, [text, commands])

  const safeIndex = matches.length > 0 ? completionIndex % matches.length : 0
  const currentMatch = matches.length > 0 ? matches[safeIndex] : null

  // ── @-mention 文件补全 ──
  // detectAtToken 很便宜；每次渲染重算，这样它能跟踪光标移动（左/右箭头）而无需显式失效。
  const atTrigger = useMemo(() => detectAtToken(text, cursor), [text, cursor])
  const atMatches = useMemo(() => {
    if (!atTrigger.active) return [] as FileEntry[]
    return scoreAndRank(fileEntries as FileEntry[], atTrigger.query).slice(0, MAX_AT_RESULTS)
  }, [atTrigger, fileEntries])
  const safeAtIndex = atMatches.length > 0 ? atCompletionIndex % atMatches.length : 0
  const atDismissedKey = `${atTrigger.atIdx}:${atTrigger.query}`
  const atMenuVisible = atTrigger.active && atDismissed !== atDismissedKey
  // 当两者都可能触发时斜杠菜单胜出（`/` 只在行首触发，所以它们很少冲突 —— 只有粘贴时）。
  // 硬互斥防止双重渲染。
  const activeMenu: 'slash' | 'at' | null = matches.length > 0 ? 'slash' : atMenuVisible ? 'at' : null

  // 每当触发 token 变化就重置 @-menu 光标，这样高亮总是从新结果集的顶部条目开始。使用
  // React 文档的「把之前的 prop 存入 state + 渲染期间 setState」模式 —— 优于 useEffect，
  // 因为它避免了一次额外提交，也避免了 react-hooks/set-state-in-effect。
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const atTriggerKey = `${atTrigger.atIdx}:${atTrigger.query}:${atTrigger.active}`
  const [lastAtTriggerKey, setLastAtTriggerKey] = useState(atTriggerKey)
  if (lastAtTriggerKey !== atTriggerKey) {
    setLastAtTriggerKey(atTriggerKey)
    setAtCompletionIndex(0)
  }

  /** 在帧的钉住位置（终端最后 `lastFrameHRef` 行）擦除帧区域，并清空 prevFrameRef。返回
   *  ANSI 序列，让调用方能把它与其他写入合并成一次 process.stdout.write。光标停在（现在
   *  已空白的）帧区域左上角。
   *
   *  现在仅用于卸载清理 —— 实时渲染路径把帧钉在底部，并用 DECSTBM 滚动区域在其上方插入
   *  滚动区（见下方 flush effect），所以只有在 TUI 本身拆除时才需要擦除。 */
  const buildEraseRegion = (): string => {
    const prevH = lastFrameHRef.current
    const prevTop = lastFrameTopRef.current
    prevFrameRef.current = []
    lastFrameHRef.current = 0
    lastFrameTopRef.current = 0
    if (prevH <= 0) return ''
    const termRows = stdout?.rows ?? 25
    // 使用实际最后渲染的顶部；在 lastFrameTopRef 尚未被填充的遗留路径上回退到底部锚定公
    // 式（这只会在非常早的拆除时发生）。
    const frameTop = prevTop > 0 ? prevTop : Math.max(1, termRows - prevH + 1)
    // 跳到帧顶，擦除到显示末尾。一次原子擦除。
    return `\x1b[${frameTop};1H\x1b[J`
  }

  /** 卸载清理使用的同步擦除。包在 BSU/ESU 里，让终端原子地渲染这次擦除。effect 路径做
   *  自己的组装（已经被外层渲染包上 BSU/ESU）。 */
  const eraseRegion = () => {
    const s = buildEraseRegion()
    if (s) process.stdout.write(BSU + s + ESU_HIDE)
  }

  const handleSubmit = (override?: string) => {
    const raw = override ?? text
    if (!raw.trim()) return
    // 当 agent 仍在思考时，斜杠命令保持阻塞 —— 在回合中途运行 /compact 或 /resume 会破坏
    // 共享状态。`/goal` 控制运行中的目标；`/fork` 只允许提交路径捕获了稳定请求前前缀的
    // owner 使用。纯文本仍然流向正常的 steering 队列。
    if (spinner) {
      const command = raw.trimStart().toLowerCase().split(/\s+/, 1)[0]
      if (
        command.startsWith('/') &&
        (!activeTurnOwner || !isSlashCommandAllowedWhileBusy(raw, activeTurnOwner, hasStableForkBoundary))
      )
        return
    }
    const expanded = override ? raw : expandPasteRefs(raw, pastedContents)
    // 把展开前的形式记入输入历史（上/下回忆），这样恢复一个条目时不会把整块粘贴又展开回
    // 输入框 —— `[#N +M lines]` 引用保持紧凑，就像提交时一样。`override` 是斜杠补全路径
    // （`handleSubmit('/help')` 等），那里没有粘贴引用。
    pushHistory(override ? raw : text, override ? {} : pastedContents)
    resetHistoryNav()
    // 让正常的 render useEffect 处理这次过渡。下一次渲染会看到
    // `messages.length > writtenMessageCountRef`（用户回显刚在 onSubmit 里被追加），并发出
    // 一个 BSU/ESU 包裹的原子负载：间隙清除 + 滚动区内容 + 帧重绘。这里没有同步预擦除 ——
    // 它过去存在是为了给现已退役的独立 MessageList 写入器腾地方，并且是每次提交时的第二
    // 次非原子闪烁。
    onSubmit(expanded)
    dispatch({ type: 'RESET' })
    setPastedContents({})
    setCompletionIndex(0)
  }

  /** 让光标上下移动 `delta` 个视觉行（软折行感知，所以一条跨终端行折行的长逻辑行也能逐
   *  行导航）。如果光标确实移动了返回 `true`，如果它已经在顶部/底部视觉边缘则返回
   *  `false` —— 正是这个 falsy 返回值让上/下处理器落到历史导航路径（与 Claude Code 的
   *  `upOrHistoryUp` 用的同一技巧）。 */
  const moveCursorVertically = (delta: number): boolean => {
    // 在按键时从实时终端宽度计算 —— resize 会重新折行输入，导航必须使用新的几何。
    const vpWidth = inputViewportWidth(termWidth)
    const newPos = moveCursorVisual(text, cursorRef.current, delta, vpWidth)
    if (newPos === null) return false
    dispatch({ type: 'SET_CURSOR', cursor: newPos })
    return true
  }

  const { isNavigatingHistory, navigateHistoryDown, navigateHistoryUp, pushHistory, resetHistoryNav } = useInputHistory(
    {
      text,
      cursorRef,
      pastedContents,
      dispatch,
      setPastedContents,
      setCompletionIndex,
      setAtCompletionIndex,
    },
  )

  const clearInput = () => {
    dispatch({ type: 'RESET' })
    textRef.current = ''
    cursorRef.current = 0
    setPastedContents({})
    setCompletionIndex(0)
    setAtCompletionIndex(0)
    resetHistoryNav()
    lastEscapeAtRef.current = 0
  }

  usePromptInput({
    enabled: !disabled && !hidden,
    onInterrupt,
    onText: (chunk) => {
      const dialogSlashDraft = textRef.current.trimStart().startsWith('/') || chunk.trimStart().startsWith('/')
      if (authorityRequest) return
      // 当对话框活跃时，把单字符 y/n 路由到 Permission 解析器。斜杠命令保持可编辑，这样
      // 即便工具审批还在等待，`/goal pause` / `/goal cancel` 也能打断目标。
      if (permission) {
        // 反馈编辑模式把所有输入文本吞进内联缓冲（kimi-cli 的 Reject-with-feedback 行）。
        if (permissionFeedback) {
          setPermissionFeedback((prev) =>
            prev
              ? {
                  text: prev.text.slice(0, prev.cursor) + chunk + prev.text.slice(prev.cursor),
                  cursor: prev.cursor + chunk.length,
                }
              : prev,
          )
          return
        }
        const ch = chunk.toLowerCase()
        if (!dialogSlashDraft) {
          // Codex/kimi 风格的单键快捷键：y/n 始终有效，'a' 在提供 always 规则时批准它，
          // 'f' 打开带反馈拒绝编辑器，数字直接选中对应编号的选项。
          const hasAlways = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
          const actions: ('yes' | 'always' | 'no' | 'feedback')[] = hasAlways
            ? ['yes', 'always', 'no', 'feedback']
            : ['yes', 'no', 'feedback']
          if (ch === 'y') {
            permission.onResolve('yes')
            return
          }
          if (ch === 'n') {
            permission.onResolve('no')
            return
          }
          if (ch === 'a' && hasAlways) {
            permission.onResolve('always')
            return
          }
          if (ch === 'f') {
            setPermissionSelected(actions.length - 1)
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          if (/^[1-9]$/.test(ch)) {
            const action = actions[Number(ch) - 1]
            if (action === 'feedback') {
              setPermissionSelected(actions.length - 1)
              setPermissionFeedback({ text: '', cursor: 0 })
              return
            }
            if (action) {
              permission.onResolve(action)
              return
            }
          }
        }
        if (dialogSlashDraft) {
          insertAtCursor(chunk)
          setCompletionIndex(0)
        }
        return
      }
      if (selectRequest) {
        if (dialogSlashDraft) {
          insertAtCursor(chunk)
          setCompletionIndex(0)
          return
        }
        // 在 freeform 选项（"Other"）上打字会喂给内联文本缓冲；在常规选项上仍被吞掉，这样
        // 用户无法打进对话框背后隐藏的输入。
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + chunk + text.slice(cursor),
            cursor: cursor + chunk.length,
          }))
        }
        return
      }
      insertAtCursor(chunk)
      setCompletionIndex(0)
    },
    onPaste: (content) => {
      const dialogSlashPaste = content.trimStart().startsWith('/')
      if (authorityRequest) return
      if (permission) {
        if (permissionFeedback) {
          setPermissionFeedback((prev) =>
            prev
              ? {
                  text: prev.text.slice(0, prev.cursor) + content + prev.text.slice(prev.cursor),
                  cursor: prev.cursor + content.length,
                }
              : prev,
          )
          return
        }
        if (dialogSlashPaste) {
          insertAtCursor(content)
          setCompletionIndex(0)
        }
        return
      }
      if (selectRequest) {
        if (dialogSlashPaste) {
          insertAtCursor(content)
          setCompletionIndex(0)
          return
        }
        // 允许粘贴进 freeform 缓冲（例如粘贴一个长路径或模型 id）。跳过大型粘贴引用机制
        // —— 对自由文本答案来说那是可用性负担，它们本来就该很短。
        const opt = selectRequest.options[selectIndex]
        if (opt?.freeform) {
          setFreeform(({ text, cursor }) => ({
            text: text.slice(0, cursor) + content + text.slice(cursor),
            cursor: cursor + content.length,
          }))
        }
        return
      }
      const lineCount = content.split(/\r\n|\r|\n/).length
      const isLarge = lineCount >= PASTE_REF_MIN_LINES || content.length >= PASTE_REF_MIN_CHARS
      if (isLarge) {
        const id = nextPasteIdRef.current++
        setPastedContents((prev) => ({ ...prev, [id]: { id, content, lineCount } }))
        insertAtCursor(formatPasteRef(id, lineCount))
      } else {
        insertAtCursor(content)
      }
      setCompletionIndex(0)
    },
    onKey: (key) => {
      const dialogSlashMode = textRef.current.trimStart().startsWith('/')
      if (authorityRequest) {
        if (key === 'escape') {
          authorityRequest.onResolve(false)
          return
        }
        if (key === 'right' || key === 'pagedown') {
          setAuthorityPage((page) => Math.min(authorityPageCount - 1, page + 1))
          return
        }
        if (key === 'left' || key === 'pageup') {
          setAuthorityPage((page) => Math.max(0, page - 1))
          return
        }
        if (key === 'up' || key === 'down') {
          setAuthoritySelected((selected) => (selected === 0 ? 1 : 0))
          return
        }
        if (key === 'return') {
          authorityRequest.onResolve(authoritySelected === 0)
          return
        }
        return
      }
      // 权限对话框捕获导航 + 提交键。
      if (permission && !dialogSlashMode) {
        const hasAlwaysOption = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp) !== null
        const maxIdx = hasAlwaysOption ? 3 : 2
        // 内联反馈编辑（与 selectRequest 的 freeform 行同一套键）。Esc 回到选项导航而不
        // 解析；Enter 仅在非空时提交拒绝，这样一次误按键不会发送空说明。
        if (permissionFeedback) {
          if (key === 'escape') {
            setPermissionFeedback(null)
            return
          }
          if (key === 'return') {
            const trimmed = permissionFeedback.text.trim()
            if (!trimmed) return
            permission.onResolve({ kind: 'deny', feedback: trimmed })
            return
          }
          if (key === 'up' || key === 'down') {
            setPermissionFeedback(null)
            setPermissionSelected((p) => (key === 'up' ? (p > 0 ? p - 1 : maxIdx) : p < maxIdx ? p + 1 : 0))
            return
          }
          if (key === 'backspace') {
            setPermissionFeedback((prev) =>
              !prev || prev.cursor === 0
                ? prev
                : { text: prev.text.slice(0, prev.cursor - 1) + prev.text.slice(prev.cursor), cursor: prev.cursor - 1 },
            )
            return
          }
          if (key === 'delete') {
            setPermissionFeedback((prev) =>
              !prev || prev.cursor >= prev.text.length
                ? prev
                : { text: prev.text.slice(0, prev.cursor) + prev.text.slice(prev.cursor + 1), cursor: prev.cursor },
            )
            return
          }
          if (key === 'left') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: Math.max(0, prev.cursor - 1) } : prev))
            return
          }
          if (key === 'right') {
            setPermissionFeedback((prev) =>
              prev ? { text: prev.text, cursor: Math.min(prev.text.length, prev.cursor + 1) } : prev,
            )
            return
          }
          if (key === 'home') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: 0 } : prev))
            return
          }
          if (key === 'end') {
            setPermissionFeedback((prev) => (prev ? { text: prev.text, cursor: prev.text.length } : prev))
            return
          }
          if (key === 'clear') {
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          return
        }
        if (key === 'up') {
          setPermissionSelected((p) => (p > 0 ? p - 1 : maxIdx))
          return
        }
        if (key === 'down') {
          setPermissionSelected((p) => (p < maxIdx ? p + 1 : 0))
          return
        }
        if (key === 'return') {
          const decisions: ('yes' | 'always' | 'no' | 'feedback')[] = hasAlwaysOption
            ? ['yes', 'always', 'no', 'feedback']
            : ['yes', 'no', 'feedback']
          const picked = decisions[permissionSelected]!
          if (picked === 'feedback') {
            setPermissionFeedback({ text: '', cursor: 0 })
            return
          }
          permission.onResolve(picked)
          return
        }
        // Esc 表示拒绝，与 codex-cli 的审批覆盖层一致（以及宣传它的提示脚注）。
        if (key === 'escape') {
          permission.onResolve('no')
          return
        }
        return
      }
      // Select-options 对话框捕获导航 + 提交键。当高亮选项是 `freeform` 时，编辑键
      // （backspace、delete、left、right、home、end）也会喂给它的内联文本缓冲，而不是被
      // 吞掉。
      if (selectRequest && !dialogSlashMode) {
        const len = selectRequest.options.length
        const opt = selectRequest.options[selectIndex]
        const isFreeform = !!opt?.freeform
        // Esc 关闭用户发起的选择器（像 /theme、/model 这样的斜杠命令）—— 用户可能只是在
        // 浏览，不应被迫提交。AI 发起的对话框让 `dismissible` 为假，这样 Esc 被吞掉；否则
        // 模型会从它的 askUser 调用拿到一个静默的空答案。
        if (key === 'escape' && selectRequest.dismissible) {
          debugLog('chatinput.select-dismiss', 'esc')
          selectRequest.onResolve('')
          return
        }
        if (key === 'up') {
          setSelectIndex((i) => (i > 0 ? i - 1 : len - 1))
          return
        }
        if (key === 'down') {
          setSelectIndex((i) => (i < len - 1 ? i + 1 : 0))
          return
        }
        if (isFreeform) {
          if (key === 'backspace') {
            setFreeform(({ text, cursor }) =>
              cursor === 0
                ? { text, cursor }
                : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 },
            )
            return
          }
          if (key === 'delete') {
            setFreeform(({ text, cursor }) =>
              cursor >= text.length
                ? { text, cursor }
                : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor },
            )
            return
          }
          if (key === 'left') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.max(0, cursor - 1) }))
            return
          }
          if (key === 'right') {
            setFreeform(({ text, cursor }) => ({ text, cursor: Math.min(text.length, cursor + 1) }))
            return
          }
          if (key === 'home') {
            setFreeform(({ text }) => ({ text, cursor: 0 }))
            return
          }
          if (key === 'end') {
            setFreeform(({ text }) => ({ text, cursor: text.length }))
            return
          }
          if (key === 'clear') {
            setFreeform({ text: '', cursor: 0 })
            return
          }
        }
        if (key === 'return') {
          const picked = selectRequest.options[selectIndex]
          if (!picked) return
          if (picked.freeform) {
            const trimmed = freeform.text.trim()
            // Enter 时缓冲为空：忽略，这样用户不会被一个空答案踢出对话框。可见光标 + 对话
            // 框提示已经表明这里需要打字。
            if (!trimmed) return
            selectRequest.onResolve(trimmed)
          } else {
            selectRequest.onResolve(picked.label)
          }
          return
        }
        return
      }
      if (key === 'return') {
        // @-补全：Enter 选中高亮的文件但【不】提交 —— 用户还在提示词中途，路径落下后多半
        // 还想继续打字。当菜单为空时落到斜杠/提交（「@xxx 无匹配」的情况原样发送文本，这
        // 样用户无需额外按键去关闭就能提到一个 npm 包或不存在的文件）。
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
            return
          }
        }
        // 活跃的斜杠命令补全：Enter 直接选中高亮的命令，而不是提交输入框里的任何内容（通
        // 常只有 `/` 或一个前缀），与 Claude Code 的行为一致。以前用户得先按 Tab 把选择实
        // 体化，再按 Enter —— 冗余。`applyText` 携带完整路径，所以选中一个阶段 2 子命令会
        // 提交 `/mcp auth`，而不是裸的 `auth`。
        if (currentMatch) {
          handleSubmit(currentMatch.applyText)
          return
        }
        // 反斜杠续行：光标紧前的 `\` + Enter 转为字面换行而不是提交。这是无法区分
        // Ctrl+Enter 与 Enter 的终端的通用回退（多数终端都这样 —— 见 use-prompt-input.ts）。
        const cur = cursorRef.current
        if (cur > 0 && text[cur - 1] === '\\') {
          const next = text.slice(0, cur - 1) + '\n' + text.slice(cur)
          dispatch({ type: 'SET_TEXT', text: next, cursor: cur })
          setCompletionIndex(0)
          return
        }
        handleSubmit()
        return
      }
      if (key === 'newline') {
        // Alt/Option+Enter（或 modifyOtherKeys / kitty 的 Ctrl+Enter）—— 在光标处插入字面
        // 换行而不提交。有意绕过 @-menu 和斜杠补全的拦截：用户明确要求换行。
        insertAtCursor('\n')
        setCompletionIndex(0)
        return
      }
      if (key === 'clear') {
        clearInput()
        return
      }
      if (key === 'escape') {
        // @-menu 打开：Esc 只是为当前触发键关闭菜单。一旦用户打字/退格，触发键变化，菜单
        // 自动重新打开，所以没有显式的「重新武装」路径。
        if (activeMenu === 'at') {
          setAtDismissed(atDismissedKey)
          return
        }
        // 模态对话框（permission / selectRequest）在上方拦截，已经吞掉 Esc。这里我们只看
        // 到到达输入的 Esc。两种不同的手势：
        //   - loading：单击 Esc 取消进行中的回合。
        //   - idle：双击 Esc 清空输入 + 粘贴引用（与 Claude Code 一致）。单击 Esc 是空操
        //     作，这样一次误按不会抹掉草稿。
        if (isLoading && onEscapeCancel) {
          onEscapeCancel()
          return
        }
        if (text.length === 0 && Object.keys(pastedContents).length === 0) return
        const now = Date.now()
        const DOUBLE_ESC_WINDOW_MS = 500
        if (now - lastEscapeAtRef.current <= DOUBLE_ESC_WINDOW_MS) {
          clearInput()
        } else {
          lastEscapeAtRef.current = now
        }
        return
      }
      if (key === 'backspace') {
        const pos = cursorRef.current
        if (pos === 0) return
        const before = text.slice(0, pos)
        const stripped = stripTrailingRef(before)
        if (stripped) {
          setPastedContents((pc) => {
            const n = { ...pc }
            delete n[stripped.id]
            return n
          })
          const deleteCount = before.length - stripped.without.length
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount })
        } else {
          dispatch({ type: 'BACKSPACE_REF', pos, deleteCount: pos - previousGraphemeBoundary(text, pos) })
        }
        setCompletionIndex(0)
        return
      }
      if (key === 'delete') {
        const pos = cursorRef.current
        const end = nextGraphemeBoundary(text, pos)
        dispatch({ type: 'SET_TEXT', text: text.slice(0, pos) + text.slice(end), cursor: pos })
        return
      }
      if (key === 'left') {
        dispatch({ type: 'SET_CURSOR', cursor: previousGraphemeBoundary(text, cursorRef.current) })
        return
      }
      if (key === 'right') {
        dispatch({ type: 'SET_CURSOR', cursor: nextGraphemeBoundary(text, cursorRef.current) })
        return
      }
      if (key === 'home') {
        dispatch({ type: 'SET_CURSOR', cursor: 0 })
        return
      }
      if (key === 'end') {
        dispatch({ type: 'SET_CURSOR', cursor: text.length })
        return
      }
      if (key === 'tab') {
        if (activeMenu === 'at' && atMatches.length > 0) {
          const picked = atMatches[safeAtIndex]
          if (picked) {
            const out = applyCompletion(text, atTrigger.atIdx, atTrigger.tokenEnd, picked)
            dispatch({ type: 'SET_TEXT', text: out.text, cursor: out.cursor })
            setAtCompletionIndex(0)
          }
          return
        }
        if (currentMatch) {
          dispatch({ type: 'SET_TEXT', text: currentMatch.applyText, cursor: currentMatch.applyText.length })
          setCompletionIndex(0)
        }
        return
      }
      if (key === 'up') {
        // 当有真实选择可做时，建议菜单胜过历史导航。例外是历史导航中单匹配的情况：恢复的
        // `/model` 条目会自动打开一个单条目的斜杠菜单，在那里循环是空操作 —— 如果我们让菜
        // 单吞掉 Up，用户就被困住，无法继续往回滚。有 2+ 匹配时菜单的循环才有意义，所以即
        // 便在历史中途它也胜出；0/1 匹配时我们落到光标 + 历史导航。
        const inHistoryNav = isNavigatingHistory()
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p - 1 + atMatches.length) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p - 1 + matches.length) % matches.length)
          return
        }
        // 光标优先；仅当光标已经在逻辑第一行时才落到历史导航（这样多行草稿和回忆的条目仍
        // 能逐行编辑）。
        if (!moveCursorVertically(-1)) {
          // 空输入上，回合中途的队列弹出胜过历史回忆：用户多半想编辑刚排队的内容
          // （LIFO —— 相当于 Codex 的 Alt+Up）。
          const tail = text.length === 0 && queuedMessages?.length ? queuedMessages[queuedMessages.length - 1] : null
          if (tail) {
            dispatch({ type: 'SET_TEXT', text: tail.text, cursor: tail.text.length })
            onPopQueued?.(tail.id)
          } else {
            navigateHistoryUp()
          }
        }
        return
      }
      if (key === 'down') {
        const inHistoryNav = isNavigatingHistory()
        if (activeMenu === 'at' && atMatches.length > 0 && (!inHistoryNav || atMatches.length > 1)) {
          setAtCompletionIndex((p) => (p + 1) % atMatches.length)
          return
        }
        if (activeMenu === 'slash' && matches.length > 0 && (!inHistoryNav || matches.length > 1)) {
          setCompletionIndex((p) => (p + 1) % matches.length)
          return
        }
        if (!moveCursorVertically(1)) navigateHistoryDown()
        return
      }
      if (key === 'pageup') {
        moveCursorVertically(-MAX_VISIBLE_LINES)
        return
      }
      if (key === 'pagedown') {
        moveCursorVertically(MAX_VISIBLE_LINES)
        return
      }
    },
  })

  // ── 带单元格级 diff 的帧渲染 ─────────────────────────────

  useEffect(() => {
    if (hidden) {
      // 保持 prevFrameRef 原样。Ink 已经把对话框写在我们的帧底行之上（它的 onRender 在
      // useEffect 之前运行），并把光标移到它之外 —— 我们现在无法在不破坏对话框的情况下安
      // 全擦除任何东西。但当对话框解析时，Ink 的 log.clear 会把光标送回对话框开始的那一行
      // （= 我们帧的底行），到那时我们把下一次渲染当作全新的首次绘制。
      wasHiddenRef.current = true
      return
    }

    // 把本次渲染的所有写入累积成单个字符串，在底部经一次 process.stdout.write flush。理由：
    // DEC 2026 Synchronized Update Mode（BSU/ESU）只在支持它的终端上缓冲写入之间的状态 ——
    // VS Code 终端和其他终端会立即绘制每一次独立的 write()。合并成一次写入，让每次渲染无
    // 论终端支持与否都是单次原子绘制。
    let preBuf = BSU

    if (wasHiddenRef.current) {
      // 正从对话框过渡出来。我们过去用 RESTORE_CURSOR (\x1b8) 回到之前 DECSC 保存的位置
      // —— 但那个终端级单槽保存寄存器也被 Ink 自己的 log-update 循环内部用于它的光标簿
      // 记。两个写入者，一个寄存器：每次 Ink 渲染经过它的保存/恢复都会覆盖我们的，所以这
      // 里的恢复可能落到 Ink 保存的位置，而不是我们帧的底行。
      //
      // 与其争抢寄存器，不如把对话框之后的帧当作全新的首次绘制：丢掉 prevFrameRef（这样
      // diff 循环用 \x1b[K 做整行写入，没有过期假设），下方的绝对定位把帧放回终端底部行，
      // 不管 Ink 把光标停在哪里。
      wasHiddenRef.current = false
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      activeRef.current = false
    }

    // ── 提交新的滚动区消息 ───────────────────────────────────
    //
    // 这里只收集。真正的写入发生在帧单元格构建之后，这样我们能以一条连续流发出
    // `content + frame`，触发终端在其底边自然的全屏滚动 —— 这是 xterm.js / VSCode 唯一
    // 认可的把行推进真实滚动区的机制（DECSTBM 限定的区域滚动在 xterm.js 的 InputHandler
    // 里被拼接丢弃，已在源码确认）。
    //
    // /clear 把消息列表缩回空。在重绘空视口之前把当前视口推进真实终端滚动区。这里不能
    // 用 CSI 3J：与 shell `clear` 不同，它会破坏用户期望向上滚动能到达的历史。
    //
    // `didClearScreen` 强制走下方的立即 flush 路径：这里构建的擦除 + 滚动字节是一次性的
    // （该分支只在消息再次收缩时才重新运行），所以可取消的 deferred/throttle 路径绝不能携
    // 带它们 —— 一个被取代的 clear 负载会永远丢失这些字节，而 justClearedRef 仍把新帧锚
    // 定在第 1 行，让旧对话在其下方仍然可见。
    let didClearScreen = false
    if (messages.length < writtenMessageCountRef.current) {
      didClearScreen = true
      const retainedClearEcho =
        messages.length === 1 && messages[0]?.kind === 'command-echo' && messages[0].content.trim() === '/clear'
      const clearRows = stdout?.rows ?? 25
      const oldFrameTop = Math.max(1, lastFrameTopRef.current || clearRows - lastFrameHRef.current + 1)
      for (let row = oldFrameTop; row <= clearRows; row++) preBuf += `\x1b[${row};1H\x1b[K`
      preBuf += `\x1b[${clearRows};1H${'\n'.repeat(clearRows)}\x1b[H`
      // 保留的 /clear 回显在这里【不】写入旧视口。让 writtenMessageCountRef 保持 0，下方
      // 正常的消息循环 + 提交路径会把它作为全新视口的第一条内容渲染 —— 与其他命令回显得
      // 到同样的带 padding 卡片。（把它写在旧视口底部会推进滚动区，完全隐藏它，并在那些
      // 进入历史时裁掉纯背景行的终端上丢掉它的背景 padding 行。）
      writtenMessageCountRef.current = retainedClearEcho ? 0 : messages.length
      prevFrameRef.current = []
      lastFrameHRef.current = 0
      lastFrameTopRef.current = 0
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      // clear 抹掉了我们正要写入的滚动区。之前被取消的节流留下的任何待处理字节现在都过期
      // 了 —— 它们属于已不存在的消息（/clear 之后，messages.length 是 0）。
      pendingScrollbackRef.current = ''
      activeRef.current = false
      justClearedRef.current = true
      // 丢弃滚动区间距标志 + 缓冲的 read-group 条目（那些摘要指向我们刚抹掉的消息 —— 稍
      // 后再 flush 它们会在空历史上方留下幽灵行）。
      resetScrollbackSpacing()
    }
    const termRows = stdout?.rows ?? 25
    // `hasNewMessages` —— 本次渲染遍历了新条目（推进了 `writtenMessageCountRef`）。即使每
    // 条消息都被 read-group 折叠器缓冲、产生了零滚动区字节，它也为 true。被消息写入循环
    // 和权限槽簿记使用。
    //
    // `didCommitMessages` —— 确实产生了滚动区字节。只有它才门控下方的几何/滚动分支：
    // `countContentRows` 对空字符串返回 1（一条空行），所以把一个仅缓冲的渲染当作滚动 1
    // 行会在每个连续的 Read/Glob/Grep 工具上把帧向下漂移，在终端滚动区累积真实的空行
    // （多 read 链上的「大量空行」症状）。
    const hasNewMessages = messages.length > writtenMessageCountRef.current
    const collectWrite: (data: string) => void = (data) => {
      pendingScrollbackRef.current += data
    }
    if (hasNewMessages) {
      for (let i = writtenMessageCountRef.current; i < messages.length; i++) {
        writeMessageToStdout(collectWrite, messages[i])
      }
      writtenMessageCountRef.current = messages.length
    }
    // 回合结束安全网：writeMessageToStdout 缓冲连续的只读工具消息（Read / Glob / Grep /
    // ListDir），并在下一条不可折叠消息到达时内联 flush 它们。如果链条结束却没有那条收尾
    // 消息 —— 用户在链条中途按了 Esc、模型返回 `finishReason='stop'` 却没有文本，等等 ——
    // 缓冲本会一直坐着直到用户再次提交。在 isLoading 降到 false 时 flush，把尾部摘要提交
    // 到同一次渲染的原子写入里。
    if (!isLoading) {
      flushPendingReadGroup(collectWrite)
    }
    // 把跨渲染的 ref 快照进一个局部变量。几何路径多次读取 `scrollbackContent`，快照让一次
    // 渲染的视图保持一致。字节保留在 ref 里，直到 doFlush 确认它们到达 stdout —— 见
    // pendingScrollbackRef 的文档。
    const scrollbackContent = pendingScrollbackRef.current
    const didCommitMessages = scrollbackContent.length > 0

    // 在翻转 activeRef 之前捕获「这是首次活跃绘制吗？」。下方播种 freeBlanks 的检查需要知
    // 道这一点，但播种处旧的 `!activeRef.current` 守卫在运行时总是 false（我们就在下方设
    // 置 activeRef=true），所以 banner 在帧上方的空行额度从未被播种 —— 第一次提交会预滚动
    // 穿过 banner 行，而不是消耗 banner 与帧之间不属于任何人的空白。症状：以初始提示启动
    // （`xc "hi"`）会裁掉 logo 的上半部分。
    const isFirstPaint = !activeRef.current
    activeRef.current = true

    // 权限槽保留只在权限关闭后的第一次提交之前保持活跃（那次提交携带批准工具的结果并覆
    // 盖保留的行）。新的权限也会清除保留 —— 新对话框直接拥有该槽。
    //
    // 只在有 1 到 3 个工具待处理时保留。带框的权限对话框是 11 行（顶边 + 标题 + 空行 + 内
    // 容 +
    // 空行 + Yes + Always + No + feedback + 空行 + 提示 + 底边）
    // + 3 行输入 = 14；一个运行中的工具占 2 行，所以需要 9 个空行来维持那个高度，两个工
    // 具占 4 行需要 7，三个占 6 行需要 5。四个或更多工具让帧比对话框【更大】，那是一次
    // grow（由现有的 freeBlanks/preScroll 路径正确处理）；零个工具意味着批准的工具被拒绝
    // 或还没产生 onToolCall —— 在那里保留空行只是把空隙挪来挪去，而不是消除它。
    //
    // 11 行的数字是【常见】情况：suggestRuleLabel 只为 enterPlanMode 返回 null（批准时不
    // 运行任何工具），所以 Always 行实际上总是存在。罕见的 9 行对话框（未知工具且无内容
    // 行）会多保留两行 —— 短暂的空行，比保留不足的收缩留下的过期残留更便宜。
    const hadPermissionLastRender = prevHadPermissionRef.current
    const runningToolCount = activeToolCalls?.length ?? 0
    if (hasNewMessages || permission) {
      permissionSlotReserveRef.current = 0
    } else if (hadPermissionLastRender && !permission && runningToolCount >= 1 && runningToolCount <= 3) {
      permissionSlotReserveRef.current = 11 - runningToolCount * 2
    }
    prevHadPermissionRef.current = !!permission

    const vpWidth = inputViewportWidth(termWidth)
    // 圆角提示框（Crush 风格）：`╭╮╰╯` 四角，`─` 顶/底边，`│` 侧边。所有制表字符都落在
    // CP437 安全的 U+2500–U+257F 范围内，所以旧式 ConHost 无需字形回退。
    const boxWidth = Math.max(2, termWidth - 1)
    const boxRule = '─'.repeat(Math.max(0, boxWidth - 2))
    // 让帧保持中性，这样持久的权限模式不会把整个 composer 变成警告横幅。模式由脚注标签
    // 承载。
    const frameStyle = S_BORDER

    // 把内容单元格包成一条全宽 `│ … │` 行：裁剪溢出，再用尾随空格填充，让右边落在框的最
    // 后一列。这么宽的行在帧中部是安全的 —— 只有帧的【最后】一行必须保持窄（xterm.js 的
    // 自动折行幽灵行问题，见下方脚注文档）。
    const boxContentWidth = Math.max(10, boxWidth - BOX_INNER_PAD)
    const boxedRow = (cells: Cell[], borderStyle: string): Cell[] => {
      const clipped = truncateCellRow(cells, boxContentWidth)
      const used = clipped.reduce((sum, cell) => sum + cell.width, 0)
      const row: Cell[] = [
        { char: '│', style: borderStyle, width: 1 },
        { char: ' ', style: S_NONE, width: 1 },
        ...clipped,
      ]
      for (let i = used; i < boxContentWidth; i++) row.push({ char: ' ', style: S_NONE, width: 1 })
      row.push({ char: ' ', style: S_NONE, width: 1 })
      row.push({ char: '│', style: borderStyle, width: 1 })
      return row
    }

    // ── 输入显示行（带软折行 + 视口窗口）──
    // 原始行只按显式 `\n` 分割。每条原始行随后在 vpWidth 列处软折成一行或多行视觉行，这
    // 样输入不会跑出终端右边缘。光标的字符偏移被映射到匹配的 (visualLine, visualCol)
    // 对，供下方的渲染/diff 路径使用。两个计算与上/下光标移动共享实现 —— 见模块级软折行
    // 几何辅助函数。
    const rawLines = text.length === 0 ? [''] : text.split('\n')
    const visualLines = buildVisualLines(rawLines, vpWidth)
    const { line: visCursorLine, col: visCursorCol } = locateVisualCursor(visualLines, rawLines, cursor)

    let displayLines: string[]
    let cursorLine: number
    if (visualLines.length <= MAX_VISIBLE_LINES) {
      displayLines = visualLines.map((v) => v.text)
      cursorLine = visCursorLine
    } else {
      let start = visCursorLine - Math.floor(MAX_VISIBLE_LINES / 2)
      start = Math.max(0, Math.min(start, visualLines.length - MAX_VISIBLE_LINES))
      displayLines = visualLines.slice(start, start + MAX_VISIBLE_LINES).map((v) => v.text)
      cursorLine = visCursorLine - start
      if (start > 0) {
        displayLines[0] = `${GLYPH_ELLIPSIS} (+${start} above)`
        if (cursorLine === 0) cursorLine = -1
      }
      if (start + MAX_VISIBLE_LINES < visualLines.length) {
        displayLines[displayLines.length - 1] =
          `${GLYPH_ELLIPSIS} (+${visualLines.length - start - MAX_VISIBLE_LINES} below)`
        if (cursorLine === displayLines.length - 1) cursorLine = -1
      }
    }
    // 下方的 `cursorCol` 指显示行内的视觉列 —— 保留现有名字，这样输入渲染块（光标放置、
    // 长行截断）无需改动。
    const cursorCol = visCursorCol

    // ── 构建 2D 单元格帧 ──
    const frame: Cell[][] = []

    // 输入框第一条显示行在帧内的行号，在下方推入输入行时捕获。当帧里没有 S_CURSOR 光标
    // 单元格（光标滚出可见窗口）时，作为隐藏硬件光标的回退停靠目标。为什么停靠位置对
    // IME 重要，见下方 cursor-park 块。
    let inputFirstLineRow = -1

    // 错误行（如有）
    if (errorMessage) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells(`Error: ${errorMessage}`, S_ERROR))
      frame.push(cells)
    }

    // （流式助手文本不在这里。useStreamBuffer 发出的每条完整行都作为 `streamingChunk` 消息
    // 提交，直接写到这个单元格缓冲上方的滚动区 —— 见 writeMessageToStdout。这样随着输出
    // 增长，我们帧的行数保持稳定：spinner / 分隔线 / 输入位置永不移位，所以没有行位移抖
    // 动。）

    // Spinner / 工具状态行。钉在输入框正上方（任何权限对话框下方），让它总是位于动态区域
    // 最底部 —— 与 Claude Code 的布局一致。
    //
    // 当工具运行时，我们把通用的 "Working..." 行替换成实时的工具状态块，每个在途工具调用
    // 一个 2 行组：
    //    ● ToolName(preview)
    //    ⎿ ⠋ progressText          （← 由 onToolProgress 流替换）
    // 这模仿 Claude Code 的 AssistantToolUseMessage + renderToolUseProgress 流程。耗时/
    // token 元信息移到【最后】一条进度行上，这样块保持紧凑（没有单独的 Working 行争抢空
    // 间）。
    if (spinner && shellWaitStreak?.waiting) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      const elapsedMs = Math.max(0, Date.now() - shellWaitStreak.startedAt)
      const meta = elapsedMs >= 1_000 ? ` (${formatElapsed(elapsedMs)} · esc to interrupt)` : ' (esc to interrupt)'
      frame.push([...textToCells(` ${glyph} Waiting for background terminal`, S_SPINNER), ...textToCells(meta, S_DIM)])
      if (shellWaitStreak.command) {
        frame.push([
          ...textToCells('   ', S_NONE),
          ...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90),
          ...textToCells(` ${shellWaitStreak.command}`, S_DIM),
        ])
      }
    }

    if (spinner && !shellWaitStreak?.waiting) {
      const glyph = SPINNER_FRAMES[spinnerFrame]
      // 在渲染时推导耗时，这样我们无需在 spinner effect 里 setState。驱动重算该值的 ~80ms
      // 重渲染由 setSpinnerFrame tick 驱动。
      const elapsedMs = loadingStartRef.current === 0 ? 0 : Date.now() - loadingStartRef.current
      const parts: string[] = []
      if (elapsedMs >= 2000) parts.push(formatElapsed(elapsedMs))
      // 令牌计数不再显示在 spinner 旁边 —— 它现在住在输入框下方的脚注里（见 contextUsage
      // 渲染），因为累计会话计数会把缓存服务的历史重复计算，而「上下文大小」快照只有在有
      // 分母时才显得有用。只有当我们确实能响应 Esc 按键（没有模态打开 —— 父组件在那时本
      // 来也会抑制 spinner，但以防万一）才显示取消提示。
      parts.push('esc to interrupt')
      const meta = parts.length > 0 ? ` (${parts.join(' · ')})` : ''

      // 只有当权限对话框紧贴 spinner 上方时才加顶边距（否则它们会没有呼吸空间地贴在一起）。
      // 当 Working 直接位于滚动区内容下方时，最后一条消息已经以 `\n\n` 结尾 → 已经有一条
      // 空行，再加一条会让空隙显得太大。
      if (permission) frame.push([])

      // 可折叠只读工具（Read/Glob/Grep/ListDir）没有实时的
      // `● Read(file) / ⎿ Running…` 指示行 —— 它们的结果被缓冲成一条摘要行，在链条结束
      // 时 flush；而在缓冲期间显示逐工具实时指示会在每次快速 read 上产生可见的「出现然后
      // 消失」闪烁：工具调用渲染提交一个带实时指示的 7 行帧，结果 1-5ms 后到达，结果后的
      // 提交被节流 50ms，在那段窗口里用户看到指示落下 —— 然后节流释放，帧缩回 5 行，而且
      // 因为 read 消息被缓冲了（没有滚动区行来接替它），指示就消失了。CC 的批量 read 流程
      // 也是这样：链条期间 spinner，之后摘要。慢速 read 因此失去逐文件可见性，但它们在链
      // 条里是罕见情况，链条结束摘要会按 basename 列出每个文件。
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
      if (tools.length > 0) {
        // 重要：实时工具气泡必须使用与 `stdout-writer.formatToolCall` 为已提交滚动区发出相
        // 同的颜色/字重方案 —— 否则当工具结束、它的行从实时区切换到滚动区时，用户会看到可
        // 见的颜色闪烁（标签 orange → default，圆点 orange → green，等等）。Claude Code 通
        // 过用同一个 React 组件渲染在途和已解析状态来避免这一点；我们有两条渲染路径（这里
        // 是 ink 风格的单元格，那里是 chalk stdout），所以手动对齐样式。
        //
        // 同样的推理适用于工具块上方的空行：`stdout-writer.formatToolCall` 的提交路径在上
        // 一次写入没有以空行结尾时前置一个 `\n`，这样已提交的工具位于其前面文本下方一行。
        // 实时帧必须现在就镜像那个决定 —— 否则工具提交的瞬间（实时帧被滚动区替换）用户会
        // 看到空行「出现」，读作下方每一行向下猛跳一行。Permission 自己的顶边距情况已在上
        // 面处理；这个分支覆盖纯工具和工具+权限的堆叠。
        if (!permission && !lastWriteEndedWithBlankRow()) frame.push([])
        //
        // 布局镜像已提交的形式：
        //    ` ● ToolName(preview)`
        //      ⎿  ⠋ progress text               ← 仅实时存在，提交时消失
        tools.forEach((tc, idx) => {
          // 相邻实时工具之间的分隔。已提交工具路径在每个工具之后发出 `\n\n`，所以连续已提
          // 交工具之间总是有一条空行。没有实时帧里同样的空行，并行工具调用会粘在一起渲染，
          // 直到其中一个结束并提交 —— 那时间距「弹出」（用户感知的「先黏住再分开」的猛跳）。
          if (idx > 0) frame.push([])

          const label = authorityVisibleText(getToolLabel(tc.toolName))
          const preview = authorityVisibleText(getToolInputPreview(tc.toolName, tc.input))

          const row1: Cell[] = []
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          // 工具运行时让圆点亮↔暗地脉冲。每相位 6 帧（按每个 spinner tick 80ms 算约
          // 480ms）读作心跳而不分心。当工具结束、该行提交到滚动区时，
          // `stdout-writer.formatToolCall` 画一个稳定不脉冲的圆点 —— 相同色相，无 dim ——
          // 所以过渡只是「停止脉冲」，而不是颜色变化。
          const dotStyle = spinnerFrame % 6 < 3 ? S_SUCCESS_DOT : S_SUCCESS_DOT_DIM
          row1.push(...textToCells(GLYPH_TOOL_BULLET, dotStyle))
          row1.push({ char: ' ', style: S_NONE, width: 1 })
          row1.push(...textToCells(label, S_BOLD))
          if (preview) {
            // 镜像 stdout-writer.formatToolCall 的截断预算，让实时行和已提交滚动区行在同一
            // 点截断 —— 否则工具结束的瞬间可见文本会移动（例如实时显示 "...rg)" 但已提交显
            // 示 "...rgs.command)"）。为 ` ● <label>(` 和 `)` 保留 label.length+5，再加一个
            // 安全边距。
            const decoration = label.length + 5
            const safetyMargin = 4
            const maxPreviewLen = Math.max(40, termWidth - decoration - safetyMargin)
            const trimmed =
              preview.length > maxPreviewLen ? preview.slice(0, maxPreviewLen - 1) + GLYPH_ELLIPSIS : preview
            // Shell 命令获得 codex 风格的语法高亮 —— 镜像 `stdout-writer.formatToolCall`
            // 里已提交的滚动区行，它必须与这个实时行的着色完全一致（见上方关于
            // live→commit 颜色闪烁的说明）。
            if (isShellToolName(tc.toolName)) {
              row1.push(...textToCells('(', S_PRIMARY))
              row1.push(...ansiTextToCells(highlightShellCommand(trimmed)))
              row1.push(...textToCells(')', S_PRIMARY))
            } else {
              row1.push(...textToCells(`(${trimmed})`, S_PRIMARY))
            }
          }
          frame.push(row1)

          // 子工具历史：对 task（子代理）工具，把最后几个工具调用显示为堆叠的 `⎿` 行（像
          // CC）。其他工具保持单条进度行。
          const history = tc.subToolHistory
          const isTask = tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task'
          if (isTask && history && history.length > 1) {
            const MAX_VISIBLE = 4
            const start = Math.max(0, history.length - MAX_VISIBLE)
            for (let hi = start; hi < history.length; hi++) {
              const isFirst = hi === start
              const isLast = hi === history.length - 1
              const row: Cell[] = []
              row.push(...textToCells('   ', S_NONE))
              if (isFirst) {
                row.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
              } else {
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push({ char: ' ', style: S_NONE, width: 1 })
              row.push({ char: ' ', style: S_NONE, width: 1 })
              if (isLast) {
                row.push(...textToCells(glyph, S_SPINNER))
                row.push({ char: ' ', style: S_NONE, width: 1 })
              }
              row.push(...textToCells(authorityVisibleText(history[hi]!), isLast ? S_DIM : S_GRAY_90))
              if (isLast && idx === tools.length - 1 && meta) {
                row.push(...textToCells(meta, S_GRAY_90))
              }
              frame.push(truncateCellRow(row, Math.max(20, termWidth - 1)))
            }
          } else {
            const row2: Cell[] = []
            row2.push(...textToCells('   ', S_NONE))
            row2.push(...textToCells(GLYPH_RESULT_BRACKET, S_GRAY_90))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(glyph, S_SPINNER))
            row2.push({ char: ' ', style: S_NONE, width: 1 })
            row2.push(...textToCells(authorityVisibleText(tc.progress ?? 'Running...'), S_DIM))
            if (idx === tools.length - 1 && meta) {
              row2.push(...textToCells(meta, S_GRAY_90))
            }
            frame.push(row2)
          }
        })
      } else {
        // 用单一风格（S_SPINNER）构建整个前缀（` ${glyph} ${label}...`），而不是逐单元格交替
        // S_NONE / S_SPINNER。原因：diff 循环里每个不同风格的单元格都会发出一个 SGR 转义，
        // 在不能完美原子化 DEC 2026 sync-update 的终端上，这些转义到达时带可见间距 —— 用
        // 户会感知到 "Working" 标签在 default-color → blue → default → blue 之间闪烁，因为
        // 中间的空格触发了重置。让整个前缀保持一段连续的 SGR run，使该行画成一条纯蓝条纹。
        const cells: Cell[] = textToCells(` ${glyph} ${spinner.label}...`, S_SPINNER)
        if (meta) cells.push(...textToCells(meta, S_DIM))
        frame.push(cells)
      }
    }

    // 排队中的回合中途用户消息：暗淡的单行预览钉在 spinner 和输入框之间 —— 最靠近用户刚
    // 打字位置的视觉锚点。上方一条空行把块与 spinner 分开；下方直接贴着输入分隔线（双侧边
    // 距在这里读作过度 padding）。这些行在循环注入它们的瞬间消失 —— 它们经
    // consumeQueuedInputs 作为普通用户消息重新出现在滚动区。
    if (queuedMessages && queuedMessages.length > 0) {
      frame.push([])
      for (const q of queuedMessages) {
        const preview = q.text.replace(/\s+/g, ' ').trim()
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells('queued: ', S_GRAY_90))
        cells.push(...textToCells(preview, S_DIM))
        frame.push(truncateCellRow(cells, Math.max(20, termWidth - 1)))
      }
    }

    // 权限对话框 —— 渲染在输入框【上方】（spinner 与输入顶分隔线之间），这样无论对话框状
    // 态如何，输入都保持钉在屏幕底部。
    if (permission) {
      // 带框对话框（与提示框相同的 `╭╮│╰╯` 语言）用中性白，匹配标题和选项文本 —— 模态时
      // 刻应该读作一个容器，而不是更多滚动文本。布局遵循 codex-cli 的审批覆盖层：粗体问题
      // 标题、空行、内容、空行、带暗淡快捷键后缀的编号选项、空行、暗淡按键提示脚注。选中
      // 行使用强调色。
      frame.push(textToCells(`╭${boxRule}╮`, S_TEXT_STRONG))
      const titleText = permissionTitle(permission.toolName, permission.mcp)
      const titleCells: Cell[] = []
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push({ char: ' ', style: S_NONE, width: 1 })
      titleCells.push(...textToCells(titleText, S_TEXT_STRONG_BOLD))
      frame.push(boxedRow(titleCells, S_TEXT_STRONG))

      const contentCells = permissionContentCells(permission.toolName, permission.input, termWidth, permission.mcp)
      if (contentCells) {
        frame.push(boxedRow([], S_TEXT_STRONG))
        frame.push(boxedRow(contentCells, S_TEXT_STRONG))
      }
      frame.push(boxedRow([], S_TEXT_STRONG))

      const ruleLabel = suggestRuleLabel(permission.toolName, permission.input, !!permission.mcp)
      // 当无法建议规则时（例如 powershell -Command "..."、enterPlanMode），always 选项被
      // 省略。最后一行是 kimi-cli 的 reject-with-feedback：选中它（Enter / 数字 / 'f'）会
      // 打开内联文本字段而不是解析。
      const options: { label: string; shortcut: string }[] = [{ label: 'Yes', shortcut: 'y' }]
      if (ruleLabel) options.push({ label: `Yes, don't ask again for: ${ruleLabel}`, shortcut: 'a' })
      options.push({ label: 'No', shortcut: 'esc' })
      options.push({ label: 'No, and tell X-Code what to do instead', shortcut: 'f' })

      options.forEach((opt, index) => {
        const selected = permissionSelected === index
        const style = selected ? S_PRIMARY_BOLD : S_TEXT_STRONG
        const cells: Cell[] = []
        cells.push(...textToCells(selected ? `${GLYPH_SELECT_POINTER} ` : '  ', style))
        if (index === options.length - 1 && permissionFeedback) {
          // 活跃的反馈行折叠成一个内联文本字段，带与主输入相同的反色光标。
          cells.push(...textToCells(`${index + 1}. No: `, style))
          const t = permissionFeedback.text
          const c = permissionFeedback.cursor
          const before = t.slice(0, c)
          const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
          const after = c < t.length ? t.slice(c + cursorChar.length) : ''
          cells.push(...textToCells(before, style))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, style))
        } else {
          cells.push(...textToCells(`${index + 1}. ${opt.label}`, style))
          cells.push(...textToCells(` (${opt.shortcut})`, S_DIM))
        }
        frame.push(boxedRow(cells, S_TEXT_STRONG))
      })

      frame.push(boxedRow([], S_TEXT_STRONG))
      // ↑/↓ (U+2191/2193) 和 · (U+00B7) 都在 CP437 里，所以旧式 ConHost 无需字形回退就能
      // 渲染它们。
      const hintCells: Cell[] = []
      hintCells.push(
        ...textToCells(
          permissionFeedback
            ? '  Type your feedback, then press Enter to submit · Esc to go back'
            : '  ↑/↓ select · Enter confirm · Esc cancel',
          S_DIM,
        ),
      )
      frame.push(boxedRow(hintCells, S_TEXT_STRONG))
      frame.push(textToCells(`╰${boxRule}╯`, S_TEXT_STRONG))
    }

    if (authorityRequest) {
      const preview = authorityRequest.preview
      const titleCells: Cell[] = []
      titleCells.push(...textToCells('  Peer-influenced request · allow once only', S_WARNING_BOLD))
      frame.push(truncateCellRow(titleCells, termWidth))

      const firstViewerRow = authorityPage * 8
      for (const row of authorityViewerRows.slice(firstViewerRow, firstViewerRow + 8)) {
        frame.push([...textToCells('  ', S_NONE), ...row])
      }
      frame.push(
        textToCells(
          `  Payload page ${authorityPage + 1}/${authorityPageCount} · ←/→ view pages · SHA-256 ${preview.outboundPayload?.sha256 ?? preview.canonicalCallSha256}`,
          S_WARNING,
        ),
      )

      const allowCells = textToCells(
        `${authoritySelected === 0 ? `    ${GLYPH_SELECT_POINTER}` : '     '} Allow once`,
        authoritySelected === 0 ? S_SUCCESS : S_DIM,
      )
      frame.push(allowCells)
      const denyCells = textToCells(
        `${authoritySelected === 1 ? `    ${GLYPH_SELECT_POINTER}` : '     '} Deny`,
        authoritySelected === 1 ? S_ERROR_BOLD : S_DIM,
      )
      frame.push(denyCells)
    }

    // Select-options 对话框 —— 渲染在我们的单元格缓冲里，与 Permission 同一个槽。下方提交
    // 路径检测「从视口上方收缩到视口内或以下」，并做 clearTerminal + 从 messages state 全
    // 量重绘，这样高对话框关闭时不会留下空滚动区行（模仿 Claude Code log-update.ts 的
    // fullResetSequence_CAUSES_FLICKER 做法）。
    if (selectRequest) {
      // 问题标题上方加空行，与上方滚动区内容做视觉分隔（模仿 CC 的 PermissionRequestTitle
      // 坐在一个带 padding 的容器里）。
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const questionText = selectRequest.question
      const maxRowW = Math.max(20, termWidth - 1)
      // 把问题文本跨多行折行，而不是截断。每个折行行都加上 1 单元格的左 padding。
      const rawCells = ansiTextToCells(renderInlineMarkdown(questionText))
      const contentW = maxRowW - 1
      let ci = 0
      while (ci < rawCells.length) {
        const row: Cell[] = [{ char: ' ', style: S_NONE, width: 1 }]
        let w = 0
        while (ci < rawCells.length && w + rawCells[ci]!.width <= contentW) {
          w += rawCells[ci]!.width
          row.push(rawCells[ci]!)
          ci++
        }
        frame.push(row)
      }
      if (rawCells.length === 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
      }

      const opts = selectRequest.options
      const hasDescriptions = opts.some(
        (o: { description?: string; freeform?: boolean }) => o.description && !o.freeform,
      )
      const isVertical = (selectRequest.layout ?? 'compact') === 'compact-vertical'
      const rowsPerOption = hasDescriptions && isVertical ? 2 : 1
      const termRows = stdout?.rows ?? 25

      // 当选项多到放不下时，对选项列表做视口滚动。可见窗口跟随活跃选中索引，让高亮行始终
      // 在视野内。
      const questionRows = Math.max(1, Math.ceil(rawCells.reduce((s, c) => s + c.width, 0) / contentW))
      const hintRows = 1
      const selectBlanks = 2
      const separatorsAndInput = 3
      const footerRow = 1
      const spinnerRows = spinner ? 1 : 0
      const todoRows = todos && todos.length > 0 ? todos.length : 0
      // 与上方 live-tool-block 的过滤一致：可折叠只读工具不画指示，所以这里也不消耗行。没
      // 有这个过滤，select-options 对话框会为不可见工具保留幽灵行，把自己放得过高（或不必
      // 要地滚动自己的视口）。
      const tools = (activeToolCalls ?? []).filter((tc) => !isCollapsibleReadOnlyTool(tc.toolName))
      const activeToolRows =
        tools.length > 0
          ? tools.reduce((sum, tc, idx) => {
              const histLen =
                tc.toolName.toLowerCase().replace(/[_-]/g, '') === 'task' &&
                tc.subToolHistory &&
                tc.subToolHistory.length > 1
                  ? Math.min(tc.subToolHistory.length, 4)
                  : 1
              return sum + 1 + histLen + (idx > 0 ? 1 : 0)
            }, 1)
          : 0
      const fixedChrome =
        selectBlanks + hintRows + separatorsAndInput + footerRow + spinnerRows + todoRows + activeToolRows
      const chromeRows = questionRows + fixedChrome
      const maxVisibleOptions = Math.max(3, Math.floor((termRows - chromeRows) / rowsPerOption))
      const totalOpts = opts.length
      const needsScroll = totalOpts > maxVisibleOptions

      let vpStart = 0
      let vpEnd = totalOpts
      if (needsScroll) {
        const half = Math.floor(maxVisibleOptions / 2)
        vpStart = Math.max(0, selectIndex - half)
        vpEnd = vpStart + maxVisibleOptions
        if (vpEnd > totalOpts) {
          vpEnd = totalOpts
          vpStart = Math.max(0, vpEnd - maxVisibleOptions)
        }
      }

      if (needsScroll && vpStart > 0) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2191 ${vpStart} more above`, S_DIM))
        frame.push(cells)
      }

      // 问题头与选项之间的空行，用于视觉分组
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const maxRowWidth = Math.max(20, termWidth - 1)
      const maxIdxWidth = totalOpts.toString().length
      const layout = selectRequest.layout ?? 'compact'

      if (layout === 'compact-vertical') {
        // compact-vertical：描述在标签下方单独缩进一行。与 CC 的 QuestionView 布局一致：
        //   › 1. Label        ← 聚焦：指针 "suggestion"，标签 "suggestion"
        //      description     ← paddingLeft = maxIndexWidth + 4
        //     2. Label         ← 未聚焦：无指针，标签默认（不加粗）
        //      description     ← 暗淡
        // CC 的 paddingLeft = maxIndexWidth + 4：
        //   1(指针) + 1(间隙) + maxIdxWidth + 1(点) + 1(空格) = maxIdxWidth + 4
        const descIndent = maxIdxWidth + 4
        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const labelStyle = active ? S_PRIMARY : S_NONE
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_PRIMARY))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))
          cells.push(...textToCells(opt.label, labelStyle))
          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
            const after = c < t.length ? t.slice(c + cursorChar.length) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          }
          frame.push(truncateCellRow(cells, maxRowWidth))
          if (opt.description && !opt.freeform) {
            const descCells: Cell[] = []
            descCells.push({ char: ' ', style: S_NONE, width: 1 })
            descCells.push(...textToCells(' '.repeat(descIndent), S_NONE))
            descCells.push(...textToCells(opt.description, S_DIM))
            frame.push(truncateCellRow(descCells, maxRowWidth))
          }
        }
      } else {
        // compact（默认）：标签和描述在同一行，右 padding 成对齐的两列。
        // 计算最大标签列宽用于对齐。
        let maxLabelW = 0
        for (let i = vpStart; i < vpEnd; i++) {
          const o = opts[i]!
          const lw = visualWidth(o.label)
          if (lw > maxLabelW) maxLabelW = lw
        }
        const gapBetween = 2
        const labelCol = maxLabelW + gapBetween

        for (let i = vpStart; i < vpEnd; i++) {
          const opt = opts[i]!
          const active = i === selectIndex
          const idx = `${i + 1}.`.padEnd(maxIdxWidth + 2)
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          if (active) {
            cells.push(...textToCells(`${GLYPH_SELECT_POINTER} `, S_PRIMARY))
          } else {
            cells.push(...textToCells('  ', S_NONE))
          }
          cells.push(...textToCells(idx, S_DIM))

          const labelStyle = active ? S_PRIMARY : S_NONE
          cells.push(...textToCells(opt.label, labelStyle))

          if (opt.freeform && active) {
            cells.push(...textToCells(': ', S_NONE))
            const t = freeform.text
            const c = freeform.cursor
            const before = t.slice(0, c)
            const cursorChar = c < t.length ? (graphemeAt(t, c) ?? ' ') : ' '
            const after = c < t.length ? t.slice(c + cursorChar.length) : ''
            cells.push(...textToCells(before, S_NONE))
            cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
            cells.push(...textToCells(after, S_NONE))
          } else if (opt.description) {
            const curLabelW = visualWidth(opt.label)
            const pad = Math.max(1, labelCol - curLabelW)
            cells.push(...textToCells(' '.repeat(pad), S_NONE))
            cells.push(...textToCells(opt.description, S_DIM))
          }

          frame.push(truncateCellRow(cells, maxRowWidth))
        }
      }

      if (needsScroll && vpEnd < totalOpts) {
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells(`  \u2193 ${totalOpts - vpEnd} more below`, S_DIM))
        frame.push(cells)
      }

      // 选项与提示之间的空行（CC：hint Box 上的 marginTop={1}）
      frame.push([{ char: ' ', style: S_NONE, width: 1 }])

      const hint: Cell[] = []
      hint.push({ char: ' ', style: S_NONE, width: 1 })
      const activeOpt = opts[selectIndex]
      const escHint = selectRequest.dismissible ? ' \u00b7 Esc to cancel' : ''
      const hintText = activeOpt?.freeform
        ? `Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Type your answer${escHint}`
        : `Enter to select \u00b7 \u2191/\u2193 to navigate${escHint}`
      hint.push(...textToCells(hintText, S_DIM))
      frame.push(hint)

      // 实时预览面板。聚焦选项可能携带一个 `preview` 数组（预渲染的 ANSI 行，例如
      // `/theme` 选择器为每个主题附上彩色 diff 片段）。渲染在提示下方，用一条空行分隔，让
      // 视觉块读作「options ↓ preview」。当聚焦选项没有预览（例如自动追加的 `Other` 行）
      // 时，面板就不出现 —— 用户用箭头滑过时没有闪烁。
      if (activeOpt?.preview && activeOpt.preview.length > 0) {
        frame.push([{ char: ' ', style: S_NONE, width: 1 }])
        for (const row of activeOpt.preview) {
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...ansiTextToCells(row))
          frame.push(cells)
        }
      }
    }

    // Todo 面板。由模型的 `todoWrite` 工具驱动；给用户一个多步任务进度的实时视图。灵感来
    // 自 Claude Code `Spinner.tsx:280` 里的
    // `<MessageResponse><TaskListV2/></MessageResponse>`，但适配到我们的单元格缓冲，那里可
    // 以有多个锚点源坐在面板上方。
    //
    // 锚点处理：只有面板上方【没有】锚点（无 spinner、无活跃工具调用）时，角字形 `⎿`
    // 才渲染在第 1 行。在那个孤例里，我们还会前置一个暗淡的 "Update Todos" 头，让角有东西
    // 可附着。当上方已经显示 spinner 或实时工具行时，那些行已经自带 `⎿` 连接符；这里
    // 再加一个会产生可见的双角（两个 `⎿` 字形堆叠），所以我们丢掉自己的，让条目作为
    // 现有锚点下方的普通缩进行。
    //
    //   上方无锚点                    上方有锚点（spinner/tool）
    //     Update Todos               ⎿ Running command...
    //   ⎿ <icon> Task name           <icon> Task name
    //     <icon> Task name              <icon> Task name
    //
    // 其他选择：
    //   - 没有「N tasks (X done, ...)」摘要头 — CC 丢掉它；图标递进
    //     (✓ vs ◼ vs ◻) 本身就是状态。
    //   - 已完成：暗淡的对勾 + 删除线暗淡内容。待处理：默认色的空心方块（不暗淡 —
    //     待处理是「等待中」，不是「被遗忘」）。进行中：主色实心方块 + 加粗内容 —— 形状
    //     （实心 vs 空心）、字重（加粗 vs 常规）和单一品牌色相共同标记活跃状态。
    //   - 没有 `activeForm` 活动行。CC 不渲染它，而且当模型对两个字段都回显同一短语时，
    //     多出来的行是视觉噪音。
    if (todos && todos.length > 0) {
      const hasAnchorAbove = !!spinner || (activeToolCalls?.length ?? 0) > 0
      if (!hasAnchorAbove) {
        const headerCells: Cell[] = []
        headerCells.push({ char: ' ', style: S_NONE, width: 1 })
        headerCells.push(...textToCells('Update Todos', S_DIM))
        frame.push(headerCells)
      }
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i]
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (i === 0 && !hasAnchorAbove) {
          cells.push(...textToCells(GLYPH_TODO_BRACKET, S_GRAY_90))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        if (t.status === 'completed') {
          cells.push(...textToCells(GLYPH_TODO_CHECK, S_DIM))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          // ANSI 2 = 暗淡，9 = 删除线。
          cells.push(...textToCells(t.content, '\x1b[0m\x1b[2;9m'))
        } else if (t.status === 'in_progress') {
          cells.push(...textToCells(GLYPH_TODO_IN_PROGRESS, S_PRIMARY_BOLD))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_BOLD))
        } else {
          cells.push(...textToCells(GLYPH_TODO_PENDING, S_RESET))
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push(...textToCells(t.content, S_RESET))
        }
        frame.push(cells)
      }
    }

    if (backgroundTerminalCount > 0) {
      const label = `${backgroundTerminalCount} background terminal${backgroundTerminalCount === 1 ? '' : 's'} running · /ps to view · /stop to close`
      const style = backgroundTerminalWarningCount > 0 ? S_WARNING_BOLD : S_DIM
      frame.push([...textToCells(' ', S_NONE), ...textToCells(label, style)])
    }

    // 刚关闭的权限对话框留下的保留 padding。位于进行中的工具行（上方）与输入分隔线（下
    // 方）之间，让帧保持对话框的总高度，直到批准工具的结果提交并滑入保留空间。
    for (let i = 0; i < permissionSlotReserveRef.current; i++) {
      frame.push([])
    }

    // 顶框线
    frame.push(textToCells(`╭${boxRule}╮`, frameStyle))

    // 输入行。终端的硬件光标在整个 TUI 生命周期内隐藏；用户看到的可见「光标」只是一个在
    // 光标位置画进帧里的反色单元格（S_CURSOR）。所以我们这里不计算也不发出 cursor-park
    // CSI。
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]
      if (i === 0) inputFirstLineRow = frame.length
      // 与已提交回显（stdout-writer）用的同一个 `›` 字形 —— 纯 ASCII `>` 读起来更尖，在它
      // 旁边显得格格不入。U+203A 按 text-width.ts 是宽度 1，所以提示保持两单元格的占位
      // （箭头 + 空格）。
      const prompt = i === 0 ? `${GLYPH_PROMPT_ARROW} ` : '  '
      const showCursor = !disabled && i === cursorLine && cursorLine >= 0
      const cells: Cell[] = []

      cells.push({ char: prompt[0], style: frameStyle, width: 1 })
      cells.push({ char: prompt[1], style: S_NONE, width: 1 })

      if (!showCursor) {
        const lw = visualWidth(line)
        const truncated = lw > vpWidth ? sliceByWidth(line, vpWidth) : line
        cells.push(...textToCells(truncated, S_RESET))
      } else {
        const before = line.slice(0, cursorCol)
        const cursorChar = cursorCol < line.length ? (graphemeAt(line, cursorCol) ?? ' ') : ' '
        const after = cursorCol < line.length ? line.slice(cursorCol + cursorChar.length) : ''
        const lw = visualWidth(line)

        if (lw <= vpWidth) {
          cells.push(...textToCells(before, S_RESET))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(after, S_RESET))
        } else {
          const beforeWidth = visualWidth(before)
          const halfVP = Math.floor(vpWidth / 2)
          let skipCols = Math.max(0, beforeWidth - halfVP)
          const totalWidth = lw + (cursorCol >= line.length ? 1 : 0)
          if (skipCols + vpWidth > totalWidth) skipCols = Math.max(0, totalWidth - vpWidth)
          const startIdx = skipByWidth(line, skipCols)
          const vb = line.slice(startIdx, cursorCol)
          const afterStart = cursorCol < line.length ? cursorCol + cursorChar.length : line.length
          const remaining = vpWidth - visualWidth(vb) - charWidth(cursorChar)
          const va = sliceByWidth(line.slice(afterStart), Math.max(0, remaining))
          cells.push(...textToCells(vb, S_RESET))
          cells.push({ char: cursorChar, style: S_CURSOR, width: charWidth(cursorChar) })
          cells.push(...textToCells(va, S_RESET))
        }
      }
      frame.push(boxedRow(cells, frameStyle))
    }

    // 底框线
    frame.push(textToCells(`╰${boxRule}╯`, frameStyle))

    // Footer 行 —— 紧凑的 mode/model/context 状态，完全由 cell-diff 缓冲拥有。
    // 其宽度封顶在 `termWidth - 1`，所以它永远不会落到终端的自动折行边界上。
    //
    // 左侧 —— notice / 模式指示器（互斥）。优先级：notice > plan > acceptEdits。
    //              模式切换仅经斜杠命令（/plan）；Shift+Tab 键绑定被移除，因为
    //              Windows 需要 Node ≥22.17 VT 输入模式，而且 Alt+M 太容易被
    //              IDE 菜单覆盖。
    // 右侧 —— 当前模型，加上可用的 `ctx 6.6k / 200k · 3%`。上下文正常为绿色，
    //              从 70% 起为琥珀色，在 80% 压缩阈值处为红色。
    let leftCells: Cell[] | null = null
    if (notice) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...ansiTextToCells(notice))
      leftCells = cells
    } else if (peerInfluenced || pendingPeerCount > 0) {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      if (peerInfluenced) {
        cells.push(
          ...textToCells(
            trustMode
              ? 'Peer-influenced context · local trust active'
              : 'Peer-influenced context · auto permissions off',
            S_WARNING_BOLD,
          ),
        )
      }
      if (pendingPeerCount > 0) {
        if (peerInfluenced) cells.push(...textToCells('  ·  ', S_DIM))
        cells.push(...textToCells(`${pendingPeerCount} peer pending`, S_DIM))
      }
      leftCells = cells
    } else if (permissionMode === 'plan') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells('plan mode', S_PRIMARY_BOLD))
      cells.push(...textToCells('  /plan to toggle', S_DIM))
      leftCells = cells
    } else if (permissionMode === 'acceptEdits') {
      const cells: Cell[] = []
      cells.push({ char: ' ', style: S_NONE, width: 1 })
      cells.push(...textToCells('accept edits', S_WARNING_BOLD))
      leftCells = cells
    }

    const rightCells: Cell[] = []
    if (modelLabel) rightCells.push(...textToCells(modelLabel, S_MODEL))
    if (contextUsage && contextUsage.used > 0 && contextUsage.window > 0) {
      const pct = Math.round((contextUsage.used / contextUsage.window) * 100)
      const usage = `${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.window)} · ${pct}%`
      const usageStyle = pct >= 80 ? S_ERROR : pct >= 70 ? S_WARNING : S_USAGE
      if (modelLabel) rightCells.push(...textToCells(' · ', S_DIM))
      rightCells.push(...textToCells('ctx ', S_DIM))
      rightCells.push(...textToCells(usage, usageStyle))
    }

    if (leftCells || rightCells.length > 0) {
      // Footer 行构建为一条窄单元格序列 —— 左侧 + ` · ` + 右侧 ——
      // 从不填充到 termWidth-1。
      //
      // 为什么用窄行：早前的一个修订版用空格把 `rightText` 填充到 termWidth-1
      // 个单元格来右对齐。这让帧的【最后】一行把它的最后一个单元格落在终端的
      // 自动折行列上。在 xterm.js（VS Code 的终端）的 BSU/ESU 同步模式下，
      // 底行这么宽的帧，每次工具结果提交触发 LF 自动滚动时都会把残留单元格
      // 泄漏进原生滚动区 —— 表现为幽灵 "Working…" 行在实时帧上方堆积。
      // 保持行窄就阻止了光标到达折行列，回归也就不会触发。
      //
      // 竞品 CLI（Codex、Gemini）之所以能右对齐，是因为它们已提交的滚动区
      // 不经 LF 自动滚动推进 —— Codex 用 ratatui 的全屏缓冲，Gemini 用
      // Ink 的 `<Static>`。我们不重新架构提交路径就没办法廉价地右对齐。
      const cells: Cell[] = []
      const leftWidth = leftCells ? leftCells.reduce((sum, c) => sum + c.width, 0) : 0
      if (leftCells) cells.push(...leftCells)
      if (rightCells.length > 0) {
        if (leftWidth > 0) {
          cells.push(...textToCells('  ·  ', S_DIM))
        } else {
          cells.push({ char: ' ', style: S_NONE, width: 1 })
        }
        cells.push(...rightCells)
      }
      // 防御性截断：模型标签让这一行比过去更长，一次硬物理折行会让 cell-diff
      // 网格失同步（与上面菜单行截断同理）。
      frame.push(truncateCellRow(cells, Math.max(20, termWidth - 1)))
    }

    // 补全菜单 —— 每帧最多渲染 slash / at 其中之一（activeMenu 强制互斥）。
    // 同一帧里两个写入者会争抢输入框上方的行，而 resize 会破坏后画的那个。
    if (activeMenu === 'slash') {
      // 列宽包含最长的「name + 空格 + argumentHint」，这样每个描述列都从同一 x
      // 开始。不把提示折叠进宽度，带提示的行会把描述推到与无提示行不同的列，
      // 产生参差的右边缘。
      const labelWidth = matches.reduce((max, cmd) => {
        const hintW = cmd.argumentHint ? cmd.argumentHint.length + 1 : 0
        return Math.max(max, cmd.name.length + hintW)
      }, 0)
      // 每条描述最多折到 2 行；仍溢出的描述在第 2 行末尾得到省略号。截断是必需的：
      // 比 termWidth 宽的行会在物理行层面硬折行（cell-diff 把它当作一个网格行，所以
      // [K 清除会漏掉被折的溢出部分），而且当它溅过最后一行终端行时会滚动视口 ——
      // 让帧与 lastFrameTopRef 失同步，并在每次菜单打开/关闭循环留下一个幻影输入框。
      const maxRowWidth = Math.max(20, termWidth - 1)
      const descCol = labelWidth + 4 // 2 空格槽 + 标签区（labelWidth + 2 空格垫）
      const descWidth = Math.max(10, maxRowWidth - descCol)
      // 窗口化渲染：一次最多显示 MAX_VISIBLE_MENU_ITEMS 个条目，滑动窗口让
      // safeIndex 保持可见。这封顶了帧高度，使菜单永不把滚动区内容推出视口
      // （那正是流式损坏 bug 的根因 —— AI 回复期间按 `/` 覆盖了已提交的滚动区
      // 并冻结了显示）。
      const total = matches.length
      const cap = MAX_VISIBLE_MENU_ITEMS
      let winStart: number
      let winEnd: number
      if (total <= cap) {
        winStart = 0
        winEnd = total
      } else {
        winStart = Math.max(0, Math.min(safeIndex - Math.floor(cap / 2), total - cap))
        winEnd = winStart + cap
      }
      if (winStart > 0) {
        frame.push(textToCells(`  ▲ ${winStart} more`, S_DIM))
      }
      for (let i = winStart; i < winEnd; i++) {
        const cmd = matches[i]
        const sel = i === safeIndex
        const labelLen = cmd.name.length + (cmd.argumentHint ? cmd.argumentHint.length + 1 : 0)
        const padRight = ' '.repeat(Math.max(2, labelWidth + 2 - labelLen))
        const padStyle = sel ? S_NONE : S_DIM
        const descStyle = sel ? S_RESET : S_DIM

        const labelCells: Cell[] = []
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push({ char: ' ', style: S_NONE, width: 1 })
        labelCells.push(...textToCells(cmd.name, sel ? S_PRIMARY_BOLD : S_DIM))
        if (cmd.argumentHint) {
          labelCells.push(...textToCells(' ', padStyle))
          labelCells.push(...textToCells(cmd.argumentHint, S_DIM))
        }
        labelCells.push(...textToCells(padRight, padStyle))

        const descRows = wrapCellsToRows(textToCells(cmd.description, descStyle), descWidth, 2)
        const row1: Cell[] = [...labelCells, ...(descRows[0] ?? [])]
        frame.push(truncateCellRow(row1, maxRowWidth))
        if (descRows.length > 1) {
          const indent: Cell[] = []
          for (let k = 0; k < descCol; k++) indent.push({ char: ' ', style: S_NONE, width: 1 })
          frame.push(truncateCellRow([...indent, ...descRows[1]!], maxRowWidth))
        }
      }
      if (winEnd < total) {
        frame.push(textToCells(`  ▼ ${total - winEnd} more`, S_DIM))
      }
    } else if (activeMenu === 'at') {
      if (atMatches.length === 0) {
        // 无匹配占位符 —— 当用户输入 `@vitejs/plugin-react` 或任何不对应本地文件的
        // token 时，让用户保持方向感。文本在 Enter 时仍原样发给模型；占位符纯粹是
        // UI 提示。
        const cells: Cell[] = []
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push({ char: ' ', style: S_NONE, width: 1 })
        cells.push(...textToCells('No matches', S_DIM))
        frame.push(cells)
      } else {
        const maxColWidth = Math.max(10, termWidth - 4)
        const atTotal = atMatches.length
        const atCap = MAX_VISIBLE_MENU_ITEMS
        let atWinStart: number
        let atWinEnd: number
        if (atTotal <= atCap) {
          atWinStart = 0
          atWinEnd = atTotal
        } else {
          atWinStart = Math.max(0, Math.min(safeAtIndex - Math.floor(atCap / 2), atTotal - atCap))
          atWinEnd = atWinStart + atCap
        }
        if (atWinStart > 0) {
          frame.push(textToCells(`  ▲ ${atWinStart} more`, S_DIM))
        }
        for (let i = atWinStart; i < atWinEnd; i++) {
          const entry = atMatches[i]
          const sel = i === safeAtIndex
          const cells: Cell[] = []
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          cells.push({ char: ' ', style: S_NONE, width: 1 })
          const display = '@' + entry.relPath + (entry.isDirectory ? '/' : '')
          const truncated = truncatePathFromStart(display, maxColWidth)
          cells.push(...textToCells(truncated, sel ? S_PRIMARY_BOLD : S_DIM))
          frame.push(cells)
        }
        if (atWinEnd < atTotal) {
          frame.push(textToCells(`  ▼ ${atTotal - atWinEnd} more`, S_DIM))
        }
      }
    }

    // ── 硬件光标停靠目标 ────────────────────────────────────
    //
    // 终端的硬件光标在应用范围内被隐藏，但 macOS 终端（Terminal.app、iTerm2）仍会把
    // IME 组合预览（标记文本 —— 例如拼音字母在组合中途）绘制在【硬件光标位置】；
    // 应用只收到已提交的字符。我们的 cell-diff 循环把光标留在最后一个变更单元格的
    // 位置：spinner 跳动时在 Working 行中间，击键后就在输入框右沿之外一格。于是 IME
    // 预览就落在那里 —— 拼音字母覆盖 Working 标签，或者一个游离字母出现在输入框右
    // 边框之外。而且这些字形从未进入我们的单元格网格，diff（与 prevFrameRef 比较而
    // 非屏幕）不知道要擦除它们。
    //
    // 修复：在每次 flush 结束时把隐藏光标停靠在可见的 caret 单元格上，这样组合预览
    // 就渲染在用户真正输入的位置。caret 是帧中第一个 S_CURSOR 单元格（对话框渲染在
    // 输入框上方，所以当两者都存在时，自由表单对话框的 caret 优先于主输入 caret）。
    // 当没有绘制 caret（caret 滚出了窗口化输入区）时，回退到输入框的第一个文本列，
    // 让预览保持在框内。
    let caretParkRow = inputFirstLineRow
    let caretParkCol = 5 // 1-based：│ + 空格 + › + 空格，然后是文本
    scanCaret: for (let r = 0; r < frame.length; r++) {
      let col = 0
      for (const cell of frame[r]!) {
        if (cell.style === S_CURSOR) {
          caretParkRow = r
          caretParkCol = col + 1
          break scanCaret
        }
        col += cell.width
      }
    }

    // ── Plan b：弱终端流式兜底（已移除）。──────────────────────────────
    //
    // 历史：我们过去在不遵守 DEC 2026 同步的终端上流式期间清空整个帧
    // （`frame.length = 0`）—— 理由是 pre-scroll（`\n.repeat(N)`）后跟着
    // 一次非原子的帧重绘，会在底行产生可见的「输入框抖动」。隐藏帧治愈了抖动，
    // 代价是整个回复期间隐藏输入框、spinner、分隔线、耗时、活动工具列表和 todos。
    //
    // 为什么放弃它：此后的两件事变了。
    //
    //  1. 流式分块的记账当时是坏的 —— `freeBlanksAboveFrameRef` 在分块填满（隐藏的）
    //     帧下方的空白行时没有递减，所以回合结束的 commit 算出了错误的 preScroll，
    //     而 `\x1b[J` 扫掉了半段回复。隐藏帧在有能力终端上掩盖了症状（xterm.js
    //     的滚动区怪癖保住了缺失的行），但底层账目是错的。现在 Plan b 路径正确递减
    //     scrollRows（约在此处下方 25 行），pre-scroll 只在 freeBlanks 真正耗尽时才
    //     触发，而不是每个分块都触发。仅此一点就大幅减少了抖动源。
    //
    //  2. 上面的有能力终端白名单曾漏掉所有主流 Linux 桌面终端（没有 VTE_VERSION
    //     检查），所以 Ubuntu/Fedora 的 GNOME Terminal 用户无条件命中兜底，并在每次
    //     AI 回复期间丢失输入框 —— 与 Windows 上的 ConHost 同类问题。即使在我们
    //     扩展白名单之后，ConHost 类终端按定义仍是「弱」的；对它们的正确答案是
    //     可见带点抖动，而不是不可见。
    //
    // 有能力终端（Windows Terminal、iTerm2、Ghostty、kitty、Alacritty、WezTerm、
    // VTE 0.68+、foot、contour、Warp、Zed）走平滑的原子 DEC-2026 路径。弱终端
    // （经 cmd.exe / Windows PowerShell 宿主运行的遗留 ConHost）得到同样的帧，只是
    // cell-diff 重绘期间可能有可见的光标走动 —— 这是用户明确偏好的取舍，胜过丢失
    // 输入框。

    // ── 与上一帧 diff 并发出一次缓冲写入 ──────────
    //
    // 帧被钉在终端的最后 `nextH` 行。每次渲染都绝对地跳到帧的左上角 —— 不从
    // 「停靠」位置做相对上/下走动，也不依赖上次渲染把光标留在哪里。这正是上方
    // DECSTBM 滚动区路径能正确工作的原因：那条路径在 reset-scroll-region 之后把
    // 光标停在 (termRows - H) 行，任何锚定于「上一帧的最后一行」的相对光标计算
    // 都会失效。
    const nextH = frame.length
    const oldFrameH = lastFrameHRef.current
    // 浮动帧模型：当帧下方有空白行（freeBlanks > 0）时，帧上浮到紧贴最后一行内容
    // 之后。当 freeBlanks 到 0 时，帧就在底部（原始行为）。frameTop 在每次
    // pendingFreeBlanks 变化时（commit 吸收空白之后、帧尺寸变化之后等）重算，所以
    // 下方的 cell-diff 循环总是在帧最终会落到的位置写入。
    const computeFrameTop = (blanks: number) => Math.max(1, termRows - nextH + 1 - blanks)
    let frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    // 几何追踪 —— 用于「输入框漂移 / 对话框重复」症状的诊断。记录底部锚定公式依赖
    // 的输入，这样我们能看出是哪一次渲染开始让空白移位。开销小（不对大型结构做
    // JSON.stringify），所以在 DEBUG_STDOUT=1 下安全保留。
    debugLog(
      'chatinput.geom.in',
      `termRows=${termRows} oldFrameH=${oldFrameH} nextH=${nextH} ` +
        `blanks=${freeBlanksAboveFrameRef.current} frameTop=${frameTop} ` +
        `lastTop=${lastFrameTopRef.current} ` +
        `permission=${permission ? '1' : '0'} ` +
        `select=${selectRequest ? '1' : '0'} ` +
        `activeTools=${activeToolCalls?.length ?? 0} ` +
        `todos=${todos?.length ?? 0} ` +
        `spinner=${spinner ? '1' : '0'} ` +
        `didCommit=${messages.length > writtenMessageCountRef.current ? '1' : '0'}`,
    )

    // 首次渲染：给「帧上方空白」追踪器播种。横幅（initialContentRows）占据视口顶部；
    // 其余到帧所在位置之间的内容都是空白。后续的 grow 可以消耗这些空白而无需
    // pre-scroll，所以横幅在正常操作期间保持在视野内。
    //
    // /clear 之后也是首次绘制（我们在上面重置了 activeRef），但横幅没了 —— 我们刚
    // 用 \x1b[2J 清空了视口 —— 所以在这里保留 initialContentRows 会在顶部留出一条
    // 幻影横幅大小的空白带，帧浮在屏幕中间。改为把整个视口当作自由空白，让帧锚定
    // 在第 1 行、下方留空（用户「全新启动减去横幅」的预期）。
    if (justClearedRef.current) {
      // 当保留的 /clear 回显随本次渲染作为 commit 到达时，新视口完全空白且归我们
      // 所有 —— 播种完整的行预算，让 commit 路径把回显写在第 1 行，并让帧紧贴其下
      // 浮动。否则只保留帧自身的行，让空帧锚定在顶部。
      freeBlanksAboveFrameRef.current = didCommitMessages ? termRows : Math.max(0, termRows - nextH)
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
      justClearedRef.current = false
    } else if (isFirstPaint && initialContentRows > 0) {
      freeBlanksAboveFrameRef.current = Math.max(0, termRows - initialContentRows - nextH)
      // 现在 freeBlanks 已设定，重设 frameTop，让第一次绘制就把帧上浮到紧贴横幅
      // 下方，而不是把它搁在一个原本空荡荡的终端底部。
      frameTop = computeFrameTop(freeBlanksAboveFrameRef.current)
    }

    // ── 终端 resize：在其先前位置擦除旧帧 ────────
    //
    // 当终端尺寸变化时，必须在绘制新帧之前擦除旧帧。
    //
    // 宽度变化：终端重排所有可见内容。每个帧行都以硬（非自动折行）行写出，所以一条
    // 可打印长度为 L 的行，在终端变窄时拆成恰好 ceil(L/newW) 行，变宽时保持 1 行。
    // onResize 捕获了那些长度（prevFrameRowLensRef），所以我们可以算出重排后帧的精确
    // 高度 R。重排残留物不在可预测的锚点上：浮动帧（下方有空白行）时，拆分的行把帧
    // 向上推过旧顶部，而缩小终端时视口窗口自身移位。精确的重排后顶部是
    //   oldTop - (R - oldFrameH) - max(0, oldTermRows - termRows)
    // （帧自身的拆分增长，加上缩小终端时视口窗口的移位）。我们从那个值、最后绘制的
    // 顶部（覆盖变宽/合并与顶部锚定重排）、底部锚定估计（覆盖残留物留在底部的全视口
    // 变窄）三者中的最小值开始擦除。比精确残留物顶部擦高几行可能裁剪空白行，但绝不
    // 裁剪会话内容 —— 内容行的拆分延续落在其原始行之下，而滚动区内容本身不受重排
    // 影响。
    const oldTermRows = lastTermRowsRef.current
    const oldTermWidth = lastTermWidthRef.current
    const didResize =
      oldFrameH > 0 &&
      activeRef.current &&
      ((oldTermRows > 0 && oldTermRows !== termRows) || (oldTermWidth > 0 && oldTermWidth !== termWidth))
    if (didResize) {
      const widthChanged = oldTermWidth > 0 && oldTermWidth !== termWidth
      if (widthChanged) {
        const newW = Math.max(1, termWidth)
        const lens = prevFrameRowLensRef.current
        const reflowedFrameH =
          lens.length > 0 ? lens.reduce((sum, len) => sum + Math.max(1, Math.ceil(len / newW)), 0) : oldFrameH
        // 重排残留物不在可预测的锚点上：浮动帧（下方有空白行）时，拆分的行把残留物
        // 向上推过旧顶部，而缩小终端时视口窗口自身移位。精确的重排后顶部是
        //   oldTop - (R - oldFrameH) - max(0, oldTermRows - termRows)
        // （帧自身的拆分增长，加上缩小终端时视口窗口的移位；帧上方的拆分增长相互
        // 抵消）。从那个值、最后绘制的顶部（覆盖变宽/合并与顶部锚定重排）、底部锚定
        // 估计（覆盖残留物留在底部的全视口变窄）三者中的最小值开始擦除。比精确残留
        // 物顶部擦高几行可能裁剪空白行 —— 滚动区内容的拆分延续落在其原始行之下，
        // 绝不会在其上，所以会话内容绝不会被擦除。
        const bottomAnchoredTop = Math.max(1, termRows - reflowedFrameH + 1)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const shiftedTop = oldTop - Math.max(0, reflowedFrameH - oldFrameH) - Math.max(0, oldTermRows - termRows)
        const eraseFrom = Math.max(1, Math.min(oldTop, shiftedTop, bottomAnchoredTop))
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      } else {
        // 仅高度变化：无重排，但缩小终端会把视口窗口按行差向上移（溢出经顶部的
        // 滚动区离开），所以最后渲染的顶部也向上移同样的量；放大则旧行留在原地
        // （顶部锚定）。与宽度分支同样的最小值候选擦除，取 R = oldFrameH。
        const bottomAnchoredTop = Math.max(1, termRows - oldFrameH + 1)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, oldTermRows - oldFrameH + 1)
        const shiftedTop = oldTop - Math.max(0, oldTermRows - termRows)
        const eraseFrom = Math.max(1, Math.min(oldTop, shiftedTop, bottomAnchoredTop))
        preBuf += `\x1b[${eraseFrom};1H\x1b[J`
      }
      // Resize 使浮动帧状态失效；下次渲染经首次绘制路径或 commit 分支重设
      // freeBlanks。
      freeBlanksAboveFrameRef.current = 0
      blankRowsAboveFrameRef.current = 0
      frameTop = computeFrameTop(0)
    }
    lastTermRowsRef.current = termRows
    lastTermWidthRef.current = termWidth

    // ── 滚动区提交写入（内联流）──────────────────────────
    //
    // 把新的 `content + frame` 作为一条连续流写出，从
    // `startRow = termRows - scrollRows - nextH + 1` 行开始，精确结束于
    // `termRows`。会被这次写入覆盖、且此前保存着真实滚动区内容的行，先经屏幕底部
    // 的 pre-scroll `\n`s 推入终端的真实滚动区（这是 xterm.js / Windows Terminal
    // 唯一认可的内容保留机制 —— DECSTBM 限定的区域滚动在 xterm.js 的 InputHandler
    // 里被拼接丢弃，已在源码确认）。
    //
    // Pre-scroll 量 = （[startRow, termRows] 里在旧帧上方的行数）=
    // max(0, scrollRows + nextH - oldFrameH)。首次绘制 / 隐藏后为 0（oldFrameH = 0，
    // 没有要保留的活动滚动区 —— 已存在的上方行原地不动），稳态活动时为
    // scrollRows，帧增长时（例如用户提交时 spinner 出现）为 scrollRows +
    // (nextH - oldFrameH)。
    //
    // Pre-scroll 之后，已有内容停在被上移的行上，写入区 [startRow, termRows] 包含旧
    // 帧的底行以及 pre-scroll 刚制造出来的空白 —— 可以整块安全覆盖。写入把新内容放
    // 在 [frameTop - scrollRows, frameTop - 1] 行，把新帧放在 [frameTop, termRows]。
    //
    // prevFrameRef 被设为刚写入的帧，让下方的 diff 循环只发出光标前进（无单元格写
    // 入）—— 没有独立的帧重绘阶段，没有闪烁。
    //
    // 写入期间光标保持隐藏。
    // freeBlanksAboveFrameRef 的延迟 flush 暂存。两个有着相同（oldFrameH → nextH）
    // 迁移的渲染，过去会在各自 stdout 写入运行之前都对着活 ref 应用 `+= deltaH` ——
    // 所以在一次缩小被重渲染过一遍、其延迟 flush 尚未触发时，空白行信用会翻倍。把
    // 目标累加到一个本地变量并在 doFlush 里提交，让这次修改变得幂等：同一状态的每次
    // 渲染都算出同样的目标，只有那个真正写了负载的渲染才应用它。它治愈的症状：
    // 每次 Bash 批准之后出现 3+ 条持续存在的空白行。
    let pendingFreeBlanks = freeBlanksAboveFrameRef.current
    // 与上面 pendingFreeBlanks 同样的幂等逻辑，但针对的是帧上方空白行计数器 —— 缩小
    // 路径可能增加它，增长路径可能消耗它。为什么，见 blankRowsAboveFrameRef。
    let pendingBlankRowsAbove = blankRowsAboveFrameRef.current
    const scrollRows = didCommitMessages ? countContentRows(scrollbackContent, termWidth) : 0
    // 本次渲染要强制重绘的顶部帧行，因为下面的 MINIMAL-WRITE commit 可能把内容溅到
    // 了它们上面（完整理由见该分支里的 spill-heal 赋值）。
    let healTopFrameRows = 0
    let handledCommitWithFrame = false
    let forceFullRedraw = false
    if (didCommitMessages && scrollRows > 0 && nextH > 0 && nextH < termRows) {
      // 我们在当前帧上方已经「拥有」的可用行：旧帧自身（即将被覆盖）加上最近一次
      // 缩小（对话框关闭）留下的任何空白行。如果新的 content+frame 装得进那个空间，
      // 就不需要全屏滚动。装不下，就把缺口 pre-scroll 进真实的终端滚动区历史。
      // 浮动帧模型：freeBlanks 始终代表帧下方（或帧在底部时帧上方 —— 同样的值，只是
      // 摆放位置不同）可复用行的预算。首次绘制（oldFrameH = 0）时它刚从
      // termRows-banner-nextH 播种，所以第一次 commit 可以把内容写在横幅正后方，并把
      // 剩余空白留在帧下方。
      const freeBlanks = freeBlanksAboveFrameRef.current
      // 帧上方滞留的空白（由最近一次大缩小把帧锚到底部留下，例如权限对话框关闭）。
      // 它们对用户可见，表现为早先滚动区与帧之间的一条空白间隙。把它们计入
      // availSpace，让 startRow 向上移，这样已提交内容写进那些行而不是跳过它们 ——
      // 消除间隙。没有这个，commit 会写在 termRows-oldFrameH-freeBlanks+1，而视口顶部
      // 与该 startRow 之间的行永远空白。
      const blankAbove = blankRowsAboveFrameRef.current
      const availSpace = oldFrameH + freeBlanks + blankAbove
      // 把 pre-scroll 封顶到帧上方真正保存着旧内容的视口行数（`termRows -
      // availSpace`）。朴素公式 `scrollRows + nextH - availSpace` 在新内容超过视口顶部
      // 与帧之间能容纳的量时会超发 —— 超出那一点的每个 \n 都会把一行【空白】自动滚
      // 进真实滚动区，在用户此前的历史和刚提交的消息之间留下可见的空行间隙。剩余的
      // 缺口在 `scrollbackContent` 于下方写出时由自动滚动自然吸收（每一条超出 termRows
      // 的折行触发一行 LF 驱动的滚动，同样的机制 —— 只是与内容交错，而不是预先的空
      // 白）。它治愈的症状：长工具结果提交（例如约 115 行的 ExitPlanMode 计划）在渲染
      // 出的计划主体上方的滚动区历史里留下约 30 条空白行。
      const maxUsefulPreScroll = Math.max(0, termRows - availSpace)
      const preScrollRows = Math.max(0, Math.min(scrollRows + nextH - availSpace, maxUsefulPreScroll))
      debugLog(
        'chatinput.geom.commit',
        `scrollRows=${scrollRows} nextH=${nextH} oldFrameH=${oldFrameH} ` +
          `availSpace=${availSpace} preScroll=${preScrollRows} ` +
          `freeBlanks=${freeBlanks} blankAbove=${blankAbove}`,
      )
      // 把 scrollbackContent 直接写在真实滚动区最后一行之后 —— 这样逐行消耗自由空白
      // 区域，而不是把它滞留成早先历史与新提交内容之间可见的间隙。
      const startRow = Math.max(1, termRows - availSpace - preScrollRows + 1)
      // 本次提交之后仍然空白的行。它们成为下次渲染的 freeBlanks —— 要么保留在帧下方
      // （帧继续上浮），要么在帧到达底部时（freeBlanks = 0）被隐式消耗。
      const rawLeftover = Math.max(0, availSpace + preScrollRows - scrollRows - nextH)
      // 当帧显著缩小（例如 select/askUser 对话框关闭）时，旧的 availSpace 反映的是那个
      // 大对话框。不封顶的话，leftoverBlanks 可能达 12+ 行，让帧浮在视口顶部、下方留
      // 一大片空白。对大缩小（> 3 行），把空白归零让帧立即锚到底部。小缩小（≤ 3）用
      // 自然下限，让浮动帧模型逐步消耗空白。
      const frameShrunk = oldFrameH - nextH
      const maxBlanks = frameShrunk > 3 ? 0 : termRows - nextH
      const leftoverBlanks = Math.min(rawLeftover, maxBlanks)
      pendingFreeBlanks = leftoverBlanks
      // 现在 pendingFreeBlanks 反映了提交后的自由行预算，重算 frameTop。在浮动帧模型
      // 里，帧顶部每次 commit 都向下移动 scrollRows（直到到达底部并停在那里）—— 下方
      // 的 cell-diff 循环和 FULL-REDRAW 路径都锚定在这个更新后的值上。
      frameTop = computeFrameTop(pendingFreeBlanks)
      // 这里没有 `\x1b[?25l`。早先的修订在 scroll-clear-redraw 窗口期间隐藏光标，让
      // 它在 renderRowToAnsi 循环内部的中间位置不会在无法完全原子化 DEC 2026 的终端上
      // 跨行闪烁 —— 但在流式响应 10-15Hz 的 commit 节奏下，这产生了与 spinner-tick 路径
      // 出于同样原因已经移除的完全相同的隐藏/显示抖动（见本文件顶部注释）。每个目标
      // 终端（xterm.js / VSCode、Windows Terminal、iTerm2、Ghostty）上的 DEC 2026 同步
      // 已经缓冲了中间位置，而本次渲染底部的 ESU_SHOW 把光标放在输入列。光标全程保持
      // 可见。
      // 从这里起有两条路径：
      //
      //   FULL-REDRAW PATH —— 用于 (a) 新内容强制全屏滚动（preScrollRows > 0），帧从
      //     底部滑出、必须在新底部重绘，或 (b) 本次渲染帧高度在变（oldFrameH !==
      //     nextH），例如 spinner 出现/消失或权限对话框打开/关闭。帧高度变化不能走
      //     下面的优化，因为 cell-diff 循环的 `maxH = max(prevH, nextH)` 随后会迭代过
      //     新底部行，从最后一行终端行触发一个 `\x1b[1B\r` 并把底部分隔线自动滚出
      //     视野。它治愈的症状：AI 回复结束的那一刻底部 `─────` 行消失（流结束时帧从
      //     4 行变成 3 行）。
      //
      //   MINIMAL-WRITE PATH —— 用于帧尺寸稳定且无需滚动时。流式响应几乎把它们的
      //     commit 全花在这里。完全不做 `[J]` 清除也不重绘帧；只清除滚动区与帧之间的
      //     间隙行，并让下方的 cell-diff 循环拾取真正的帧变化（通常只是 1 单元格的
      //     spinner 字形交换）。正是这一点消除了每次 commit 时 spinner / 分隔线 / 输入行
      //     可见的擦除重绘。
      const frameSizeChanged = oldFrameH !== nextH
      // 浮动帧模型：任何移动帧顶行的 commit 都必须走 FULL-REDRAW。下方的 cell-diff
      // 循环假设屏幕上的帧仍与 prevFrameRef.current 一致 —— 帧原地不动时为真，刚移动
      // 过则为假。没有这个守卫，commit 之后 cell-diff 会在新 frameTop 写新帧，而旧帧
      // 的单元格仍画在旧位置 —— 在旧行留下一个幻影输入框。
      //
      // 帧在 commit 时移动的两种方式：
      //   (a) 向下 —— freeBlanks（帧下方的空白行）非零，被 `scrollRows` 部分消耗，
      //       帧向底部浮动。
      //   (b) 向上 —— 帧原本底部锚定且 blankAbove > 0（例如斜杠菜单刚缩小），commit
      //       把滚动区写进那个 blankAbove 区域（`startRow` 上移），新 frameTop 最终
      //       高于帧当前所在位置。
      // 旧的检查（`freeBlanks > 0`）只捕获情况 (a)。情况 (b) 落到 MINIMAL-WRITE，旧
      // 的底部锚定帧从未被擦除，用户看到两个叠在一起的输入框。我们现在把刚算出的
      // `frameTop` 与帧上次实际绘制的位置（`lastFrameTopRef`）比较，两个方向都覆盖。
      const oldFrameTopForMoveCheck =
        lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
      const frameMoved = freeBlanksAboveFrameRef.current > 0 || oldFrameTopForMoveCheck !== frameTop
      if (preScrollRows > 0 || frameSizeChanged || frameMoved) {
        // 全量重绘路径。
        const oldFrameTopForClear =
          lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const oldFrameBottomForClear = Math.min(oldFrameTopForClear + oldFrameH - 1, termRows)
        if (preScrollRows > 0) {
          // 在 pre-scroll LF 之前擦除旧帧。LF 把 N 行视口行推进终端的真实滚动区历史之
          // 后，那些行就成了永久 —— 没有任何 ANSI 转义能清除它们。如果旧帧（带着它的
          // Working/spinner 行）坐在会被滚动推到 startRow 之上的行上，post-scroll 的擦除
          // 循环够不到它们，它们就以幽灵 "Working..." 行的形式残留在用户滚动区里。在这
          // 里擦除旧帧，确保只有空白行进入滚动区历史。
          for (let r = oldFrameTopForClear; r <= oldFrameBottomForClear; r++) {
            preBuf += `\x1b[${r};1H\x1b[K`
          }
          // 通过在底行发出 N 个 LF，把 `preScrollRows` 行推进终端的真实滚动区。这是唯一
          // 可移植的、能在滚动区历史里保留被位移行的机制：SU（`\x1b[NS`）和 DECSTBM 限定
          // 的滚动都移动视口里的单元格，但在 Windows Terminal、ConHost、iTerm2、原生
          // macOS Terminal、Ghostty 和 Alacritty 上会丢弃从顶部掉出去的行。（xterm.js 是
          // 唯一的例外，SU 有时会落入滚动区 —— 本文件早先的一个修订版基于这一点用了
          // SU，却在其他每个目标终端上静默吞掉了溢出：任何高于帧上方可用行的 AI 回复
          // 都会丢失其顶部几行。）由 termRows 处 LF 触发的自动滚动被普遍遵守。
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(preScrollRows)
        }
        // Pre-scroll 之后（或无需滚动时），擦除将要容纳新内容的视口行。preScroll 发生
        // 时，旧帧行已经在上面被清空；post-scroll 的视口行 [startRow, termRows] 是滚动
        // 制造出来的空白行。我们仍清除 [startRow, clearEnd] 以处理无滚动的情况
        // （frameSizeChanged / frameMoved），那里旧帧单元格仍坐在其原始位置。
        const clearEnd = preScrollRows > 0 ? termRows : oldFrameBottomForClear
        for (let r = startRow; r <= clearEnd; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H`
        preBuf += scrollbackContent
        const postContentScrollRows = computePostContentScrollRows(startRow, scrollRows, frameTop, termRows)
        if (postContentScrollRows > 0) {
          // 比帧上方空间还高的内容会把它的尾部留在绝对定位帧即将重绘的行上。先把那
          // 部分重叠移进真实滚动区。
          preBuf += `\x1b[${termRows};1H${'\n'.repeat(postContentScrollRows)}`
        }
        // 当帧显著缩小（例如 askUser 对话框关闭）时，滚动区内容只占旧帧空间的一小部
        // 分。与其把帧锚在终端底部、在滚动区与帧之间留下可见空白间隙，不如把帧直接
        // 放在滚动区内容下方。帧下方剩余的空白行记入 pendingFreeBlanks，让后续 commit
        // 能自然消耗它们（新内容到达时帧向底部浮动）。
        //
        // 当 blankAbove > 0 时跳过：那些滞留空白刚刚被消耗（startRow 上移去填满它们），
        // 剩余空间是对话框长进去的预算。把帧拉上来紧贴内容下方，会让那份剩余留在帧
        // 下方 —— 输入条浮在视口中间、下方是空行。改为保持帧底部锚定，让间隙留在
        // 对话框原先的位置、输入条上方（熟悉的底部位置）—— 视觉上输入待在终端边缘，
        // 间隙在最近活动与输入行之间。
        if (preScrollRows === 0 && frameShrunk > 3 && leftoverBlanks === 0 && blankAbove === 0) {
          const scrollEndRow = startRow + scrollRows
          if (scrollEndRow < frameTop) {
            frameTop = scrollEndRow
            const belowFrame = Math.max(0, termRows - frameTop - nextH + 1)
            pendingFreeBlanks = belowFrame
          }
        }
        preBuf += `\x1b[${frameTop};1H`
        for (let i = 0; i < nextH; i++) {
          preBuf += renderRowToAnsi(frame[i]) + '\x1b[K'
          if (i < nextH - 1) preBuf += '\r\n'
        }
        prevFrameRef.current = frame
      } else {
        // MINIMAL-WRITE PATH（流式期间的主导情况）。
        // 只清除 [startRow, frameTop) 里的行，把滚动区写进去，帧区域不动。下方的
        // cell-diff 循环把屏幕上未变的帧与新帧比较，只发出真正不同的单元格
        // （spinner 字形、耗时数字）。
        for (let r = startRow; r < frameTop; r++) {
          preBuf += `\x1b[${r};1H\x1b[K`
        }
        preBuf += `\x1b[${startRow};1H` + scrollbackContent
        // 溅出修复：刚写的内容在我们的几何里占 scrollRows 行，但某行在终端里比预期
        // 晚折行（CJK/歧义宽度不一致、延迟折行的幻影行）会把它的尾部溅到帧的顶部行
        // 上。下方的 cell-diff 与 prevFrameRef 比较 —— 它还保存着干净的帧 —— 所以只会
        // 重写不同的单元格，而把溅出的首列和尾部留在屏幕上（"I+ Waiting…interrupt)
        // ke@example.com…"）。永不变化的行（⎿ 命令预览）根本不会被重写，让溅出的行
        // 完全可见。把有风险的顶部行强制走 fresh-redraw 分支（从第 0 列整行重写 +
        // \x1b[K），让任何溅出在同一次 flush 里被擦掉。
        healTopFrameRows = Math.min(nextH, countSpillRiskRows(scrollbackContent, termWidth))
        if (healTopFrameRows > 0) {
          debugLog('chatinput.flush.spill-heal', `rows=${healTopFrameRows}`)
        }
        // 滚动区写入后总是把光标停在 frameTop。cell-diff 循环逐行使用绝对定位，但
        // 一次显式跳转防止任何光标位置不匹配造成视觉伪影。
        preBuf += `\x1b[${frameTop};1H`
        // 不要在这里设 prevFrameRef.current = frame —— 屏幕上的帧仍是上一渲染的帧
        // （我们没有重绘它），下方的 cell-diff 循环需要与它比较才能找出真正变化的
        // 单元格。
      }
      handledCommitWithFrame = true
      // Commit 刚在 `startRow` 写了 `scrollRows` 行滚动区内容，然后把帧放在
      // `frameTop`。它们之间的行是空白（清除循环擦掉了它们但没内容落在那儿 —— 通常
      // 为零，或当特殊块路径压扁了间隙时为一）。不管它是什么，那就是帧正上方新的
      // 连续空白计数；更靠上的旧空白一旦有已提交内容坐在它们与帧之间，就不再是
      // 「正上方」，所以它们不再与增长路径的「只滚动真实内容」逻辑交互。
      pendingBlankRowsAbove = Math.max(0, frameTop - (startRow + scrollRows))
    } else if (didCommitMessages) {
      // Plan b 弱终端路径：nextH=0（帧被上面的流式兜底清空）但 oldFrameH 可能仍 > 0
      // —— 旧帧仍画在屏幕上。如果我们让 scrollbackContent 先写，它尾部的
      // `\r\n\r\n` 会在 termRows 触发自动滚动，把旧顶部分隔线和旧输入行推进
      // 终端的滚动区历史（表现为 AI 回复上方出现「横线 + `> 查询…`」）。下面缩小路径
      // 做的擦除触发得太晚 —— 它落在刚被移位的行上，反而擦掉了新回显。
      //
      // 修复：在这里先擦除旧帧行，在 scrollbackContent 写之前。帧区域清空后，回显的
      // 自动滚动把【空白】行推进滚动区而不是旧帧残留，回显干净落地。标记
      // handledCommitWithFrame，让下面的缩小路径不要双重擦除。
      if (oldFrameH > 0 && nextH < oldFrameH && !permission) {
        // 使用实际的上一帧顶部（浮动帧模型意味着旧帧可能坐在底部锚定位置之上）。
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
        // 光标停在旧帧原先位置的顶部，所以回显写在那里，而不是旧输入下面一行。
        preBuf += `\x1b[${oldTop};1H`
        pendingFreeBlanks = freeBlanksAboveFrameRef.current + oldFrameH
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-shrink-erase',
          `oldTop=${oldTop} oldFrameH=${oldFrameH} nextH=${nextH} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `frameTop=${frameTop}`,
        )
        forceFullRedraw = true
        handledCommitWithFrame = true
      }
      // 计入流式内容行，让 freeBlanks 跟上现实。Plan b 在每次消息已提交但帧被隐藏
      // （nextH=0，流式兜底）的渲染上运行 —— 即 AI 回复的每个分块。`scrollbackContent`
      // 即将写进渲染器之前以为空白的行（首次绘制时从 termRows-banner-frameH 播种的
      // `freeBlanks` 预算）。没有这个递减，freeBlanks 在整个响应期间停留在初始值，所以
      // 流结束时（nextH:0→3，走主 FULL-REDRAW 路径）的最终渲染会算出
      // availSpace=oldFrameH+freeBlanks=40、preScroll=0，而 \x1b[J 擦掉流式正文。
      // xterm.js / VSCode 的终端靠自身滚动区怪癖意外掩盖了这一点（见约 1932 行的 SU
      // 注释）；在 ConHost / Windows PowerShell 宿主 / GNOME Terminal / xterm / 其他所有
      // 目标上，正文真的被擦掉了，spinner 停止后输入框上方只剩最后 1-2 行。
      // 与主 commit 路径在约 1869 行做的 leftoverBlanks 记账互为镜像 —— 同样的思路，
      // 只是应用在 Plan b 一侧。
      if (scrollRows > 0) {
        const before = pendingFreeBlanks
        pendingFreeBlanks = Math.max(0, pendingFreeBlanks - scrollRows)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.commit-streaming',
          `scrollRows=${scrollRows} blanks ${before}->${pendingFreeBlanks} frameTop=${frameTop}`,
        )
      }
      preBuf += scrollbackContent
    }

    let buf = ''

    // 帧高度变化：帧钉在底部，所以 H 增长时它的顶部向上移 —— 有覆盖当前住在那里的
    // 滚动区行的风险。
    //
    // 小增长（≤3 行 —— spinner 出现、权限对话框）用全屏滚动，让被位移的内容最终
    // 保留在终端的真实滚动区里。
    //
    // 大增长（≥4 行 —— SelectOptions 选择器、有很多条目的补全菜单）在典型会话里几乎
    // 总是坐在空白行上（横幅 + 一些空白 + 底部的帧）。把这些空白 pre-scroll 进真实
    // 滚动区会永久消耗后续缩小无法恢复的视口行 —— 这就是「/model 之后有一大块空白」
    // 的抱怨。这种情况下我们跳过 pre-scroll，改为在 cell diff 重绘覆盖之前先擦除增长
    // 区域。当帧缩回去时，下面已有的擦除分支清除扩展区域，布局回到增长之前的样子。
    //
    // 对缩小，旧帧底部在新顶部上方暴露为「陈旧帧单元格」—— 清除那些行。
    if (!handledCommitWithFrame && activeRef.current && oldFrameH > 0 && oldFrameH !== nextH) {
      if (nextH > oldFrameH) {
        const deltaH = nextH - oldFrameH
        // 尽可能消耗帧下方刚变空的空间 —— 那些行可以被覆盖而不丢失任何东西。任何多余
        // 的扩展超过底部空白，就把多出的部分 pre-scroll 进真实滚动区，以保留上方内容
        // （横幅、更早的消息）。没有这个，输入 `/` 打开补全菜单就会抹掉输入框正上方
        // 的任何滚动区。
        const absorbed = Math.min(deltaH, freeBlanksAboveFrameRef.current)
        // 然后消耗帧【正上方】的任何空白行（由之前一次大缩小留下）。帧可以经 cell-grid
        // 重绘向上伸进这些行，而无需任何 LF 滚动 —— 在这里发 LF 会把空白推进终端滚动
        // 区成为永久间隙（症状：每当子代理连续打开多个权限对话框时，`Task()` 行下面
        // 出现一大段空行）。只有超出那个空白区域的行才是真正需要滚进历史的真实内容。
        const fromBlankAbove = Math.min(deltaH - absorbed, pendingBlankRowsAbove)
        pendingBlankRowsAbove -= fromBlankAbove
        const rawNeedsScroll = deltaH - absorbed - fromBlankAbove
        // 把 LF 数量封顶到实际坐在旧帧上方的真实内容行数。没有这个封顶，斜杠菜单的
        // 增长路径（例如 18 行终端里 nextH=22）会在底边发出 `deltaH - absorbed` 个 LF
        // —— 但每个超出 `oldTop - 1` 的 LF 都在滚动一个幻影行（帧向上延伸到屏幕外），
        // 每次幻影滚动都把一行【空白】推进终端滚动区，在每个 /command 输出之间留下可见
        // 的空行。帧被允许在视口顶部被裁剪（computeFrameTop 的下限是第 1 行）；我们
        // 不需要为屏幕外部分「腾地方」。
        //
        // 我们再减去 `blankRowsAboveFrameRef.current`，因为那些行已经空白（之前一次
        // 缩小留下的），而 `fromBlankAbove` 只消耗了其中至多 `deltaH - absorbed`；帧上方
        // 任何剩余的空白行否则会被 `oldTop - 1` 公式当作「真实内容」。
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        const realContentAboveFrame = Math.max(0, oldTop - 1 - blankRowsAboveFrameRef.current)
        const needsScroll = Math.min(rawNeedsScroll, realContentAboveFrame)
        if (needsScroll > 0) {
          // 在滚动前擦除旧帧，让被推进终端滚动区的是空白行 —— 而不是陈旧的提示/分隔
          // 线单元格。没有这个，select 对话框关闭后，`> ▊` 提示行会成为滚动区里的永久
          // 幽灵。
          for (let i = 0; i < oldFrameH; i++) {
            preBuf += `\x1b[${oldTop + i};1H\x1b[K`
          }
          preBuf += `\x1b[${termRows};1H` + '\n'.repeat(needsScroll)
        }
        pendingFreeBlanks = Math.max(0, freeBlanksAboveFrameRef.current - deltaH)
        // 为新的（更小的）freeBlanks 重算 frameTop。纯吸收（无滚动）时，frameTop 留在
        // 旧顶部，帧向下增长。有滚动时，frameTop 掉到底部锚定位置（newFreeBlanks=0）。
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.grow',
          `delta=${deltaH} absorbed=${absorbed} fromBlankAbove=${fromBlankAbove} ` +
            `scrolled=${needsScroll}${needsScroll !== rawNeedsScroll ? ` (capped from ${rawNeedsScroll}; realContent=${realContentAboveFrame})` : ''} ` +
            `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
            `frameTop=${frameTop}`,
        )
        // 预擦除新占据的帧底部行，让任何陈旧单元格（来自先前渲染或自动滚动残留）不会
        // 在下方 diff 重绘它们之前渗出来。
        for (let i = 0; i < deltaH; i++) {
          preBuf += `\x1b[${frameTop + oldFrameH + i};1H\x1b[K`
        }
      } else {
        const deltaH = oldFrameH - nextH
        // 缩小：帧变短了（例如 select 对话框关闭）。擦除整个旧帧区域，让没有幽灵内容
        // 残留（旧的 spinner 行、对话框选项等），并把帧重新定位到靠近底部。
        //
        // 大缩小（例如 askUser 对话框关闭：37→7）否则会留下 26+ 行空白。帧浮在第 1 行，
        // 要经过许多次 commit 才能漂回下来，让用户盯着一块几乎空白的屏幕。把空白封顶
        // 为 0，让帧在大缩小后立即弹到底部。小缩小（≤3 行，例如权限对话框关闭）可以
        // 保留它们的空白让浮动帧模型自然消耗 —— 间隙几乎不可见。
        const rawBlanks = freeBlanksAboveFrameRef.current + deltaH
        const MAX_SHRINK_BLANKS = deltaH > 3 ? 0 : termRows - nextH
        pendingFreeBlanks = Math.min(rawBlanks, MAX_SHRINK_BLANKS)
        const oldTop = lastFrameTopRef.current > 0 ? lastFrameTopRef.current : Math.max(1, termRows - oldFrameH + 1)
        frameTop = computeFrameTop(pendingFreeBlanks)
        debugLog(
          'chatinput.geom.shrink',
          `delta=${deltaH} blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` +
            `(raw=${rawBlanks}) ` +
            `oldTop=${oldTop} newTop=${frameTop}`,
        )
        // 擦除整个旧帧区域 —— 不只是底部增量行。当帧从高位（oldTop=3）移到靠近底部
        // （frameTop=28）时，旧位置的行必须清除，以防幽灵 spinner / 陈旧内容。
        for (let i = 0; i < oldFrameH; i++) {
          preBuf += `\x1b[${oldTop + i};1H\x1b[K`
        }
        // 大缩小（deltaH > 3）把帧弹到底部；oldTop 与新 frameTop 之间的行现在是空白，
        // 但从未进过终端滚动区。追踪它们，让下次 grow 可以经 cell-grid 重定位把帧向上
        // 延伸，而不是用 LF 自动滚动（那会把这些空白推进历史）。小缩小把它们的
        // freeBlanks 留在帧下方，让 frameTop 原地不动 —— `frameTop - oldTop` 为 0 或
        // 负数，不产生贡献。
        if (frameTop > oldTop) {
          pendingBlankRowsAbove += frameTop - oldTop
        }
      }
      // 帧移动了 —— prev 单元格矩阵现在在错误的行上；强制在新位置全量重绘。
      // 注意：不要在这里改动 prevFrameRef.current。这段代码在负载构建期间运行，但对
      // 非 commit（延迟）渲染，把该负载写到 stdout 的 doFlush 可能被 1-2 ms 后到达的
      // commit 取消。如果我们现在清空 prevFrameRef 而延迟被取消，ref 保持 []，而屏幕
      // 上的帧仍是旧帧 —— 导致下次渲染的 cell-diff 把每一行都当「新行」，在新 frameTop
      // 写完整条 Working 行，而旧的 Working 还在屏幕上旧位置 → 两条可见的 "Working…"
      // 行。
      // 改为使用本地标志；doFlush（下面那行）在成功写入后无条件地设
      // prevFrameRef = frame。
      forceFullRedraw = true
    }

    const prevFrame = forceFullRedraw ? [] : prevFrameRef.current
    const prevH = prevFrame.length
    const maxH = Math.max(prevH, nextH)

    // 逐行绝对定位（Claude-Code 风格）。
    //
    // 早先的代码做「跳到帧顶，然后用 \x1b[1B\r 逐行向下走」。稳定的 spinner 跳动时
    // 实际只有一行里一个单元格变化，但相对走法不管怎样都在每一行后发出
    // `\x1b[1B\r` —— 把光标在向下过程中移过帧的每一个未变行，加上初始跳到帧顶，
    // 加上最后停到光标锚点。每次跳动 5+ 个光标位置，而在 DEC 2026 同步不能完全原子化
    // 光标位置的终端（Windows Terminal、VSCode xterm.js、ConHost）上，每个中间停点都
    // 会被终端渲染器处理 —— 即使光标隐藏也可见为闪烁，因为每个光标定位命令都会启动
    // cell-render 管线。
    //
    // 逐行绝对（`\x1b[absRow;colH` 只在我们实际写的行上）意味着一次稳定的 spinner
    // 跳动只访问 2 个光标位置：spinner 单元格，和最后的光标锚点停靠。未变行被跳过
    // —— 不跳到它们，不 `\x1b[K`，不前进。
    for (let row = 0; row < maxH; row++) {
      // 被 spill-heal 标记的行拿到空 prevRow，这样无论它们的单元格是否与 prevFrameRef
      // 不同，都走 fresh-redraw 分支（第 0 列重写 + \x1b[K）。
      const prevRow = row < healTopFrameRows ? [] : row < prevH ? prevFrame[row] : []
      const nextRow = row < nextH ? frame[row] : []
      const absRow = frameTop + row

      if (row < nextH) {
        // 第一个与 prevRow 不同的单元格
        let diffIdx = 0
        const minCells = Math.min(prevRow.length, nextRow.length)
        while (diffIdx < minCells && cellsEqual(prevRow[diffIdx], nextRow[diffIdx])) {
          diffIdx++
        }
        // 最后一个不同的单元格（从末尾扫描）。fresh redraw（prevRow 为空）时我们一直
        // 发到行尾；否则在最后一次真正变化处封顶，这样例如一次 spinner 跳动只重写
        // 字形单元格，而不是每 80ms 重写整个 " glyph  Working… (5s · ↑ 2k tokens)"
        // 后缀。写得越少 = 每次跳动重新绘制的可见单元格越少 = 在 DEC 2026 同步更新
        // 不完全原子的终端上没有可感知的闪烁。
        let endIdx = nextRow.length
        if (prevRow.length > 0 && nextRow.length === prevRow.length) {
          let last = nextRow.length - 1
          while (last >= diffIdx && cellsEqual(prevRow[last], nextRow[last])) {
            last--
          }
          endIdx = last + 1 // 排他上界
        }

        // 强制清除分支：prevRow 为空且 nextRow 为空。通常「空保持空」的行是 no-op，但
        // 当上游 grow/shrink 路径把 prevFrameRef 重置为 [] 以强制全量重绘时，这个位置
        // 的空行可能遮蔽上一个（更高的）帧留在屏幕上的陈旧字符 —— 最明显的是输入框的
        // `─` 顶部分隔线从两个并行工具块之间新插入的空白中透出来。显式的 \x1b[K 在
        // 重绘继续之前擦掉终端在这一行仍残留的一切。
        if (prevRow.length === 0 && nextRow.length === 0) {
          buf += `\x1b[${absRow};1H\x1b[K`
        } else if (diffIdx < nextRow.length || nextRow.length < prevRow.length) {
          // 绝对定位到 (absRow, diffIdx 的视觉列)。
          let col = 0
          for (let c = 0; c < diffIdx; c++) col += nextRow[c].width
          buf += `\x1b[${absRow};${col + 1}H`

          // 发出变化的单元格。把 lastStyle 初始化为 S_NONE（= 显式重置码），让第一个
          // 单元格的字符不继承上一渲染留下的任何 SGR 状态 —— 没有这个，diff 循环的
          // `if (cell.style !== lastStyle) buf += cell.style` 分支可能对一个 S_NONE 单元格
          // 发出 ''（no-op），其字符随后用之前激活的任意颜色渲染。
          let lastStyle = S_NONE
          buf += S_NONE
          for (let c = diffIdx; c < endIdx; c++) {
            const cell = nextRow[c]
            if (cell.style !== lastStyle) {
              buf += cell.style
              lastStyle = cell.style
            }
            buf += cell.char
          }
          buf += S_RESET
          if (prevRow.length === 0) {
            // Fresh redraw（post-eraseRegion 或首次绘制之后）。该行可能带着先于这个帧的
            // 滚动区写入留下的陈旧字符（例如一条 CJK 行因宽度误算把残留撞到了
            // spinner/输入行上）。擦到 EOL，这样我们从干净的行开始。我们在 diff 更新时
            // 刻意不这么做：80 ms 的 spinner 跳动随后会每帧发一个 \x1b[K，在没有完整
            // DEC 2026 同步更新支持的终端上明显闪烁。
            buf += '\x1b[K'
          } else {
            // Diff 更新 —— 旧行更宽时用空格填充。在终端上不可见（无 SGR 变化），所以
            // 不闪烁。
            let oldTailW = 0
            for (let c = diffIdx; c < prevRow.length; c++) oldTailW += prevRow[c].width
            let newTailW = 0
            for (let c = diffIdx; c < nextRow.length; c++) newTailW += nextRow[c].width
            if (oldTailW > newTailW) {
              buf += ' '.repeat(oldTailW - newTailW)
            }
          }
        }
        // 否则：行相同 —— 跳过，不移动光标。
      } else {
        // 多出的旧行 —— 绝对定位并清空它。
        buf += `\x1b[${absRow};1H\x1b[K`
      }
    }

    // 光标停靠在负载末尾（见下方）发生，不在这里：目标的绝对行取决于最终的
    // `frameTop`，而上面的 commit/geometry 路径仍可能重设它。关键是每次移动光标的
    // flush 都把它重新停到 caret 单元格上 —— 为什么，见帧构建时的「硬件光标停靠目标」
    // 块（IME 标记文本即使在隐藏时也渲染在硬件光标处）。用户看到的视觉「输入光标」
    // 仍是上方 cell-diff 循环原子绘制的反白单元格（S_CURSOR）。

    // 把一切作为单次写入 flush：preBuf（BSU + DECSTBM 滚动区插入 + 任何帧高度变化的
    // 滚动）+ 帧 diff + ESU。一次 write() = 在【每个】终端上的一次原子绘制，不只是支持
    // DEC 2026 的那些。注意：我们不再在末尾追加 SAVE_CURSOR (\x1b7)。那个 DEC 保存
    // 寄存器是单槽位，而且与 Ink 的 log-update 内部共享，所以我们的保存在每次 Ink 树
    // reconcile 时都被覆盖。改为在每次渲染开始时绝对跳到 (frameTop, 1) —— 没有跨渲染
    // 的光标状态依赖。ESU 从不携带可见性命令。光标在这个组件整个生命周期内都被隐藏
    // （见上面挂载 useEffect），输入「光标」只是输入行上一个反白单元格，与帧其余部分
    // 一起原子绘制。每次 flush 的 `?25h` / `?25l` 切换会重置 Windows Terminal 和 VSCode
    // xterm.js 上的光标闪烁相位 —— 那就是用户在输入到最右列时报告的闪烁。
    const esu = '\x1b[?2026l'

    // 对 no-op flush 提前返回。当 spinner 跳动但没有任何单元格内容变化（BSU 之后
    // preBuf 为空、buf 为空），仅包装（`?2026h` + `?2026l`，16 字节）就足以让终端重新
    // 处理同步窗口 —— 而在弱终端上这仍会重置光标闪烁相位，产生用户以 12 Hz 看到的
    // 光标闪烁。完全跳过写入正是 Claude Code 用的技巧
    // （D:\res\claude-code\src\ink\ink.tsx:623, 668-671 ——
    // `hasDiff || targetMoved` 提前返回）。
    if (preBuf === BSU && buf === '') {
      lastFlushTimeRef.current = Date.now()
      // 空 diff 意味着当前渲染的帧与屏幕上已有的（prevFrameRef）一致。如果有待处理的
      // 延迟 flush，它是由某个帧偏离 prevFrameRef 的更早渲染安排的 —— 让它现在触发会
      // 把那个中间状态画在（已经正确的）当前帧之上。具体案例：一个快速 read 工具把帧
      // 长到 7 行（延迟 8ms），然后结果到达、下一次渲染算出 5 行 —— 与上次实际 flush
      // 的相同，于是这个空 diff 分支运行。没有下面的取消，8ms 的延迟触发并把陈旧的
      // `● Read / ⎿ Running` 实时指示器画出来，而此时 read 早已完成，让它卡在屏幕上直到
      // 下一次工具调用的 grow 覆盖它。用户报告的症状是「read 工具在连续的 read 之间
      // 出现又消失」。
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled-empty', 'empty diff supersedes stale deferred')
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
      }
      // 仍需要应用待处理的空白行更新；缩小路径可能算出了新值。
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog('chatinput.geom.persist-noop', `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks}`)
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist-noop',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      return
    }

    // 把隐藏的硬件光标停靠在 caret 单元格上，作为负载的最后一个动作。追加在上面的
    // no-op 提前返回之后，让什么都不写的 flush 保持字节静默（光标已从上一次写入时
    // 停靠好）；任何确实写了东西的 flush 会把光标留在帧中间（spinner 跳动时在 Working
    // 行中间，击键后就在右沿之外一格），而那正是 macOS 终端随后绘制 IME 组合预览的
    // 位置。每次非空 flush 多一个 CSI；只有当帧根本没有输入框（nextH=0）时
    // caretParkRow 才为 -1，那种情况下没有可锚定的 caret，我们把光标留在写入结束的
    // 位置。
    if (caretParkRow >= 0) {
      buf += `\x1b[${frameTop + caretParkRow};${caretParkCol}H`
    }

    const payload = preBuf + buf + esu
    debugLog(
      'chatinput.flush',
      `bytes=${payload.length} preBufBytes=${preBuf.length} bufBytes=${buf.length} msgsCommitted=${writtenMessageCountRef.current} pendingBlanks=${pendingFreeBlanks} frameTop=${frameTop} nextH=${nextH}`,
    )
    // 渲染出的帧可能包含 peer 消息、机密、或完整的出口审批查看器。只记录几何信息，
    // 让 debug 模式不会成为安全敏感终端内容的第二份持久副本。
    debugLog('chatinput.flush.payload', `bytes=${Buffer.byteLength(payload, 'utf8')} rows=${nextH}`)

    // ── 防闪烁写入调度 ──────────────────────────────────
    //
    // 快速工具（listDir、glob、readFile）在 <5ms 内完成。React 背靠背渲染帧：
    //   Frame A（非 commit）：为工具显示 "⠼ Running…"
    //   Frame B（commit，约 2ms 后）：用结果摘要替换它
    // 两者都是大型重绘（约 600-700 字节）。在同一个 vsync 窗口（16ms）内画两者会
    // 造成可见的闪烁/抖动。
    //
    // 策略：
    //   • commit 和 resize 帧立即写入 —— 它们取消任何待处理的延迟写入，因为两者都
    //     携带必须原子到达终端的一次性滚动/擦除操作。
    //   • 非 commit 帧延迟。两个窗口：
    //       — spinner 跳动（spinnerFrame 自上次 flush 后变化）：24ms。更宽的窗口让
    //         一个在 spinner 跳动后 1-20ms 落地的 useStreamBuffer 150ms-排空 commit
    //         取代只含 spinner 的写入，而不是产生背靠背的 spinner-cell + commit 对
    //         （在长时间流式响应中观察到的可见「跳动 + 内容滚入」闪烁）。
    //       — 其他一切（打字、没让 spinner 跳动的内容变化）：8ms。按住字母键每次击键
    //         产生一次非 commit 渲染；这里更宽的窗口会在连续打字时明显卡顿，因为每次
    //         击键的延迟触发都发生在更宽的节奏上，而不是感觉即时。
    //     如果 commit 在延迟窗口期间到达，延迟帧被丢弃，只画 commit。
    //   • 此外，距离上次写入 16ms 内的非 commit 帧被完全丢弃（spinner 合并）。

    const doFlush = () => {
      const ok = process.stdout.write(payload)
      if (!ok) debugLog('chatinput.flush.backpressure', 'process.stdout.write returned false')
      lastFlushTimeRef.current = Date.now()
      lastFlushedSpinnerFrameRef.current = spinner != null ? spinnerFrame : null
      prevFrameRef.current = frame
      lastFrameHRef.current = nextH
      lastFrameTopRef.current = frameTop
      // 字节现在已到 stdout。丢弃 ref 让下次渲染不重发它们。设为 ''（而不是把
      // scrollbackContent 从前面切掉）是安全的：任何在调度与这个节流 doFlush 触发之间
      // 改动 ref 的渲染，都会进入下面立即的结构分支，用包含新字节的新负载替换节流。
      pendingScrollbackRef.current = ''
      if (pendingFreeBlanks !== freeBlanksAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blanks ${freeBlanksAboveFrameRef.current}->${pendingFreeBlanks} ` + `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      freeBlanksAboveFrameRef.current = pendingFreeBlanks
      if (pendingBlankRowsAbove !== blankRowsAboveFrameRef.current) {
        debugLog(
          'chatinput.geom.persist',
          `blankAbove ${blankRowsAboveFrameRef.current}->${pendingBlankRowsAbove} ` +
            `frameTop=${frameTop} nextH=${nextH}`,
        )
      }
      blankRowsAboveFrameRef.current = pendingBlankRowsAbove
      // 增加代数。任何捕获的 flushId 现在与此值不同的待处理延迟 flush 宏任务，运行时
      // 都会短路 —— 见下方调度路径。
      flushGenRef.current++
    }

    // 驱动调度器的是 `hasNewMessages`（而非 `didCommitMessages`）：一个处理了新消息的
    // 渲染 —— 即使每条都被 read-group 折叠器缓冲、产生零滚动区字节 —— 仍是「真实」
    // 状态变化，必须及时绘制。没有这个，被缓冲的 read 工具的结果后渲染会走延迟路径
    // （160ms 延迟），而上一渲染的 grow-frame（`● Read(file) / ⎿ Running…` 实时指示器）
    // 停在延迟定时器里。它稍后才触发 —— 远在 read 真正完成之后 —— 让陈旧的实时指示器
    // 留在屏幕上，直到下一次 read 的 grow 覆盖它。用户报告的可见症状：`● Read` 行在
    // 连续的 read 工具之间「出现又消失」。
    if (didCommitMessages || hasNewMessages || didClearScreen || didResize) {
      // 一旦观察到结构输出就立即使延迟帧失效，而不是等它到达 stdout。它的定时器可能
      // 已经排了 setImmediate 并清空了 deferredFlushRef；没有这次代数增加，那个陈旧
      // 回调可能先绘制、清除待处理的滚动区，或搁置一个下次渲染无法重建的 resize 擦除。
      flushGenRef.current++
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
        debugLog('chatinput.flush.deferred-cancelled', `${didResize ? 'resize' : 'commit'} superseded deferred frame`)
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
      }
      // 较新 commit 的负载（包括更新的滚动区 + spinner 字形）取代任何之前被节流的
      // commit。
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog('chatinput.flush.commit-throttle-superseded', 'newer commit replaces throttled')
      }
      const dt = Date.now() - lastFlushTimeRef.current
      // 连续 stdout 写入之间的最小间隔。同一个终端绘制窗口（约 16ms vsync）内的两次
      // 写入，即使各自都包在 BSU/ESU 里，也会显示为闪烁 —— DEC 2026 同步是每次写入
      // 原子的，但不跨写入。最常见的原因：一次 160ms spinner 延迟触发（T）后跟一次
      // useStreamBuffer 排空 commit（T+10–50ms）。把 commit 节流到在上次写入后 ≥50ms
      // 落地，让它进入一个全新的绘制周期。50ms = 约 3 个 vsync，对缓冲多帧的终端足够
      // 富余。
      const MIN_COMMIT_GAP_MS = 50
      // /clear 和 resize 负载免于间隔节流：它们的一次性擦除字节无法被后续渲染重新收
      // 集。特别地，在节流的 resize flush 之前推进 lastTermWidthRef，让下一次
      // reasoning/spinner 渲染能取消唯一那个擦除 xterm.js 重排后旧帧的负载。
      if (!didClearScreen && !didResize && lastFlushTimeRef.current > 0 && dt < MIN_COMMIT_GAP_MS) {
        const delay = MIN_COMMIT_GAP_MS - dt
        const capturedGen = flushGenRef.current
        commitThrottleRef.current = setTimeout(() => {
          commitThrottleRef.current = null
          if (flushGenRef.current !== capturedGen) {
            debugLog(
              'chatinput.flush.commit-throttled-stale',
              `gen ${capturedGen}->${flushGenRef.current}, skipping stale flush`,
            )
            return
          }
          doFlush()
          debugLog('chatinput.flush.commit-throttled-fired', `delay=${delay}ms`)
        }, delay)
        debugLog('chatinput.flush.commit-throttled', `delay=${delay}ms dt=${dt}ms`)
      } else {
        doFlush()
      }
    } else {
      // 有一个被节流的 commit 在途。如果这个非 commit 帧有【不同】高度（对话框打开/
      // 关闭、错误行等），它取代被节流的 commit —— 取消陈旧的节流并让这个帧立即通过。
      // 保持高度的帧（spinner 跳动）可以安全等待。
      if (commitThrottleRef.current !== null) {
        const heightChanged = nextH !== lastFrameHRef.current
        if (!heightChanged) {
          debugLog('chatinput.flush.deferred-skipped', 'commit throttle pending')
          return
        }
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
        debugLog(
          'chatinput.flush.commit-throttle-superseded-by-height',
          `nextH=${nextH} lastH=${lastFrameHRef.current}`,
        )
      }
      const now = Date.now()
      // 只合并同高度的帧（spinner 跳动、单单元格输入编辑）。帧高度变化标志着结构性
      // 更新 —— 对话框打开/关闭、错误行出现等 —— 即使落在上次写入 16ms 内也必须绘制。
      // 合并一个高度变化的帧过去会把 UI 搁在旧帧上，当触发它的事件（例如流结束 →
      // 权限提示渲染）也恰好是永远会重渲染的最后事件时：spinner 间隔在
      // `spinner === null` 时清除，不再有 React tick 到达，携带提示的被丢弃负载再也不
      // 重试。症状：工具调用行永远卡在 "⠴ Running... (↓ N tokens)"，输入冻结。
      const isSpinnerTick = nextH === lastFrameHRef.current
      // 当这次渲染唯一有意义的变化是 spinner 字形循环 —— 内容/文本/对话框都未变 ——
      // 时为真。我们可以更激进地丢弃这些，因为下一个 commit 反正会重绘整个帧，在全量
      // 重绘里带上最新的 spinner 字形。
      const spinnerTicked = spinner != null && spinnerFrame !== lastFlushedSpinnerFrameRef.current
      // 合并。只在单个终端刷新窗口（16ms）内丢弃背靠背的同高度帧 —— 更宽的都放行。
      // 防止 spinner-vs-commit 闪烁的职责交给下面的延迟触发机制：一个宽的 spinner
      // deferMs 让在途 commit 能 clearTimeout 延迟，把可能的近碰撞变成单次仅 commit
      // 写入。我们刻意不在这里对 commit 时间做合并 —— 那种做法（流式期间丢弃只含
      // spinner 的帧）把 spinner 字形绑到 commit 节奏上，在 useStreamBuffer 的
      // COMMIT_BATCH_MS 产生的 50-300ms 可变间隙下明显抖动。
      const coalesceWindow = 16
      const dt = now - lastFlushTimeRef.current
      if (isSpinnerTick && dt < coalesceWindow) {
        debugLog('chatinput.flush.coalesced', `dt=${dt}ms spinner=${spinnerTicked ? 1 : 0}`)
        return
      }
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
      }
      // spinner 跳动延迟 160ms。理由：
      //   - useStreamBuffer 在分块排队 150ms 后排空，然后 React 渲染调度在 commit 落地
      //     前再增加约 10ms。160ms 的延迟让那个排空驱动的 commit 能可靠地在只含
      //     spinner 的写入触发之前命中上面的 clearTimeout，把 spinner+commit 对折叠成
      //     单次仅 commit 写入（commit 的全帧重绘反正重画了 spinner 字形）。
      //   - 之前的值是 100ms。症状：spinner 在 queue+42ms 进入外层 → 延迟在
      //     queue+142ms 触发；排空 commit 在 queue+160ms —— spinner 比 commit 早 18ms
      //     写，每个 vsync 两次 stdout 写入 = 可见闪烁。
      //   - 必须严格小于 200ms 的 spinner 跳动间隔 —— ≥200ms 时背靠背的跳动会永久
      //     重新武装定时器，spinner 会冻结。
      // 打字编辑保持原来的 8ms，让按住键的回显保持跟手。
      const deferMs = spinnerTicked ? 160 : 8
      // 在调度时捕获 flush 代数。如果 commit 路径的 doFlush() 在我们的定时器触发之前
      // 运行，flushGenRef 前进，我们的延迟帧就变得陈旧（它的单元格是从 commit 前的
      // React 状态构建的）。setImmediate 让出一个 Node tick，让同一宏任务里排队的任何
      // React commit 先 flush；然后陈旧性检查让我们短路。
      const flushId = flushGenRef.current
      deferredFlushRef.current = setTimeout(() => {
        deferredFlushRef.current = null
        deferredImmediateRef.current = setImmediate(() => {
          deferredImmediateRef.current = null
          if (flushId !== flushGenRef.current) {
            debugLog('chatinput.flush.deferred-stale', `flushId=${flushId} gen=${flushGenRef.current}`)
            return
          }
          doFlush()
          debugLog('chatinput.flush.deferred-fired', `delayed=${deferMs}ms`)
        })
      }, deferMs)
      debugLog('chatinput.flush.deferred', `non-commit frame deferred ${deferMs}ms`)
    }
  })

  // 卸载清理
  useEffect(() => {
    return () => {
      flushGenRef.current++ // eslint-disable-line react-hooks/exhaustive-deps -- invalidates callbacks queued before unmount
      if (deferredFlushRef.current !== null) {
        clearTimeout(deferredFlushRef.current)
        deferredFlushRef.current = null
      }
      if (deferredImmediateRef.current !== null) {
        clearImmediate(deferredImmediateRef.current)
        deferredImmediateRef.current = null
      }
      if (commitThrottleRef.current !== null) {
        clearTimeout(commitThrottleRef.current)
        commitThrottleRef.current = null
      }
      if (activeRef.current) {
        eraseRegion()
        activeRef.current = false
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ChatInput 不经 Ink 渲染任何东西 —— 整个底部区域由上面 useEffect 里的直接 stdout
  // 写入拥有。
  return null
}
