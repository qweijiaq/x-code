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

/** 与 `core` 的 `detectAtToken` 保持一致：只反转义 `\<quote>`，不还原 `\\`。*/
function unescapeQuoted(raw: string, quote: string): string {
  return raw.split(`\\${quote}`).join(quote)
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
      // 只在当前行内寻找闭引号：未闭合的 token 不应跨越换行，否则 tokenEnd
      // 会跳到后面任意一个同种引号处，调用方按 tokenEnd 替换文本时会吞掉
      // 用户已经输入的内容。
      let closingQuote = -1
      let lineEnd = text.length
      // 连续反斜杠为偶数 ⇒ 该引号未被转义（`@"dir\\"` 的闭引号仍然有效）。
      let backslashes = 0
      for (let index = atIdx + 2; index < text.length; index++) {
        const ch = text[index] ?? ''
        if (ch === '\n' || ch === '\r') {
          lineEnd = index
          break
        }
        if (ch === quote && backslashes % 2 === 0) {
          closingQuote = index
          break
        }
        backslashes = ch === '\\' ? backslashes + 1 : 0
      }
      const contentStart = atIdx + 2
      const contentEnd = closingQuote >= 0 ? closingQuote : lineEnd
      const tokenEnd = closingQuote >= 0 ? closingQuote + 1 : contentEnd
      if (cursor >= contentStart && cursor <= tokenEnd) {
        return {
          atIdx,
          query: unescapeQuoted(text.slice(contentStart, Math.min(cursor, contentEnd)), quote),
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
