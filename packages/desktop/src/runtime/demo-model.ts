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
 * Demo model used when no provider key is configured. It keeps the desktop app
 * usable without credentials and can exercise the write → permission → diff
 * path when the prompt contains `[tool-demo]`. `[compact-demo]` fails once
 * with a context-overflow error so the auto-compaction path can be verified.
 *
 * One instance is created per submit, so `pendingCallId` tracks the current
 * turn's tool call and resets after the loop feeds the tool result back.
 */
export function createDemoModel(): MockLanguageModelV3 {
  let pendingCallId: string | null = null
  let overflowRetried = false

  return new MockLanguageModelV3({
    provider: 'demo',
    modelId: 'demo:mock',
    // Used by context compaction (generateText). Keeping it implemented lets
    // the demo exercise the reactive overflow path without credentials.
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
          // First attempt fails the way a small-context provider does; the
          // core loop must compact and retry instead of surfacing this.
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

      const text =
        '这是演示模型（未配置 API Key）。在项目 .env 中配置任意受支持的 API Key 后重启，即可使用真实模型。\n\n输入包含 [tool-demo] 时，会触发一次写入工具调用，用来验证权限与 diff。'
      return textStream(text)
    },
  })
}
