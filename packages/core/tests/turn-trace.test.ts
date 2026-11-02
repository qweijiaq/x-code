import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readTurnTraces, writeTurnTrace } from '../src/agent/turn-trace.js'
import type { TurnTraceEntry } from '../src/agent/turn-trace.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-turn-trace-'))
  directories.push(dir)
  return dir
}

function entry(overrides: Partial<TurnTraceEntry> = {}): TurnTraceEntry {
  return {
    ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    sessionId: 'session-1',
    turn: 1,
    modelId: 'openai:gpt-5.6-sol',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 120,
    toolCalls: 2,
    finishReason: 'tool-calls',
    costUsd: 0.0008,
    unpricedModels: [],
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('turn trace', () => {
  it('appends one JSON line per turn without storing content', async () => {
    const dir = await temporaryDirectory()
    await writeTurnTrace(entry(), { dir })
    await writeTurnTrace(entry({ turn: 2, finishReason: 'stop' }), { dir })

    const raw = await fs.readFile(path.join(dir, 'turns.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ turn: 2, finishReason: 'stop', toolCalls: 2 })
    expect(raw).not.toContain('prompt')
    expect(raw).not.toContain('content')
  })

  it('reads the most recent traces across the rotated file', async () => {
    const dir = await temporaryDirectory()
    await writeTurnTrace(entry(), { dir, maxBytes: 16 })
    await writeTurnTrace(entry({ turn: 2 }), { dir, maxBytes: 16 })

    const recent = await readTurnTraces(5, dir)
    expect(recent.map((item) => item.turn)).toEqual([1, 2])
    expect((await readTurnTraces(1, dir)).map((item) => item.turn)).toEqual([2])
  })

  it('rotates to a single backup once the file reaches the cap', async () => {
    const dir = await temporaryDirectory()
    await writeTurnTrace(entry(), { dir, maxBytes: 16 })
    await writeTurnTrace(entry({ turn: 2 }), { dir, maxBytes: 16 })

    const backup = await fs.readFile(path.join(dir, 'turns.jsonl.1'), 'utf-8')
    expect(backup.trim().split('\n')).toHaveLength(1)
    const current = await fs.readFile(path.join(dir, 'turns.jsonl'), 'utf-8')
    expect(JSON.parse(current.trim())).toMatchObject({ turn: 2 })
  })
})
