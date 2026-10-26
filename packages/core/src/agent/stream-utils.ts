// @x-code-cli/core — 流结果辅助
import type { ModelMessage } from 'ai'

/** 我们从 streamText() 结果里用到的最小形态——避免复杂的泛型传播。 */
export interface StreamResult {
  stream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
    /** 当 `type === 'error'` 时，是 SDK 包装后的提供方错误。SDK 在请求失败时
     *  不会从流迭代中抛出——它把这个 chunk 入队并关闭流。
     *  我们的 streamChunksToUI 会重新抛出，好让外层 try/catch 做分类。 */
    error?: unknown
  }>
  response: Promise<{ messages: ModelMessage[]; modelId?: string }>
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails?: {
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  finishReason: Promise<string>
  rawFinishReason?: PromiseLike<string | undefined>
  toolCalls: Promise<
    Array<{
      toolName: string
      toolCallId: string
      input: Record<string, unknown>
    }>
  >
}

/**
 * 静默消费 StreamResult 上所有挂起的 promise，以防流错误后出现未处理的拒绝。
 * 当没有完成任何 step 时，AI SDK 内部的 flush() 会用 NoOutputGeneratedError
 * 拒绝它们——若不清空，Node.js 会把完整错误倾倒到 stderr。
 */
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  if (result.rawFinishReason) Promise.resolve(result.rawFinishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
