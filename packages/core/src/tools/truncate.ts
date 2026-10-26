// @x-code-cli/core — 工具输出截断
//
// 双预算截断（行数或字节数，哪个先到算哪个）。20/80 的头/尾切分来自
// gemini-cli；每个工具的方向来自 opencode。shell 输出只想保留头部（尾部
// 重复 prompt / 退出行，头部才承载动作），而文件读取和 grep 结果更想要
// 头+尾，这样文件顶部的上下文和最后一段都能看到。
//
// 为什么不单独设一个字符预算？对 ASCII 来说字符 == 字节，字符预算与字节
// 预算是冗余的。对非 ASCII（CJK 代码/注释），字节预算才是真正匹配各家
// provider 计费方式的 —— 它们按 UTF-8 字节计，而不是 UTF-16 码元。跑两条
// 尺寸轴（字符 + 字节）把切片逻辑变成三趟，且没有任何行为上的收益。

/** 每个结果默认的行数上限。超过它我们保留头/尾切片。 */
export const MAX_TOOL_RESULT_LINES = 2000

/** 每个结果默认的字节上限（UTF-8）。同时覆盖 ASCII 单行压缩倾倒，以及
 *  那些字符数不多但传输字节仍很可观的非 ASCII 内容。 */
export const MAX_TOOL_RESULT_BYTES = 50 * 1024

/** 切片时的头:尾比例。0.2 保留前 20% + 后 80%。 */
const DEFAULT_HEAD_RATIO = 0.2

export interface TruncateOptions {
  /** 截断生效前的最大行数。默认 {@link MAX_TOOL_RESULT_LINES}。 */
  maxLines?: number
  /** 最大字节数（UTF-8）。默认 {@link MAX_TOOL_RESULT_BYTES}。 */
  maxBytes?: number
  /**
   * 截断时保留内容的位置：
   *  - `head-tail`（默认）：保留头部 20% + 尾部 80%，丢掉中间。
   *  - `head`：只保留前 N 字节，丢掉尾部。适合流式 shell 输出 —— 尾部
   *    重复噪音（prompt、退出码）。
   *  - `tail`：只保留后 N 字节，丢掉头部。适合日志 —— 有意思的部分是
   *    最近的。
   */
  direction?: 'head-tail' | 'head' | 'tail'
  /** head-tail 模式下的头部比例。默认 {@link DEFAULT_HEAD_RATIO}。 */
  headRatio?: number
}

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/** 字节感知的切片，总是切在 UTF-8 边界上，这样不会产生替换字符。最多回退
 *  4 字节去找一个干净的边界。 */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (buf.length <= bytes) return buf
  if (direction === 'head') {
    let end = bytes
    // 回退到最后一个完整码元的起始字节：UTF-8 的续字节高位是 `10xxxxxx`；
    // 我们想在它们之前停下。
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end)
  }
  let start = buf.length - bytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

type SliceResult = {
  sliced: string
  /** `sliced` 中头结束、尾开始的字符索引（仅 head-tail 模式）。用来干净地
   *  插入截断标记。 */
  headEnd: number | null
}

function applyLineSlice(
  result: string,
  maxLines: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): { result: SliceResult; linesDropped: number } {
  const lines = result.split('\n')
  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  if (direction === 'head') {
    return {
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }
  if (direction === 'tail') {
    return {
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  const headLines = Math.max(1, Math.floor(maxLines * headRatio))
  const tailLines = maxLines - headLines
  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')
  return { result: { sliced: head + '\n' + tail, headEnd: head.length }, linesDropped: lines.length - maxLines }
}

function applyByteSlice(
  input: SliceResult,
  maxBytes: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): SliceResult {
  const buf = Buffer.from(input.sliced, 'utf-8')
  if (buf.length <= maxBytes) return input

  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))
  const tailBudget = maxBytes - headBudget
  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')
  return { sliced: head + tail, headEnd: head.length }
}

/**
 * 按行/字节预算截断工具输出。若两者都放得下则原样返回。加一行标记，让模型
 * 能区分刻意的省略与损坏的输出。
 */
export function truncateToolResult(result: string, options: TruncateOptions = {}): string {
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  const direction = options.direction ?? 'head-tail'
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  const origLines = (result.match(/\n/g)?.length ?? 0) + 1
  const origBytes = byteLength(result)
  const origChars = result.length

  if (origLines <= maxLines && origBytes <= maxBytes) return result

  // 先做行切片：为面向行的输出（grep 匹配、listDir 条目）保留结构化分块。
  // 行切之后仍可能超过字节预算 —— 比如单行超长或 CJK 密集的内容，行数其实
  // 没问题 —— 剩下的交给字节切片处理。
  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  const droppedChars = origChars - byteSlice.sliced.length
  const marker =
    lineSlice.linesDropped > 0
      ? `[truncated: ${lineSlice.linesDropped} lines / ${droppedChars.toLocaleString()} chars dropped — narrow the tool args or read specific ranges]`
      : `[truncated: ${droppedChars.toLocaleString()} chars dropped — output exceeded byte budget]`

  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }
  return `${marker}\n\n${byteSlice.sliced}`
}
