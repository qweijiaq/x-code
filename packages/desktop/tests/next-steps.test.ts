import { describe, expect, it } from 'vitest'

import { buildNextSteps, composeNextStepPrompt } from '../src/renderer/next-steps.js'
import type { Entry } from '../src/renderer/transcript-model.js'
import type { GoalView, TodoView } from '../src/shared/protocol.js'

function entry(partial: Partial<Entry> & Pick<Entry, 'id' | 'role'>): Entry {
  return { text: '', ...partial }
}

const goal: GoalView = {
  id: 'g1',
  objective: '修测试',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:10:00.000Z',
  turnCount: 2,
  tokensUsed: 100,
  verifiers: [],
  verificationResults: [],
  attempts: [],
  totalAttempts: 2,
  failedAttempts: 0,
  requiresUserConfirmation: false,
}

describe('buildNextSteps', () => {
  it('returns nothing before the first turn', () => {
    expect(buildNextSteps({ entries: [] })).toEqual([])
  })

  it('suggests fixing failures and reviewing edits from the last turn', () => {
    const entries: Entry[] = [
      entry({ id: 'u1', role: 'user', text: '做点事' }),
      entry({ id: 't1', role: 'tool', toolStatus: 'error', toolName: 'shell', text: 'boom' }),
      entry({ id: 'a1', role: 'assistant', text: '改好了' }),
    ]
    const steps = buildNextSteps({ entries })
    expect(steps.map((step) => step.id)).toEqual(['fix-failures'])
  })

  it('prefers pending todos and goal signals over generic fallbacks', () => {
    const todos: TodoView[] = [
      { content: '补测试', activeForm: '补测试', status: 'pending' },
      { content: '已完成', activeForm: '已完成', status: 'completed' },
    ]
    const entries: Entry[] = [
      entry({ id: 'u1', role: 'user', text: '继续' }),
      entry({ id: 'a1', role: 'assistant', text: '这轮没动代码' }),
    ]
    const steps = buildNextSteps({ entries, todos, goal })
    expect(steps.map((step) => step.id)).toEqual(['continue-todos', 'goal-progress'])
    expect(steps[0].prompt).toContain('补测试')
  })

  it('composes a single prompt for one step and a list for many', () => {
    const one = [{ id: 'a', label: 'A', prompt: '做事' }]
    const two = [...one, { id: 'b', label: 'B', prompt: '再做' }]
    expect(composeNextStepPrompt(one)).toBe('做事')
    expect(composeNextStepPrompt(two)).toBe('请继续处理以下事项：\n- 做事\n- 再做')
    expect(composeNextStepPrompt([])).toBe('')
  })
})
