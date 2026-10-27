import { describe, expect, it } from 'vitest'

import { BackgroundTaskRegistry } from '../src/agent/background-tasks.js'
import type { SubAgentRegistry } from '../src/agent/sub-agents/registry.js'
import { createTaskTool } from '../src/tools/task.js'

describe('background task registry', () => {
  it('tracks running tasks, combines abort signals, and records completion', () => {
    const registry = new BackgroundTaskRegistry()
    const parent = new AbortController()
    const { task, signal } = registry.start({
      toolCallId: 'call-1',
      agentName: 'general-purpose',
      description: 'Long review',
      parentSignal: parent.signal,
    })

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ id: task.id, status: 'running' })
    expect(signal.aborted).toBe(false)

    const finished = registry.complete(task.id, {
      status: 'completed',
      resultText: 'done',
      turnCount: 3,
      toolCallCount: 4,
    })
    expect(finished).toMatchObject({ status: 'completed', resultText: 'done', turnCount: 3, toolCallCount: 4 })
    expect(finished?.endedAt).toBeTypeOf('number')
    expect(registry.abort(task.id)).toBe(false)
  })

  it('aborts a running task through the registry', () => {
    const registry = new BackgroundTaskRegistry()
    const { task, signal } = registry.start({ toolCallId: 'call-2', agentName: 'explore', description: 'Scan' })
    expect(registry.abort(task.id)).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  it('exposes the background option on the task tool', () => {
    const registry = { list: () => [], names: () => [], get: () => undefined } as unknown as SubAgentRegistry
    const schema = createTaskTool(registry).inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean; data?: { background?: boolean } }
    }
    const parsed = schema.safeParse({ description: 'Scan', subagent_type: 'explore', prompt: 'go', background: true })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.background).toBe(true)
  })
})
