/** Normalize an AI-generated session title before persisting it.
 *
 *  Models sometimes wrap the answer in quotes, prefix it with "Title:" or
 *  emit multiple lines. Keep the first meaningful line, strip wrapping
 *  punctuation and cap the length the sidebar can display.
 */
export function cleanSessionTitle(raw: string): string {
  const firstLine = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  const withoutPrefix = firstLine.replace(/^(?:title|标题)\s*[:：]\s*/i, '')
  const trimmed = withoutPrefix
    .replace(/^[\s"'“”‘’《》]+|[\s"'“”‘’《》。.!?！？:,，;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.slice(0, 60)
}
