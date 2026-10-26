// agent/tool-result-sanitize.ts 的测试
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { repairOrphanToolCalls, truncateToolResultsInMessages } from '../src/agent/tool-result-sanitize.js'

function assistantToolCallMsg(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  } as ModelMessage
}

function toolResultMsg(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

function toolMsg(toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tc',
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as ModelMessage
}

describe('truncateToolResultsInMessages', () => {
  it('truncates an oversized readFile result in place', () => {
    const huge = 'line\n'.repeat(5000) // 5000 行，超过默认的 2000
    const messages: ModelMessage[] = [toolMsg('readFile', huge)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    expect(after.length).toBeLessThan(huge.length)
    expect(after).toMatch(/truncated/)
  })

  it('applies head-only policy to grep', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `match-${i}: something`).join('\n')
    const messages: ModelMessage[] = [toolMsg('grep', lines)]
    truncateToolResultsInMessages(messages)
    const after = (messages[0].content as unknown as Array<{ output: { value: string } }>)[0].output.value
    // grep 策略是只保留头部；尾部不应被保留
    expect(after).toContain('match-0')
    expect(after).not.toContain('match-1999')
  })

  it('leaves non-tool messages untouched', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(100000) } as ModelMessage,
      toolMsg('readFile', 'short'),
    ]
    truncateToolResultsInMessages(messages)
    expect((messages[0].content as string).length).toBe(100000)
  })

  it('handles content-type output arrays with text entries', () => {
    const huge = 'x'.repeat(100000)
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc',
            toolName: 'readFile',
            output: {
              type: 'content',
              value: [{ type: 'text', text: huge }],
            },
          },
        ],
      } as ModelMessage,
    ]
    truncateToolResultsInMessages(messages)
    const entry = (messages[0].content as unknown as Array<{ output: { value: Array<{ text: string }> } }>)[0].output
      .value[0]
    expect(entry.text.length).toBeLessThan(huge.length)
  })
})

describe('repairOrphanToolCalls', () => {
  it('appends a synthetic error result for an assistant tool_call with no result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      assistantToolCallMsg('tc1', 'todoWrite'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const synth = messages[2]
    expect(synth.role).toBe('tool')
    const part = (synth.content as unknown as Array<{ toolCallId: string; output: { value: string } }>)[0]
    expect(part.toolCallId).toBe('tc1')
    expect(part.output.value).toMatch(/Tool input failed validation/)
  })

  it('drops a tool_result whose toolCallId never appeared in any assistant message', () => {
    // SDK 拒绝了模型的畸形 tool input → response.messages 中没有
    // tool_call，但 processToolCalls 仍然运行了工具并推送了一个
    // tool_result。这个孤儿绝不能进入下一次 API 请求体。
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: 'plain reply, no tool call' } as ModelMessage,
      toolResultMsg('orphan-id', 'todoWrite', 'Todo list updated.'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  it('keeps a tool_result whose toolCallId is fulfilled and drops only the orphan part', () => {
    // 混合 tool 消息：同一个 tool 消息里一个有效结果 + 一个孤儿。
    // 只有孤儿应该被过滤；有效部分（以及周围的
    // 消息结构）必须保留。
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc-valid', 'readFile'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-valid',
            toolName: 'readFile',
            output: { type: 'text', value: 'file contents' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc-orphan',
            toolName: 'todoWrite',
            output: { type: 'text', value: 'orphan result' },
          },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    const parts = messages[1].content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0].toolCallId).toBe('tc-valid')
  })

  it('is idempotent — running twice produces the same result', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'todoWrite'),
      toolResultMsg('orphan', 'shell', 'orphan'),
    ]
    repairOrphanToolCalls(messages)
    const first = messages.length
    repairOrphanToolCalls(messages)
    expect(messages.length).toBe(first)
    // tc1 的前向孤儿合成结果必须仍然存在。
    const ids = messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Array<{ toolCallId?: string }>) : []))
      .map((p) => p.toolCallId)
      .filter(Boolean)
    expect(ids).toContain('tc1')
    expect(ids).not.toContain('orphan')
  })

  it('leaves a fully valid sequence untouched', () => {
    const messages: ModelMessage[] = [
      assistantToolCallMsg('tc1', 'readFile'),
      toolResultMsg('tc1', 'readFile', 'file body'),
      assistantToolCallMsg('tc2', 'shell'),
      toolResultMsg('tc2', 'shell', 'shell output'),
    ]
    const before = JSON.stringify(messages)
    repairOrphanToolCalls(messages)
    expect(JSON.stringify(messages)).toBe(before)
  })

  // Bug 1：只含孤儿、且夹在两个 assistant 之间的 tool 消息绝不能
  // 被 splice——那会留下 assistant→assistant，Anthropic 会以
  // "messages: roles must alternate" 返回 400。改用
  // user 文本占位符替换。
  it('replaces empty-orphan tool message with user placeholder when between two assistants', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'doing it' }] } as ModelMessage,
      toolResultMsg('orphan_1', 'shell', 'stale'),
      { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(4)
    expect(messages[2].role).toBe('user')
    const blocks = messages[2].content as Array<{ type: string; text?: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toMatch(/stale tool result/i)
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // Bug 1 边界：当至少一个邻居不是 assistant 时，
  // 丢弃孤儿 tool 消息仍然是正确的（splice 不会制造
  // assistant→assistant 的间隔）。
  it('still splices the orphan tool message when neighbors are not both assistant', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] } as ModelMessage,
      toolResultMsg('orphan_x', 'shell', 'stale'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
  })

  // Bug 2：多个前向孤儿 tool_call 必须折叠成一条
  // 尾随 tool 消息，而不是 N 条相邻 tool 消息。Anthropic
  // SDK 目前恰好会合并连续同角色消息，但 Google 转换器不会——
  // 只发一条 tool 消息才是与 provider 无关的安全形态。
  it('collapses multiple forward-orphan synthetics into a single tool message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do two things' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_a', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_b', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    expect(parts).toHaveLength(2)
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_a', 'tc_b'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  // Bug 2 纵深防御：如果尾部已经有一条 tool 消息
  // （例如 processToolCalls 在同一轮为已满足的 tool_call
  // 推送了真实结果），孤儿合成结果应合并进它，
  // 而不是生成新的相邻 tool 消息。
  it('merges synthetic results into an existing trailing tool message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_done', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc_orphan', toolName: 'shell', input: {} },
        ],
      } as ModelMessage,
      toolResultMsg('tc_done', 'shell', 'ok'),
    ]
    repairOrphanToolCalls(messages)
    expect(messages).toHaveLength(3)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('tool')
    const parts = last.content as unknown as Array<{ toolCallId: string }>
    const ids = parts.map((p) => p.toolCallId).sort()
    expect(ids).toEqual(['tc_done', 'tc_orphan'])
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role)
    }
  })

  it('relocates user message wedged between assistant tool_calls and tool results', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do stuff' } as ModelMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', input: {} },
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'task', input: {} },
        ],
      } as ModelMessage,
      toolResultMsg('tc1', 'shell', 'done'),
      { role: 'user', content: '[Request interrupted by user for tool use]' } as ModelMessage,
      toolResultMsg('tc2', 'task', 'sub-agent result'),
    ]
    repairOrphanToolCalls(messages)
    // user 消息必须出现在所有 tool 结果之后
    const roles = messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
  })
})
