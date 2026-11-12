import { afterEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { explainPermission } from '../src/permissions/index.js'
import { addSessionAllowRule, clearSessionRules } from '../src/permissions/session-store.js'

afterEach(() => {
  clearSessionRules()
})

describe('explainPermission', () => {
  it('allows read-only tools', () => {
    const explanation = explainPermission({ toolName: 'readFile', input: { filePath: '/tmp/a.ts' } })
    expect(explanation).toMatchObject({ decision: 'allow', level: 'always-allow' })
    expect(explanation.reason).toContain('always-allow')
  })

  it('asks for mutating tools without an allow rule', () => {
    const explanation = explainPermission({ toolName: 'edit', input: { filePath: '/tmp/a.ts' } })
    expect(explanation).toMatchObject({ decision: 'ask', level: 'ask' })
  })

  it('classifies destructive shell commands as deny but still asks for confirmation', () => {
    const explanation = explainPermission({ toolName: 'shell', input: { command: 'rm -rf /' } })
    expect(explanation.level).toBe('deny')
    expect(explanation.decision).toBe('ask')
    expect(explanation.reason).toContain('destructive')
  })

  it('explains trust mode overriding the rule level', () => {
    const explanation = explainPermission({ toolName: 'edit', input: { filePath: '/tmp/a.ts' }, trustMode: true })
    expect(explanation.decision).toBe('allow')
    expect(explanation.reason).toContain('trust mode')
  })

  it('explains acceptEdits for in-project, non-sensitive paths only', () => {
    const project = path.join(os.tmpdir(), 'x-code-policy-project')
    const inside = explainPermission({
      toolName: 'writeFile',
      input: { filePath: 'src/a.ts' },
      permissionMode: 'acceptEdits',
      projectCwd: project,
    })
    expect(inside.decision).toBe('allow')
    expect(inside.reason).toContain('acceptEdits')

    const outside = explainPermission({
      toolName: 'writeFile',
      input: { filePath: '../outside.ts' },
      permissionMode: 'acceptEdits',
      projectCwd: project,
    })
    expect(outside.decision).toBe('ask')

    const sensitive = explainPermission({
      toolName: 'writeFile',
      input: { filePath: '.bashrc' },
      permissionMode: 'acceptEdits',
      projectCwd: project,
    })
    expect(sensitive.decision).toBe('ask')
    expect(sensitive.factors.join('\n')).toContain('sensitive')
  })

  it('reports a matching session allow rule', () => {
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    const explanation = explainPermission({ toolName: 'edit', input: { filePath: '/tmp/a.ts' } })
    expect(explanation.decision).toBe('allow')
    expect(explanation.reason).toContain('allow rule')
  })

  it('requires re-approval after external content taint', () => {
    const explanation = explainPermission({
      toolName: 'writeFile',
      input: { filePath: '/tmp/a.ts' },
      externalContent: { policy: 'approve', tainted: true, sources: ['webFetch'] },
    })
    expect(explanation.decision).toBe('ask')
    expect(explanation.reason).toContain('external content')
    expect(explanation.factors.join('\n')).toContain('webFetch')
  })

  it('notes when an unknown tool falls back to ask', () => {
    const explanation = explainPermission({ toolName: 'mysteryTool', input: {} })
    expect(explanation.decision).toBe('ask')
    expect(explanation.factors.join('\n')).toContain('no explicit rule')
  })
})
