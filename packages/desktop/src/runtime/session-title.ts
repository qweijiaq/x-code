/** 在持久化前规范化 AI 生成的会话标题。
 *
 *  模型有时会给答案加引号、前缀 "Title:" 或输出多行。
 *  保留第一行有意义的文字，去掉包裹标点，并限制侧栏可显示的长度。
 */
export function cleanSessionTitle(raw: string): string {
  // 逐行剔除纯围栏行，而不是在整串首尾做正则：模型常常先输出一个换行再给
  // 代码块（`"\n```\n修复登录超时\n```"`），锚定在 `^`/`$` 的替换会漏掉围栏，
  // 于是标题被写成 "```"。
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^```[a-z]*$/i.test(line))
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  const withoutPrefix = firstLine.replace(/^(?:title|标题)\s*[:：]\s*/i, '')
  const trimmed = withoutPrefix
    .replace(/^[\s"'“”‘’《》]+|[\s"'“”‘’《》。.!?！？:,，;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.slice(0, 60)
}
