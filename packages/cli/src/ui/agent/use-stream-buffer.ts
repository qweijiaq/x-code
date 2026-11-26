// @x-code-cli/cli — 流式文本缓冲管理
//
// 增量累积在 `bufferRef` 中。每次增量后，我们寻找最新的单个 `\n` 位置，其
// 前缀不以开放的多行 markdown 结构（表格、代码围栏、列表、引用块）结尾，并把
// 到该点为止的所有内容作为 `streamingChunk` 消息提交。切割点之后的一切留在
// 缓冲中，与后续增量合并，直到找到下一个安全边界（或流结束，`flushBuffer()`
// 强制排空剩余部分）。
//
// 为什么按行（而非按段）切割：段分隔（`\n\n`）切割产生“逐块”呈现——可读，但
// 在长答案上明显显得块状。在每个安全的 `\n` 处切割会逐行落地内容，这与
// Claude Code 的做法一致（它每次增量都重渲染整个文本，只是把进行中的尾行
// 隐藏到下一个 `\n` 到来）。我们一旦提交就无法重渲染任意 scrollback，所以按行
// 切割是我们在只追加架构里能做到的最接近方案。
//
// 为什么做开放块检查：marked 的词法分析器需要在一个解析遍里拿到完整结构来
// 处理表格、代码围栏、列表串和引用块——单独提交 `| a | b |\n` 会被解析成段落
// （渲染输出里是裸管道符）；分开提交 `- item 1\n` 再 `- item 2\n` 会被解析成
// 两个各有一项的列表，中间带垂直空隙，而不是一个连贯的列表。所以边界检查会
// 只要最后一行看起来仍像开放结构的一部分，就继续持有缓冲，只有当非续行到来时
// （标题、普通段落、或明确关闭该块的空行）才释放。
//
// 一个更简单的“缓冲整个响应”的方案会彻底毁掉流式 UX。一个更简单的“无条件在
// 每个 `\n` 提交”的方案会破坏表格和列表。这个带守卫的按行切割是中间路径。
//
// 在安全边界切割之上，我们还会把一个小时间窗口内的连续提交合并成一次
// appendMessage 调用。模型常常背靠背发出 2-3 个短段落（"...整理：\n\n"、
// "---\n\n"、"## 标题\n\n"）。不合并的话，每个都变成自己的 setState →
// ChatInput 渲染 → BSU/ESU [J+redraw 负载，而在不能完美原子化 DEC 2026 同步
// 的终端上（尤其是 VS Code 内的 xterm.js），一个 vsync 窗口里的几次大重绘会
// 表现为可见闪烁。一个约 32ms 的总是延迟窗口（60Hz 下约 2 帧）短于 provider
// 典型的 80-200ms 增量间隙，远低于人类感知阈值，并让同一窗口内到达的每次提交
// 都搭乘一次 React 渲染 → 一次 stdout 写。
import { useCallback, useEffect, useRef } from 'react'

import type { DisplayMessage, ModelMessage } from '@x-code-cli/core'
import { debugLog, errorMessage } from '@x-code-cli/core'

/** 围栏行：CommonMark 允许 ``` 和 ~~~ 两种围栏字符，且围栏可以缩进最多 3 个
 *  空格（列表项里的围栏是 AI 输出中的常见形态）。只认顶格 ``` 会把 `~~~` 围栏
 *  和缩进围栏的奇偶性算成 0，于是围栏内的每一行都被当成安全边界提交，代码块
 *  被逐行拆散渲染成正文。 */
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/gm

/** 围栏行的数量（围栏开 / 闭各算一）。用 `exec` 循环计数而不是 `match()`，
 *  后者会为整个缓冲分配一个匹配数组。 */
function countFenceLines(text: string): number {
  const re = new RegExp(FENCE_LINE_RE.source, FENCE_LINE_RE.flags)
  let count = 0
  while (re.exec(text) !== null) count++
  return count
}

