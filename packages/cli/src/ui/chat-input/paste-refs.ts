// @x-code-cli/cli — 粘贴引用辅助函数。
//
// 大段粘贴不会内联显示在输入框里。我们把完整内容存进一个 map，并在其位置显示一个
// 类似 `[Pasted text #2 +217 lines]` 的占位符。按 Enter 时，占位符会先展开回完整
// 内容，再交给 agent。仿照 Claude Code 的 PromptInput。

interface PastedEntry {
  id: number
  content: string
  lineCount: number
}

export type PastedContents = Record<number, PastedEntry>

/** 在字符串任意位置查找粘贴引用的正则（提交时使用）。 */
const REF_ANY_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

/** 检查字符串是否以粘贴引用结尾的正则（退格时使用）。 */
const REF_TAIL_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]$/

export function formatPasteRef(id: number, lineCount: number): string {
  if (lineCount <= 1) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${lineCount} lines]`
}

/**
 * 把 `text` 里每个 `[Pasted text #N …]` 引用替换成 `contents` 里存储的真实内容。
 * id 缺失的引用保持原样。
 */
export function expandPasteRefs(text: string, contents: PastedContents): string {
  return text.replace(REF_ANY_RE, (match, idStr: string) => {
    const id = Number(idStr)
    const entry = contents[id]
    return entry ? entry.content : match
  })
}

/**
 * 如果 `text` 以粘贴引用占位符结尾，返回去掉该引用后的文本加上被移除条目的 id
 * （这样调用方可以从 pasted-contents map 里删掉它）。否则返回 null——调用方应回退
 * 到删除单个字符。
 */
export function stripTrailingRef(text: string): { without: string; id: number } | null {
  const m = text.match(REF_TAIL_RE)
  if (!m) return null
  return {
    without: text.slice(0, text.length - m[0].length),
    id: Number(m[1]),
  }
}
