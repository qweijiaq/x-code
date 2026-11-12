import { afterEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import type { MemoryService } from '../src/knowledge/memory/service.js'
import { createContextSearchTool } from '../src/tools/context-search.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-context-search-'))
  temporaryDirectories.push(dir)
  return dir
}

describe('contextSearch', () => {
  it('finds workspace code and past session text', async () => {
    const project = await tempProject()
    await fs.mkdir(path.join(project, 'src'), { recursive: true })
    await fs.writeFile(path.join(project, 'src', 'example.ts'), 'export const needle = 42\n', 'utf8')

    const sessions = path.join(project, '.x-code', 'sessions')
    await fs.mkdir(sessions, { recursive: true })
    await fs.writeFile(
      path.join(sessions, 's1.jsonl'),
      [
        JSON.stringify({
          t: 'meta',
          kind: 'header',
          cwd: project,
          modelId: 'test:model',
          startedAt: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'discuss needle',
          taskSlug: 'needle',
          sessionId: 's1',
        }),
        JSON.stringify({
          t: 'msg',
          message: { role: 'user', content: 'we decided to keep the needle API' },
          ts: '2026-01-01T00:00:01.000Z',
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const state = createLoopState('default', { projectCwd: project })
    state.messages.push({ role: 'user', content: 'where is the needle?' } as never)
    const tool = createContextSearchTool({ projectCwd: project, state })
    const result = await (
      tool as unknown as {
        execute: (
          input: unknown,
          options: { toolCallId: string },
        ) => Promise<{
          results: Array<{ source: string; path?: string; sessionId?: string }>
        }>
      }
    ).execute({ query: 'needle', scopes: ['code', 'sessions'], limit: 5 }, { toolCallId: 't' })

    expect(result.results.some((item) => item.source === 'code' && item.path?.endsWith('example.ts'))).toBe(true)
    expect(result.results.some((item) => item.source === 'sessions' && item.sessionId === 's1')).toBe(true)
  })

  it('only exposes memory when the query is grounded in the current user message', async () => {
    const project = await tempProject()
    const search = vi.fn().mockResolvedValue([
      {
        topicId: 'preferences',
        section: 'root',
        status: 'active',
        updatedAt: '2026-01-01T00:00:00.000Z',
        path: '/tmp/memory.md',
        snippet: 'The user prefers tabs.',
        score: 1,
      },
    ])
    const memoryService = { search } as unknown as MemoryService
    const state = createLoopState('default', { projectCwd: project })
    state.messages.push({ role: 'user', content: 'Please summarize this file.' } as never)
    const tool = createContextSearchTool({ projectCwd: project, state, memoryService })
    const execute = (
      tool as unknown as {
        execute: (input: unknown, options: { toolCallId: string }) => Promise<{ results: unknown[] }>
      }
    ).execute

    const ungrounded = await execute({ query: 'tabs', scopes: ['memory'] }, { toolCallId: 't1' })
    expect(ungrounded.results).toHaveLength(0)
    expect(search).not.toHaveBeenCalled()

    state.messages.push({ role: 'user', content: 'Do I prefer tabs or spaces?' } as never)
    const grounded = await execute({ query: 'tabs', scopes: ['memory'] }, { toolCallId: 't2' })
    expect(grounded.results).toHaveLength(1)
    expect(search).toHaveBeenCalledOnce()
  })
})
