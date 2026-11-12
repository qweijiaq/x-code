import { describe, expect, it } from 'vitest'

import { autoFixAction } from '../src/runtime/agent-host.js'

describe('auto-fix policy', () => {
  const base = { enabled: true, failedCount: 1, remaining: 3, hasFixPrompt: true, round: 0 }

  it('requests a fix while rounds remain', () => {
    expect(autoFixAction(base)).toBe('fix')
  })

  it('does nothing when there are no failures', () => {
    expect(autoFixAction({ ...base, failedCount: 0 })).toBe('none')
  })

  it('does nothing when auto-fix is disabled or no fix prompt exists', () => {
    expect(autoFixAction({ ...base, enabled: false })).toBe('none')
    expect(autoFixAction({ ...base, hasFixPrompt: false })).toBe('none')
  })

  it('reports exhaustion after all rounds were used', () => {
    expect(autoFixAction({ ...base, remaining: 0, round: 3 })).toBe('exhausted')
  })

  it('stays quiet when the budget is zero and no round ever started', () => {
    expect(autoFixAction({ ...base, remaining: 0, round: 0 })).toBe('none')
  })
})