/** `text` 中每个围栏行的起始偏移（升序）。 */
function fenceLineOffsets(text: string): number[] {
  const re = new RegExp(FENCE_LINE_RE.source, FENCE_LINE_RE.flags)
  const offsets: number[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) offsets.push(match.index)
  return offsets
}

/** `offsets`（升序）中 <= `position` 的元素个数——即某个前缀里包含的围栏行数。 */
function countOffsetsAtOrBefore(offsets: number[], position: number): number {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (offsets[mid]! <= position) low = mid + 1
    else high = mid
  }
  return low
}

/** `text` 是否以一个开放的多行 markdown 结构结尾，而渲染器需要完整结构才能
 *  正确格式化？
 *
 *  我们只持有那些在中途被拆分会真正破坏视觉渲染的结构：
 *
 *  - 代码围栏：围栏行（顶格或缩进 <= 3 空格的 ``` / ~~~）的数量为奇数 = 围栏
 *    开放。在开放围栏内切割会把部分代码渲染成普通散文，并丢失等宽块上下文。
 *    两种围栏字符各自闭合在 CommonMark 里有明确规定，但跨提交只保留奇偶性
 *    （见 `fenceCarry`）——把 ``` 和 ~~~ 混用成一对的情况在模型输出里可以忽略，
 *    而漏算 `~~~` / 缩进围栏的代价是整个代码块被逐行拆散。
 *  - 表格：最后一个非空行以 `|` 开头。GFM 表格要求表头 + 分隔行 + 数据行在
 *    一次词法分析遍里；在表格中途切割会把不完整的行渲染成裸的 `| a | b |` 文本。
 *
 *  列表（有序、无序）和引用块被刻意不在这里持有——逐行提交它们仍与整块版本
 *  渲染一致。每个 `- item N\n` 独立解析成一个一项列表，渲染成 `• item N\n`，
 *  把它们拼接起来与解析完整列表是同样的字节流（`- a\n- b\n` → `• a\n• b\n`）。
 *  对 `> line\n` 引用也一样（每个解析成 `▎ line\n`）。微小的代价——带惰性续行
 *  的多行列表项会把续行渲染成单独的缩进段落——在 AI 输出里很少见，而流式体验
 *  的收益很大：列表项在模型发出时一项一项出现，而不是作为一个完成块弹出。 */
export function hasOpenCodeFence(text: string, fenceCarry = 0): boolean {
  // `fenceCarry` 是「已经提交出去、但仍未闭合」的围栏奇偶性（0 或 1）。强制中间
  // 提交会把开栏那一行连同代码一起送走，此后缓冲里只剩围栏内部的行——若不计入
  // carry，模型发出闭栏时缓冲里的 ``` 计数为奇数，会被误判成「围栏刚打开」，于是
  // 闭栏之后的全部正文都滞留在缓冲里直到回合结束才一次性吐出（长代码块之后流式
  // UX 完全失效），而 flush 出的那条消息以 ``` 开头又会被渲染器当成开栏，把正文
  // 整段渲染成代码块。
  return (fenceCarry + countFenceLines(text)) % 2 !== 0
}

export function hasOpenMarkdownBlock(text: string, fenceCarry = 0): boolean {
  if (hasOpenCodeFence(text, fenceCarry)) return true

  const lines = text.split('\n')
  // 剥掉 `split('\n')` 为以换行结尾的文本产生的那一个尾随 ''——那是 split 的
  // 伪影，不是真正的空行。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1]
  if (lastLine.trim() === '') return false
  if (lastLine.trimStart().startsWith('|')) return true
  return false
}

/** 返回 `text` 中最新安全单个 `\n` 之后的位置，如果不存在则返回 -1。“安全”
 *  意味着到那个 `\n` 为止的前缀不以开放的多行块结尾——提交该前缀能给 markdown
 *  渲染器一个它可以完整格式化的内容。
 *
 *  从末尾向后扫描，这样第一个命中就是最新的安全切割点（无需遍历每个换行去
 *  追踪最大值）。每个候选位置都在 O(log 围栏数) 内判定：围栏奇偶性来自一次
 *  预处理（围栏行偏移表 + 二分），表格判定只看该候选所在的那一行。旧实现对每个
 *  候选换行都复制整个前缀并跑一遍全文围栏正则，在长代码围栏 / 长表格上（正是
 *  需要持有的场景）每次增量都退化成 O(候选数 × 缓冲长度)，会卡住 UI 线程。 */
