// @x-code-cli/core — Edit 工具的 diff 负载。
//
// 由 tool-execution 在 writeFile / edit 成功写入后计算，并通过
// AgentCallbacks.onFileEdit 发给 UI，这样 scrollback 行就能在
// 工具条目下方渲染彩色 diff 块（对应 Claude Code 的
// `Update(file)` → `Added X lines, removed Y` 视图）。
//
// 模型看到的仍然是 executeWriteTool 返回的短结果字符串
// （`File edited: ...`）——diff 负载只是 UI 侧的旁路通道，
// 绝不会经 state.messages 往返。
import { structuredPatch } from 'diff'

/** 一个连续的 diff hunk。镜像 `diff` 包的 `StructuredPatchHunk`
 *  结构，但在此处重新定义，这样消费方无需为类型化负载而引入
 *  `diff` 这个 peer 依赖。`lines` 中的每一项都带一个前导 sigil
 *  字符：`' '`（上下文）、`'+'`（新增）、`'-'`（删除）。 */
export interface EditDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface EditDiffPayload {
  filePath: string
  hunks: EditDiffHunk[]
  additions: number
  removals: number
  /** 文件在写入前不存在时为 true——UI 用它把标题从
   *  "Added X lines, removed Y" 切换为 "Created N lines"，
   *  并渲染内容预览，而不是（空的）hunk 列表。 */
  isCreate: boolean
  /** 完整的文件新内容。为 create 负载填充，这样 UI 能在
   *  "Created N lines" 标题下把前约 10 行渲染为预览
   *  （对应 Claude Code 的 FileWriteToolCreatedMessage）。对 update 负载
   *  保持 undefined——已经有 hunk 列表可展示了。 */
  content?: string
  /** 桌面端 "revert this edit" 动作使用的快照。只有当文件足够小、
   *  能放进事件流时才附带；对超大文件省略，此时 UI 会禁用
   *  针对单次编辑的 revert。 */
  beforeContent?: string
  afterContent?: string
}

const CONTEXT_LINES = 3
const DIFF_TIMEOUT_MS = 5_000
/** 单次编辑 revert 快照的上限。更大的文件仍可编辑，但会失去
 *  一键 revert（UI 会隐藏该动作）。 */
const MAX_REVERT_SNAPSHOT_CHARS = 2_000_000

/**
 * 为单个文件变更构建结构化 patch + 计数。当实际上没有发生任何
 * 变化（writeFile 内容完全相同）时返回 `null`，这样调用方可以
 * 完全省略 diff 显示。对全新文件传入 `oldContent: null`——该辅助函数
 * 仍会计算出一个无 hunk 的负载，其 `additions = lineCount(newContent)`。
 */
export function computeEditDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
): EditDiffPayload | null {
  if (oldContent === null) {
    return {
      filePath,
      hunks: [],
      additions: countLines(newContent),
      removals: 0,
      isCreate: true,
      content: newContent,
      ...(newContent.length <= MAX_REVERT_SNAPSHOT_CHARS ? { afterContent: newContent } : {}),
    }
  }

  if (oldContent === newContent) return null

  const result = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  })

  // 超时时 structuredPatch 返回假值。变更确实已落到磁盘；
  // 我们只是拿不到 hunk 视图，所以回退为逐行推导的纯计数摘要。
  // 这比丢弃负载更好（否则 UI 会静默跳过 diff 块）。
  const hunks: EditDiffHunk[] = result?.hunks ? result.hunks.map(toHunk) : []

  let additions = 0
  let removals = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  }

  if (additions === 0 && removals === 0 && hunks.length === 0) {
    // 超时且没有 hunk——手动按行计数，让标题仍然有意义。
    // 近似：新增 max(0, newLines - oldLines) 行，
    // 删除 max(0, oldLines - newLines) 行。对纯替换不够精确，
    // 但在无法计算真实 diff 的情况下是诚实的。
    const oldLines = countLines(oldContent)
    const newLines = countLines(newContent)
    additions = Math.max(0, newLines - oldLines)
    removals = Math.max(0, oldLines - newLines)
  }

  return {
    filePath,
    hunks,
    additions,
    removals,
    isCreate: false,
    ...(oldContent.length <= MAX_REVERT_SNAPSHOT_CHARS ? { beforeContent: oldContent } : {}),
    ...(newContent.length <= MAX_REVERT_SNAPSHOT_CHARS ? { afterContent: newContent } : {}),
  }
}

function toHunk(h: {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}): EditDiffHunk {
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }
}

/** 统计可见行数，把单个尾部 `\n` 视为终止符
 *  （与编辑器给行编号的方式一致：3 行文件无论是否以换行结尾都算 3 行）。 */
function countLines(s: string): number {
  if (s.length === 0) return 0
  const parts = s.split('\n')
  return s.endsWith('\n') ? parts.length - 1 : parts.length
}
