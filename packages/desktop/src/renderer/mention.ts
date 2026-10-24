// Renderer-side @-mention trigger detection.
//
// The sandboxed renderer cannot import `@x-code-cli/core` (Node-only), so the
// token rule is mirrored from `packages/core/src/agent/file-completion.ts`.
// Keep the two in sync: a path the menu offers must be one the backend accepts.

export interface MentionTrigger {
  atIdx: number
  /** Path fragment between `@` and the cursor, quotes stripped. */
  query: string
  /** First whitespace at or after the cursor (or end of text). */
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

/** Replace the whole @-token with the picked path. Paths containing
 *  whitespace, quotes, or backslashes are quoted; the cursor lands before the
 *  closing quote so the user can keep narrowing a directory. */
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