export function findSafeBoundary(text: string, fenceCarry = 0): number {
  const fenceOffsets = fenceLineOffsets(text)
  let scan = text.length
  while (scan > 0) {
    const found = text.lastIndexOf('\n', scan - 1)
    if (found < 0) return -1
    // 前缀（到该 `\n` 含）里的围栏数：奇数 = 围栏仍开放，不能在这里切。
    if ((fenceCarry + countOffsetsAtOrBefore(fenceOffsets, found)) % 2 === 0) {
      const lineStart = text.lastIndexOf('\n', found - 1) + 1
      const lastLine = text.slice(lineStart, found)
      // 非空且以 `|` 开头 = 表格里的行；GFM 表格必须在一次词法分析里拿全。
      if (lastLine.trim() === '' || !lastLine.trimStart().startsWith('|')) {
        return found + 1
      }
    }
    scan = found
  }
  return -1
}

// 当代码围栏开放时，正常的 `\n\n` 安全边界逻辑会一直持有所有内容直到围栏
// 关闭。对长代码块（100+ 行）这会产生一次巨大的提交，其预滚动的 `\n` 会在终端
// scrollback 中留下可见的空行。为避免这一点，当缓冲在开放代码围栏内超过这个
// 阈值时，我们强制一次基于行的提交。markdown 渲染器的 `code` token 处理器
// 输出原始文本，所以围栏内拆分在视觉上完全一致——但每条提交出去的消息必须
// 自身围栏平衡（见 `balanceFenceChunk`），否则闭栏会被单独一条消息里的
// marked.lexer 当成开栏，把其后的正文整段渲染成代码块。
const CODE_FENCE_COMMIT_THRESHOLD = 800

/** 补围栏用的字面量。语言提示不跨提交保存，所以补回的是无语言裸围栏——渲染器
 *  对未知语言原样输出代码文本，与围栏内逐行提交的视觉效果一致。 */
const FENCE_LINE = '```\n'

/** 把一次提交的内容补成「围栏自平衡」的块。
 *
 *  每条 streamingChunk 消息都会被 marked 独立词法分析，跨消息的未闭合围栏因此
 *  会被当成「本条消息里的开栏」：闭栏 ``` 落在后续消息里时，它把该消息余下的
 *  全部正文渲染成代码块（`fenceCarry` 只修正「是否继续持有」的判定，修不了已经
 *  拆开的消息）。所以在强制中间提交 / 冲刷这些会跨围栏切分的地方，把每条消息
 *  补成自平衡的：
 *
 *  - `insideAtStart`：本条消息的起点仍在上一条消息遗留的围栏内，先补一个开栏，
 *    否则本条里的闭栏会被解析成开栏；
 *  - 补完之后若仍处于围栏内，再补一个闭栏收尾。 */
export function balanceFenceChunk(chunk: string, insideAtStart: boolean): string {
  const fences = countFenceLines(chunk) + (insideAtStart ? 1 : 0)
  let text = insideAtStart ? FENCE_LINE + chunk : chunk
  if (fences % 2 !== 0) text += FENCE_LINE
  return text
}

/**
 * 安全网：从循环状态里最近的 assistant 消息中提取文本。用于当流没有产生任何
 * 文本增量事件，但最终响应消息仍携带文本时显示回复（例如某些 reasoning 模型
 * provider 把一切都放在最后一个部件里）。
 */
export function extractLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const part of content as Array<{ type: string; text?: string }>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
    return parts.join('')
  }
  return ''
}

