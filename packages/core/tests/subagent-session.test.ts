import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendHeader,
  appendInterrupted,
  appendStepStats,
  appendUsage,
  flushPendingMessages,
} from '../src/agent/session-store.js'

const directories: string[] = []
let previousHome: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('sub-agent session persistence', () => {
  it('does not create a sibling session file for delegated turns', async () => {
    previousHome = process.env.X_CODE_HOME
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-subagent-session-'))
    directories.push(root)
    process.env.X_CODE_HOME = root
    const cwd = path.join(root, 'project')
    await fs.mkdir(cwd, { recursive: true })

    const state = createLoopState('default', {
      projectCwd: cwd,
      agentRole: 'sub-agent',
      persistSession: false,
    })
    await appendHeader(state, 'test:model', 'delegated task', cwd)
    await flushPendingMessages(state)
    await appendUsage(state, 'test:model')
    await appendStepStats(state, {
      prompt: 'delegated task',
      inputTokens: 10,
      outputTokens: 5,
      turnCount: 1,
      toolCallCount: 0,
      startedAt: new Date().toISOString(),
    })
    await appendInterrupted(state)

    const sessions = path.join(cwd, '.x-code', 'sessions')
    await expect(fs.readdir(sessions)).rejects.toThrow()
  })
})
