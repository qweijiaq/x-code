import { describe, expect, it } from 'vitest'

import {
  markExternalContent,
  markExternalContentFromMessages,
  propagateExternalContent,
  shouldRequireExternalContentApproval,
} from '../src/permissions/external-content.js'

describe('external content taint', () => {
  it('marks only external tools and deduplicates sources', () => {
    const state: { externalContentTainted?: boolean; externalContentSources?: string[] } = {}
    markExternalContent(state, 'readFile')
    expect(state.externalContentTainted).toBeUndefined()

    markExternalContent(state, 'webFetch')
    markExternalContent(state, 'webFetch')
    markExternalContent(state, 'readDocument')
    expect(state.externalContentTainted).toBe(true)
    expect(state.externalContentSources).toEqual(['webFetch', 'readDocument'])
  })

  it('only requires approval for destructive tools under the approve policy', () => {
    expect(shouldRequireExternalContentApproval('approve', true, 'writeFile')).toBe(true)
    expect(shouldRequireExternalContentApproval('approve', true, 'shell')).toBe(true)
    expect(shouldRequireExternalContentApproval('approve', true, 'task')).toBe(true)
    expect(shouldRequireExternalContentApproval('approve', true, 'readFile')).toBe(false)
    expect(shouldRequireExternalContentApproval('off', true, 'writeFile')).toBe(false)
    expect(shouldRequireExternalContentApproval('approve', false, 'writeFile')).toBe(false)
  })
})

describe('external content from response messages', () => {
  it('marks SDK tool results by toolName and ignores plain text', () => {
    const state: { externalContentTainted?: boolean; externalContentSources?: string[] } = {}
    markExternalContentFromMessages(state, [
      { content: 'plain text' },
      {
        content: [
          { type: 'text', text: 'summary' },
          { type: 'tool-result', toolName: 'webSearch', output: 'result' },
        ],
      },
    ])
    expect(state.externalContentTainted).toBe(true)
    expect(state.externalContentSources).toEqual(['webSearch'])
  })
})

describe('subagent taint propagation', () => {
  it('merges child sources and records the subagent', () => {
    const parent: { externalContentTainted?: boolean; externalContentSources?: string[] } = {
      externalContentSources: ['webSearch'],
    }
    propagateExternalContent(parent, { externalContentTainted: true, externalContentSources: ['webFetch'] }, 'browser')
    expect(parent.externalContentTainted).toBe(true)
    expect(parent.externalContentSources).toEqual(['webSearch', 'webFetch', 'subagent:browser'])
  })

  it('does not change the parent when the child stayed local', () => {
    const parent: { externalContentTainted?: boolean; externalContentSources?: string[] } = {}
    propagateExternalContent(parent, { externalContentTainted: false }, 'explore')
    expect(parent.externalContentTainted).toBeUndefined()
    expect(parent.externalContentSources).toBeUndefined()
  })
})
