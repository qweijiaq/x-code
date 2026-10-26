import os from 'node:os'
import path from 'node:path'

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'

function usage(): {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
} {
  return {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 24, text: 24, reasoning: 0 },
  }
}

interface PromptInspection {
  lastUserText: string
  toolResultIds: Set<string>
}

function inspectPrompt(prompt: unknown): PromptInspection {
  let lastUserText = ''
  const toolResultIds = new Set<string>()
  if (!Array.isArray(prompt)) return { lastUserText, toolResultIds }

  for (const message of prompt as Array<{ role?: string; content?: unknown }>) {
    if (!Array.isArray(message.content)) continue
    let messageText = ''
    for (const part of message.content as Array<{ type?: string; text?: string; toolCallId?: string }>) {
      if (part?.type === 'text' && typeof part.text === 'string' && message.role === 'user') {
        messageText += part.text
      }
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResultIds.add(part.toolCallId)
      }
    }
    if (message.role === 'user' && messageText) lastUserText = messageText
  }
  return { lastUserText, toolResultIds }
}

function textStream(text: string): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  const parts = text.split(/(?<=。|\n)/)
  return {
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'demo-text' },
      ...parts.map((delta) => ({ type: 'text-delta' as const, id: 'demo-text', delta })),
      { type: 'text-end', id: 'demo-text' },
      {
        type: 'finish',
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: usage(),
      },
    ]),
  }
}

/**
 * 未配置任何 provider key 时使用的演示模型。它让桌面应用在无凭据时仍然可用，
 * 当提示词包含 `[tool-demo]` 时还能走通「写入 → 权限确认 → diff」链路；
 * `[compact-demo]` 会先失败一次（上下文溢出错误），用于验证自动压缩路径。
 *
 * 每次提交都会创建一个实例，因此 `pendingCallId` 追踪当前轮的工具调用，
 * 并在循环把工具结果回传后重置。
 */
export function createDemoModel(): MockLanguageModelV3 {
  let pendingCallId: string | null = null
  let overflowRetried = false

  return new MockLanguageModelV3({
    provider: 'demo',
    modelId: 'demo:mock',
    // 供上下文压缩（generateText）使用。保留其实现，让演示模型无需凭据
    // 也能走通「响应式溢出」路径。
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '（演示）会话摘要：之前的对话、工具调用与上下文已保留。' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: usage(),
      warnings: [],
    }),
    doStream: async (options) => {
      const { lastUserText, toolResultIds } = inspectPrompt((options as { prompt?: unknown } | undefined)?.prompt)

      if (pendingCallId && toolResultIds.has(pendingCallId)) {
        pendingCallId = null
        return textStream('演示模式下已收到工具结果。写入、权限确认和 diff 链路都正常。')
      }

      if (lastUserText.includes('[compact-demo]')) {
        if (!overflowRetried) {
          // 首次尝试以「小上下文 provider」的方式失败；核心循环应当压缩并
          // 重试，而不是把这个错误直接抛给用户。
          overflowRetried = true
          throw new Error(
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
          )
        }
        return textStream('上下文已压缩，继续。')
      }

      if (lastUserText.includes('[review-demo]') && !pendingCallId) {
        pendingCallId = `demo-edit-${Date.now()}`
        const target = path.join(process.cwd(), 'README.md')
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'demo-text' },
          { type: 'text-delta', id: 'demo-text', delta: '演示模式：修改 README.md，用于验证文档修改审核。\n' },
          { type: 'text-end', id: 'demo-text' },
          {
            type: 'tool-call',
            toolCallId: pendingCallId,
            toolName: 'edit',
            input: JSON.stringify({
              filePath: target,
              oldString: 'Attachment smoke content.',
              newString: 'Attachment smoke content.\n\nReviewed change.',
            }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage: usage(),
          },
        ]
        return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(parts) }
      }

      if (lastUserText.includes('[markdown-demo]')) {
        return textStream(
          '## 演示标题\n\n这是一段 **Markdown** 输出，带一个代码块和一张表。\n\n' +
            '```ts\nconst answer: number = 42\nconsole.log(answer)\n```\n\n' +
            '| 项目 | 值 |\n| --- | --- |\n| 工具 | readDocument |\n| 格式 | PDF |\n',
        )
      }

      if (lastUserText.includes('[subagent-demo]') && !pendingCallId) {
        pendingCallId = `demo-task-${Date.now()}`
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'demo-text' },
          { type: 'text-delta', id: 'demo-text', delta: '演示模式：派发一个子代理。\n' },
          { type: 'text-end', id: 'demo-text' },
          {
            type: 'tool-call',
            toolCallId: pendingCallId,
            toolName: 'task',
            input: JSON.stringify({
              description: 'Demo subagent',
              subagent_type: 'general-purpose',
              prompt: 'Reply with one short sentence.',
            }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage: usage(),
          },
        ]
        return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(parts) }
      }

      if (lastUserText.includes('[tool-demo]') && !pendingCallId) {
        pendingCallId = `demo-write-${Date.now()}`
        const target = path.join(os.tmpdir(), `x-code-desktop-demo-${Date.now()}.txt`)
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'demo-text' },
          {
            type: 'text-delta',
            id: 'demo-text',
            delta: '演示模式：准备写入一个临时文件，用于验证权限弹窗与 diff。\n',
          },
          { type: 'text-end', id: 'demo-text' },
          {
            type: 'tool-call',
            toolCallId: pendingCallId,
            toolName: 'writeFile',
            input: JSON.stringify({ filePath: target, content: 'x-code desktop demo\n' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage: usage(),
          },
        ]
        return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(parts) }
      }

      if (lastUserText.includes('[temp-deliverable-demo]') && !pendingCallId) {
        pendingCallId = `demo-temp-${Date.now()}`
        const target = path.join(os.tmpdir(), `x-code-desktop-deliverable-${Date.now()}.md`)
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'demo-text' },
          { type: 'text-delta', id: 'demo-text', delta: '演示模式：把一个交付物写入临时目录。\n' },
          { type: 'text-end', id: 'demo-text' },
          {
            type: 'tool-call',
            toolCallId: pendingCallId,
            toolName: 'writeFile',
            input: JSON.stringify({ filePath: target, content: '# Temp deliverable\n' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage: usage(),
          },
        ]
        return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(parts) }
      }

      const text =
        '这是演示模型（未配置 API Key）。在项目 .env 中配置任意受支持的 API Key 后重启，即可使用真实模型。\n\n输入包含 [tool-demo] 时，会触发一次写入工具调用，用来验证权限与 diff。'
      return textStream(text)
    },
  })
}
