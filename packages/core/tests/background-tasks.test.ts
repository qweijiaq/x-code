import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
      externalContentTainted: true,
      externalContentSources: ['webFetch'],
    })
    expect(finished).toMatchObject({
      status: 'completed',
      resultText: 'done',
      turnCount: 3,
      toolCallCount: 4,
      externalContentTainted: true,
      externalContentSources: ['webFetch'],
    })
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

describe('background task persistence', () => {
  it('restores completed tasks after a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-bg-tasks-'))
    const storePath = path.join(dir, 'background-tasks.json')
    try {
      const registry = new BackgroundTaskRegistry({ storePath })
      const { task } = registry.start({ toolCallId: 'call-1', agentName: 'explore', description: 'Scan' })
      registry.complete(task.id, { status: 'completed', resultText: 'done' })

      const restored = new BackgroundTaskRegistry({ storePath })
      expect(restored.list()).toHaveLength(1)
      expect(restored.list()[0]).toMatchObject({
        id: task.id,
        status: 'completed',
        resultText: 'done',
        agentName: 'explore',
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('marks tasks that were running at exit as interrupted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-bg-tasks-'))
    const storePath = path.join(dir, 'background-tasks.json')
    try {
      const registry = new BackgroundTaskRegistry({ storePath })
      const { task, signal } = registry.start({
        toolCallId: 'call-2',
        agentName: 'general-purpose',
        description: 'Long job',
      })
      registry.disposeAll()
      expect(signal.aborted).toBe(true)

      const restored = new BackgroundTaskRegistry({ storePath })
      expect(restored.get(task.id)).toMatchObject({
        status: 'interrupted',
        error: 'Interrupted when the app exited',
      })
      expect(restored.get(task.id)?.endedAt).toBeTypeOf('number')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('background task multi-window store', () => {
  it('merges snapshots from different windows without clobbering and keeps mode 0600', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-bg-tasks-'))
    const storePath = path.join(dir, 'background-tasks.json')
    try {
      const first = new BackgroundTaskRegistry({ storePath, ownerId: 'window-1' })
      const second = new BackgroundTaskRegistry({ storePath, ownerId: 'window-2' })
      const a = first.start({ toolCallId: 'call-a', agentName: 'explore', description: 'A' }).task
      const b = second.start({ toolCallId: 'call-b', agentName: 'plan', description: 'B' }).task

      first.complete(a.id, { status: 'completed', resultText: 'a' })
      second.complete(b.id, { status: 'completed', resultText: 'b' })

      const stored = JSON.parse(await fs.readFile(storePath, 'utf-8')) as Array<{ id: string; ownerId?: string }>
      expect(stored.map((task) => task.id).sort()).toEqual([a.id, b.id].sort())

      const restoredFirst = new BackgroundTaskRegistry({ storePath, ownerId: 'window-1' })
      expect(restoredFirst.list().map((task) => task.id)).toEqual([a.id])
      const restoredSecond = new BackgroundTaskRegistry({ storePath, ownerId: 'window-2' })
      expect(restoredSecond.list().map((task) => task.id)).toEqual([b.id])

      expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
