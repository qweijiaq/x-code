// @x-code-cli/core — Document library text helpers.
//
// Tokenisation is deliberately simple and dependency-free: latin words plus
// CJK character bigrams. That is enough for keyword recall on mixed Chinese /
// English documents without shipping a tokenizer or a dictionary.

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(match[0])
  for (const match of lower.matchAll(/[㐀-䶿一-鿿]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

export interface TextChunk {
  start: number
  text: string
}

const DEFAULT_CHUNK_CHARS = 800
const DEFAULT_OVERLAP_CHARS = 120

/** Split text into overlapping chunks, preferring paragraph / line
 *  boundaries so a chunk rarely starts mid-sentence. */
export function chunkText(text: string, options: { maxChars?: number; overlap?: number } = {}): TextChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_CHARS
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 3))
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return []
  if (normalized.length <= maxChars) return [{ start: 0, text: normalized }]

  const chunks: TextChunk[] = []
  let cursor = 0
  while (cursor < normalized.length) {
    const hardEnd = Math.min(normalized.length, cursor + maxChars)
    let end = hardEnd
    if (hardEnd < normalized.length) {
      const window = normalized.slice(cursor + Math.floor(maxChars * 0.6), hardEnd)
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('\n'))
      if (boundary > 0) end = cursor + Math.floor(maxChars * 0.6) + boundary + 1
    }
    const text = normalized.slice(cursor, end).trim()
    if (text) chunks.push({ start: cursor, text })
    if (end >= normalized.length) break
    cursor = Math.max(cursor + 1, end - overlap)
  }
  return chunks
}

/** Find a short excerpt around the best-matching query term. */
export function buildSnippet(text: string, terms: string[], maxChars = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const lower = flat.toLowerCase()
  let best = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0 && (best === -1 || index < best)) best = index
  }
  if (best === -1) return `${flat.slice(0, maxChars)}…`
  const start = Math.max(0, best - Math.floor(maxChars / 3))
  const end = Math.min(flat.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