export interface StreamBufferApi {
  /** 接受来自 agent 循环的文本增量。为滚动缓冲中每个完整行（以 `\n` 结尾的
   *  子串）发出一条 streamingChunk 消息；尾部的部分行保持缓冲。 */
  appendTextDelta: (delta: string) => void
  /** 把任何剩余的部分行作为最终 streamingChunk 发出。在工具调用 / 回合结束
   *  边界调用以排空缓冲。 */
  flushBuffer: () => void
  /** 丢弃任何已缓冲的文本而不发出。 */
  resetBuffer: () => void
}

let streamChunkSeq = 0

function makeStreamChunkMessage(content: string): DisplayMessage {
  return {
    id: `stream-${Date.now()}-${streamChunkSeq++}`,
    role: 'assistant',
    content,
    streamingChunk: true,
    timestamp: Date.now(),
  }
}

/** 用于合并提交的总是延迟窗口。安静期内的第一次提交启动一个定时器；在它触发
 *  前到达的任何进一步提交都加入同一次发出。150ms 低于约 200ms 的人类感知
 *  “卡顿”阈值，但足以吸收大多数段落 + 分隔符 + 标题突发（它们通常在节边界
 *  附近以 30-150ms 的间隔到达）。相比之前的 48ms 窗口，把大规模终端帧重绘
 *  的速率大致减半——流式期间实时 scrollback 区域“抖动”的频率减半，代价是
 *  段落以略微更块状的批次出现。 */
const COMMIT_BATCH_MS = 150

