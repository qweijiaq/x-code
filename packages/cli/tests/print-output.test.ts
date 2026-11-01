import { describe, expect, it } from 'vitest'

import type { TokenUsage } from '@x-code-cli/core'

import { PrintOutput, parsePrintOutputFormat } from '../src/print-output.js'

const usage: TokenUsage = {
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  cacheReadTokens: 20,
  cacheCreationTokens: 0,
  currentContextTokens: 150,
}

function capture(): { chunks: string[]; write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = []
  return { chunks, write: (chunk) => chunks.push(chunk), text: () => chunks.join('') }
}

describe('parsePrintOutputFormat', () => {
  it('defaults unknown values to text', () => {
    expect(parsePrintOutputFormat('json')).toBe('json')
    expect(parsePrintOutputFormat('jsonl')).toBe('jsonl')
    expect(parsePrintOutputFormat('yaml')).toBe('text')
    expect(parsePrintOutputFormat(undefined)).toBe('text')
  })
})

describe('PrintOutput', () => {
  it('streams text immediately in text mode and emits nothing on finish', () => {
    const out = capture()
    const output = new PrintOutput('text', out.write)
    output.textDelta('hello ')
    output.textDelta('\u001b[31mworld\u001b[0m')
    output.finish({ modelId: 'm', sessionId: 's', costUsd: 0, unpricedModels: [] })

    expect(out.text()).toBe('hello world')
    expect(output.streamedText).toBe('hello world')
  })

  it('emits exactly one result object in json mode', () => {
    const out = capture()
    const output = new PrintOutput('json', out.write)
    output.textDelta('answer')
    output.toolCall('call-1', 'readFile', { filePath: 'a.ts' })
    output.toolResult('call-1', 'contents', false)
    output.setUsage(usage)
    expect(out.chunks).toHaveLength(0)

    output.finish({ modelId: 'openai:gpt-5.6-sol', sessionId: 'session-1', costUsd: 0.02, unpricedModels: [] })

    expect(out.chunks).toHaveLength(1)
    const result = JSON.parse(out.text().trim())
    expect(result).toMatchObject({
      type: 'result',
      text: 'answer',
      modelId: 'openai:gpt-5.6-sol',
      sessionId: 'session-1',
      costUsd: 0.02,
      error: null,
    })
    expect(result.usage).toEqual(usage)
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call-1', toolName: 'readFile', input: { filePath: 'a.ts' }, result: 'contents', isError: false },
    ])
  })

  it('keeps the error out of stdout in json mode', () => {
    const out = capture()
    const output = new PrintOutput('json', out.write)
    output.setError('boom')
    output.finish({ modelId: 'm', sessionId: 's', costUsd: 0, unpricedModels: [] })

    const result = JSON.parse(out.text().trim())
    expect(result.error).toBe('boom')
    expect(out.text()).not.toContain('[error]')
  })

  it('streams one jsonl event per call and ends with done', () => {
    const out = capture()
    const output = new PrintOutput('jsonl', out.write)
    output.textDelta('hi')
    output.toolCall('call-1', 'edit', { filePath: 'a.ts' })
    output.toolResult('call-1', 'ok', false)
    output.setUsage(usage)
    output.finish({ modelId: 'm', sessionId: 's', costUsd: 0.01, unpricedModels: ['x:y'] })

    const events = out
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.type)).toEqual(['text-delta', 'tool-call', 'tool-result', 'usage', 'done'])
    expect(events[4]).toMatchObject({ costUsd: 0.01, unpricedModels: ['x:y'], toolCallCount: 1, error: null })
  })
})
