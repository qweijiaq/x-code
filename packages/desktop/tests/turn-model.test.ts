import { describe, expect, it } from 'vitest'

import { buildTurnItems, sessionDayGroup } from '../src/renderer/transcript-model.js'
import type { Entry } from '../src/renderer/transcript-model.js'

function entry(id: string, role: Entry['role'], extra: Partial<Entry> = {}): Entry {
  return { id, role, text: id, ...extra }
}

describe('buildTurnItems', () => {
  it('groups entries by user turns and shows a divider per turn', () => {
    const entries = [
      entry('u1', 'user', { at: 1_700_000_000_000 }),
      entry('a1', 'assistant'),
      entry('u2', 'user'),
      entry('a2', 'assistant'),
    ]
    const built = buildTurnItems(entries, {
      sessionKey: 's1',
      toolDisplayMode: 'minimal',
      toolOverrides: new Map(),
    })
    expect(built.totalTurns).toBe(2)
    expect(built.hiddenTurns).toBe(0)
    expect(built.items.filter((item) => item.kind === 'divider')).toHaveLength(2)
    expect(built.items.find((item) => item.kind === 'divider')).toMatchObject({ turn: 1, at: 1_700_000_000_000 })
  })

  it('omits dividers for a single turn', () => {
    const built = buildTurnItems([entry('u1', 'user'), entry('a1', 'assistant')], {
      sessionKey: 's1',
      toolDisplayMode: 'balanced',
      toolOverrides: new Map(),
    })
    expect(built.items.some((item) => item.kind === 'divider')).toBe(false)
  })

  it('windows older turns while keeping absolute turn numbers', () => {
    const entries: Entry[] = []
    for (let turn = 1; turn <= 5; turn += 1) {
      entries.push(entry(`u${turn}`, 'user'), entry(`a${turn}`, 'assistant'))
    }
    const built = buildTurnItems(entries, {
      sessionKey: 's1',
      toolDisplayMode: 'minimal',
      toolOverrides: new Map(),
      maxTurns: 2,
    })
    expect(built.totalTurns).toBe(5)
    expect(built.hiddenTurns).toBe(3)
    const turns = built.items.flatMap((item) => (item.kind === 'divider' ? [item.turn] : []))
    expect(turns).toEqual([4, 5])
    expect(built.shownEntries.map((item) => item.id)).toEqual(['u4', 'a4', 'u5', 'a5'])
  })

  it('collapses tools and respects per-turn overrides', () => {
    const entries = [
      entry('u1', 'user'),
      entry('t1', 'tool', { toolName: 'read', toolStatus: 'completed' }),
      entry('t2', 'tool', { toolName: 'write', toolStatus: 'error' }),
      entry('a1', 'assistant'),
    ]
    const key = 's1:u1'
    const built = buildTurnItems(entries, {
      sessionKey: 's1',
      toolDisplayMode: 'minimal',
      toolOverrides: new Map([[key, true]]),
    })
    const toggle = built.items.find((item) => item.kind === 'toggle')
    expect(toggle).toMatchObject({ count: 2, failures: 1, collapsed: false })
    const shownIds = built.items.flatMap((item) => (item.kind === 'entry' ? [item.entry.id] : []))
    expect(shownIds).toEqual(['u1', 't1', 't2', 'a1'])
  })
})

describe('sessionDayGroup', () => {
  const now = new Date(2026, 4, 14, 12, 0, 0).getTime()

  it('groups pinned sessions separately', () => {
    expect(sessionDayGroup(now, now, true)).toBe('pinned')
  })

  it('separates today, yesterday, this week and older sessions', () => {
    expect(sessionDayGroup(now, now)).toBe('today')
    expect(sessionDayGroup(new Date(2026, 4, 13, 23, 0, 0).getTime(), now)).toBe('yesterday')
    expect(sessionDayGroup(new Date(2026, 4, 9, 8, 0, 0).getTime(), now)).toBe('week')
    expect(sessionDayGroup(new Date(2026, 3, 1, 8, 0, 0).getTime(), now)).toBe('earlier')
  })
})
