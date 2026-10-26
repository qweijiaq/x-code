// 渲染进程侧的 @-提及触发检测。
//
// 沙箱化渲染进程无法引入 `@x-code-cli/core`（仅限 Node），因此
// token 规则从 `packages/core/src/agent/file-completion.ts` 镜像而来。
// 保持两者同步：菜单提供的路径必须能被后端接受。

export interface MentionTrigger {
  atIdx: number
  /** `@` 与光标之间的路径片段，引号已剥离。 */
  query: string
  /** 光标处或其后的第一个空白字符（或文本末尾）。 */
  tokenEnd: number
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

export function detectMention(text: string, cursor: number): MentionTrigger | null {
  if (cursor < 0 || cursor > text.length) return null
  let atIdx = text.lastIndexOf('@', Math.max(0, cursor - 1))
  while (atIdx >= 0) {
    if (atIdx > 0 && !isWhitespace(text[atIdx - 1] ?? '')) {
      atIdx = text.lastIndexOf('@', atIdx - 1)
      continue
    }
    const quote = text[atIdx + 1]
    if (quote === '"' || quote === "'") {
      let closingQuote = -1
      for (let index = atIdx + 2; index < text.length; index++) {
        if (text[index] === quote && text[index - 1] !== '\\') {
          closingQuote = index
          break
        }
      }
      const contentStart = atIdx + 2
      const contentEnd = closingQuote >= 0 ? closingQuote : text.length
      const tokenEnd = closingQuote >= 0 ? closingQuote + 1 : text.length
      if (cursor >= contentStart && cursor <= tokenEnd) {
        return {
          atIdx,
          query: text.slice(contentStart, Math.min(cursor, contentEnd)).split(`\\${quote}`).join(quote),
          tokenEnd,
        }
      }
    } else {
      let tokenEnd = atIdx + 1
      while (tokenEnd < text.length && !isWhitespace(text[tokenEnd] ?? '')) tokenEnd++
      if (cursor >= atIdx + 1 && cursor <= tokenEnd) {
        return { atIdx, query: text.slice(atIdx + 1, cursor), tokenEnd }
      }
    }
    atIdx = atIdx === 0 ? -1 : text.lastIndexOf('@', atIdx - 1)
  }
  return null
}

/** 用选中的路径替换整个 @-token。包含空白、引号或反斜杠的路径会
 *  加上引号；光标落在结束引号之前，方便用户继续收窄目录。 */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  file: { path: string; isDirectory: boolean },
): { text: string; cursor: number } {
  const target = file.isDirectory ? `${file.path}/` : file.path
  const quoted = /\s|["\\]/.test(target)
  const insert = quoted ? `@"${target.replace(/"/g, '\\"')}"` : `@${target}`
  const before = text.slice(0, trigger.atIdx)
  const after = text.slice(trigger.tokenEnd)
  return {
    text: before + insert + after,
    cursor: before.length + insert.length - (quoted ? 1 : 0),
  }
}