export function useStreamBuffer(appendMessage: (msg: DisplayMessage) => void): StreamBufferApi {
  /** 累积缓冲——持有自上次安全边界提交（或上次冲刷）以来的所有内容。 */
  const bufferRef = useRef<string>('')
  /** 等待合并进一次 appendMessage 调用的安全边界块。延迟定时器触发时（或
   *  flushBuffer 排空时）清空。 */
  const pendingChunksRef = useRef<string[]>([])
  /** 触发延迟发出的定时器。无待处理时为空。 */
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 已提交出去但仍未闭合的代码围栏数（0 或 1）。强制中间提交会把开栏行随代码
   *  一起送走，缓冲里于是只剩围栏内部的行；把这个奇偶性计入判定，闭栏到达时才
   *  能识别出「围栏已关闭」，让闭栏之后的正文恢复逐行提交。 */
  const fenceCarryRef = useRef(0)
  /** 最新的 `appendMessage`。延迟发出的定时器跨越 150ms 窗口，期间父组件可能
   *  重渲染并传入新的回调；闭包捕获旧回调会让这次 emit 打到过期对象上。 */
  const appendMessageRef = useRef(appendMessage)
  useEffect(() => {
    appendMessageRef.current = appendMessage
  }, [appendMessage])

  const drainPending = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const chunks = pendingChunksRef.current
    if (chunks.length === 0) return
    pendingChunksRef.current = []
    // 单个块 → 原样复用，避免不必要的 join 分配（段落干净落定后的常见情况）。
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.emit', `chunks=${chunks.length} chars=${combined.length}`)
    try {
      appendMessageRef.current(makeStreamChunkMessage(combined))
    } catch (error) {
      // 定时器回调里的异常在 Node CLI 中是未捕获异常：会直接终止进程并连带丢掉
      // 整段回复。提交失败只影响这一批文本，上报后继续，让后续增量照常流动。
      debugLog('buffer.emit-failed', `${errorMessage(error)} chars=${combined.length}`)
    }
  }, [])

  const queueChunk = useCallback(
    (chunk: string) => {
      pendingChunksRef.current.push(chunk)
      if (emitTimerRef.current === null) {
        emitTimerRef.current = setTimeout(drainPending, COMMIT_BATCH_MS)
      }
      // 定时器已武装——块搭乘现有截止时间，这样长时间突发不会无限延长等待。
    },
    [drainPending],
  )

  const appendTextDelta = useCallback(
    (delta: string) => {
      if (!delta) return
      debugLog('buffer.append', `chars=${delta.length} bytes=${Buffer.byteLength(delta, 'utf8')}`)
      bufferRef.current += delta
      const boundary = findSafeBoundary(bufferRef.current, fenceCarryRef.current)
      if (boundary > 0) {
        const chunk = bufferRef.current.slice(0, boundary)
        bufferRef.current = bufferRef.current.slice(boundary)
        const insideAtStart = fenceCarryRef.current === 1
        fenceCarryRef.current = (fenceCarryRef.current + countFenceLines(chunk)) % 2
        debugLog('buffer.commit', `chars=${chunk.length}`)
        // 切点之前已经提交出去的围栏还没有闭合时，这条消息自身必须补齐围栏：
        // 否则它里面的闭栏会被当成开栏，把余下正文渲染成代码块。
        queueChunk(balanceFenceChunk(chunk, insideAtStart))
      } else if (
        bufferRef.current.length > CODE_FENCE_COMMIT_THRESHOLD &&
        hasOpenCodeFence(bufferRef.current, fenceCarryRef.current)
      ) {
        // 大型开放代码围栏——在最后一个换行处强制一次中间提交，这样终端不必
        // 一次性预滚动 100+ 空行。这里刻意用「最后一个换行」（含 `\n\n` 对里的
        // 那一个）：安全边界分支刚好在本轮找不到任何安全点时才走到这里。
        const lastNL = bufferRef.current.lastIndexOf('\n')
        if (lastNL > 0) {
          const chunk = bufferRef.current.slice(0, lastNL + 1)
          bufferRef.current = bufferRef.current.slice(lastNL + 1)
          const insideAtStart = fenceCarryRef.current === 1
          // 围栏奇偶性跟着已提交的内容走，缓冲里留下的行不再自带开栏行。
          fenceCarryRef.current = (fenceCarryRef.current + countFenceLines(chunk)) % 2
          debugLog('buffer.commit', `chars=${chunk.length} (fence-split)`)
          // 每条消息补成围栏自平衡：缓冲里剩下的行不再带开栏行，闭栏到来时会
          // 落在后续某条消息里——不补齐的话它会被当成开栏。
          queueChunk(balanceFenceChunk(chunk, insideAtStart))
        }
      }
    },
    [queueChunk],
  )

  const flushBuffer = useCallback(() => {
    // 回合结束 / 工具调用边界——不再有增量到来，所以排空剩下的任何内容（即便
    // 是一个未关闭的表格，也没有更多可持有的了）。把待处理块 + 剩余部分合并成
    // 一条消息：分开发出它们会产生两次背靠背的 setState → 渲染 → 冲刷循环，
    // 而这正是批处理要避免的闪烁。
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    const remainder = bufferRef.current
    const insideAtStart = fenceCarryRef.current === 1
    bufferRef.current = ''
    // 回合结束：剩余内容整体送出，围栏状态不再跨越本轮。
    fenceCarryRef.current = 0
    if (remainder) pendingChunksRef.current.push(balanceFenceChunk(remainder, insideAtStart))
    if (pendingChunksRef.current.length === 0) return
    const chunks = pendingChunksRef.current
    pendingChunksRef.current = []
    const combined = chunks.length === 1 ? chunks[0] : chunks.join('')
    debugLog('buffer.commit', `chars=${combined.length} (flush)`)
    appendMessage(makeStreamChunkMessage(combined))
  }, [appendMessage])

  const resetBuffer = useCallback(() => {
    if (emitTimerRef.current !== null) {
      clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
    }
    pendingChunksRef.current = []
    bufferRef.current = ''
    fenceCarryRef.current = 0
  }, [])

  useEffect(
    () => () => {
      if (emitTimerRef.current !== null) clearTimeout(emitTimerRef.current)
      emitTimerRef.current = null
      pendingChunksRef.current = []
      bufferRef.current = ''
      fenceCarryRef.current = 0
    },
    [],
  )

  return { appendTextDelta, flushBuffer, resetBuffer }
}
