import { describe, expect, it } from 'vitest'

import path from 'node:path'

import type { GoalAttempt, GoalVerificationResult, GoalVerifier } from '@x-code-cli/core'

import {
  buildGoalVerifiers,
  toGoalAttemptView,
  toGoalVerificationView,
  toGoalVerifierView,
} from '../src/runtime/agent-host.js'

describe('desktop goal verifier helpers', () => {
  const workspace = path.join('/tmp', 'xcode-goal-workspace')

  it('builds an auto verifier list when no explicit verifier is selected', () => {
    expect(buildGoalVerifiers({ objective: 'do it', verifierKind: 'auto' }, workspace)).toEqual([])
    expect(buildGoalVerifiers({ objective: 'do it' }, workspace)).toEqual([])
  })

  it('builds a shell verifier', () => {
    expect(
      buildGoalVerifiers({ objective: 'do it', verifierKind: 'shell', verifierValue: '  pnpm test  ' }, workspace),
    ).toEqual([{ kind: 'shell', command: 'pnpm test' }])
  })

  it('resolves relative file verifier paths against the workspace', () => {
    expect(
      buildGoalVerifiers(
        {
          objective: 'do it',
          verifierKind: 'file',
          verifierValue: 'dist/report.md',
          verifierContains: 'PASS',
        },
        workspace,
      ),
    ).toEqual([{ kind: 'file', path: path.join(workspace, 'dist/report.md'), contains: 'PASS' }])
  })

  it('builds a subagent verifier with a default prompt', () => {
    expect(
      buildGoalVerifiers({ objective: 'do it', verifierKind: 'subagent', verifierValue: 'code-reviewer' }, workspace),
    ).toEqual([
      {
        kind: 'subagent',
        agent: 'code-reviewer',
        prompt: 'Verify that the goal objective has been fully satisfied.',
      },
    ])
  })
})

describe('desktop goal view mapping', () => {
  it('renders file verifier conditions', () => {
    const verifier: GoalVerifier = { kind: 'file', path: '/tmp/report.md', exists: false, contains: 'PASS' }
    expect(toGoalVerifierView(verifier)).toEqual({
      kind: 'file',
      label: 'File',
      detail: '/tmp/report.md · must not exist · contains "PASS"',
    })
  })

  it('maps verification results and attempts', () => {
    const result: GoalVerificationResult = {
      verifier: { kind: 'shell', command: 'pnpm test' },
      ok: false,
      summary: 'tests failed',
      requiredFixes: ['fix login test'],
      durationMs: 42,
      ts: '2026-01-01T00:00:00.000Z',
    }
    expect(toGoalVerificationView(result)).toMatchObject({
      ok: false,
      summary: 'tests failed',
      kind: 'shell',
      requiredFixes: ['fix login test'],
    })

    const attempt: GoalAttempt = {
      id: 'a1',
      turn: 2,
      inputKind: 'verifier_failure',
      promptPreview: 'fix it',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      turnCount: 3,
      tokenUsageBefore: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        currentContextTokens: 0,
      },
      finish: 'verification_failed',
    }
    expect(toGoalAttemptView(attempt)).toEqual({
      turn: 2,
      inputKind: 'verifier_failure',
      finish: 'verification_failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
    })
  })
})
