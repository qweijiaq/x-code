/** 在持久化前规范化 AI 生成的会话标题。
 *
 *  模型有时会给答案加引号、前缀 "Title:" 或输出多行。
 *  保留第一行有意义的文字，去掉包裹标点，并限制侧栏可显示的长度。
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
