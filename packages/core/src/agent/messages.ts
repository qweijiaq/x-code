// @x-code-cli/core — 消息类型与辅助函数
import type { ModelMessage } from 'ai'

import { errorMessage } from '../utils.js'

export interface ToolImage {
  data: string
  mediaType: string
}

/** 创建工具结果消息。当提供了 `images`（例如来自 MCP 工具的浏览器
 *  截图）时，输出切换为多模态的 `content` 形式，让具备视觉能力的模型
 *  真正看到它们；文本保留为前导的 text part。AI SDK v7 用带标签的
 *  `file` part 承载工具结果中的内联 base64 图片；纯文本提供商则由
 *  downgradeBinaryPartsForProvider 在上游把媒体剥离/OCR 掉。
 *  对于占绝大多数的纯文本结果，纯字符串路径保持不变。 */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: string,
  images?: readonly ToolImage[],
  isError = false,
): ModelMessage {
  const output =
    images && images.length > 0
      ? {
          type: 'content' as const,
          value: [
            ...(result ? [{ type: 'text' as const, text: result }] : []),
            ...images.map((img) => ({
              type: 'file' as const,
              data: { type: 'data' as const, data: img.data },
              mediaType: img.mediaType,
            })),
          ],
        }
      : isError
        ? { type: 'error-text' as const, value: result }
        : { type: 'text' as const, value: result }
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output,
      },
    ],
  }
}

export function structuredToolResultMessage(toolCallId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output } as never],
  }
}

/** 为 `tool` 角色是纯文本的 Chat Completions 提供商重新附着
 *  工具返回的媒体。提供商转换器会把 image FilePart 转成
 *  线上的 image URL。 */
export function toolMediaUserMessage(images: readonly ToolImage[]): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Attached media from tool result:' },
      ...images.map((image) => ({
        type: 'file' as const,
        data: { type: 'data' as const, data: image.data },
        mediaType: image.mediaType,
      })),
    ],
  }
}

/** 从工具返回给模型的标准错误字符串。"Error: " 前缀是承重的——
 *  handleToolCall 通过 isToolErrorString 检查它，把 scrollback 行
 *  翻转为红色，而模型本身也学会了把它读作失败标记。 */
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** 把抛出的 / 未知的值包装成标准工具错误字符串。 */
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(errorMessage(err))
}

/** 匹配 toolErrorString 产生的结果字符串前缀。 */
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}
