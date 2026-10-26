import type { ModelMessage } from '../types/index.js'

type ContentPartLike = { type?: string; text?: string }

/** 从 ModelMessage 的内容中提取纯文本。CoreMessage 内容要么是字符串，要么是
 *  带类型的部件数组；这里只提取文本部件（图像/文件/工具调用走其他路径）。 */
export function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentPartLike[])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
