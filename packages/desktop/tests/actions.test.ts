import { describe, expect, it } from 'vitest'

import { TOOL_MENU_ACTION_IDS, createAppActions } from '../src/renderer/actions.js'
import type { AppActionContext } from '../src/renderer/actions.js'

const context = {
  t: (key: string) => key,
  appState: null,
  terminalOpen: false,
  recording: false,
} as unknown as AppActionContext

describe('desktop action registry', () => {
  it('exposes unique action ids', () => {
    const actions = createAppActions(context)
    const ids = actions.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the tool menu ids backed by real actions', () => {
    const actions = createAppActions(context)
    const ids = new Set(actions.map((action) => action.id))
    for (const id of TOOL_MENU_ACTION_IDS) expect(ids.has(id)).toBe(true)
    expect(new Set(TOOL_MENU_ACTION_IDS).size).toBe(TOOL_MENU_ACTION_IDS.length)
  })

  it('preserves the existing tool-menu test ids', () => {
    const actions = createAppActions(context)
    const testIds = actions.flatMap((action) => (action.menuTestId ? [action.menuTestId] : []))
    expect(testIds).toEqual(
      expect.arrayContaining([
        'files-toggle',
        'document-toggle',
        'context-search-toggle',
        'tools-skill-market',
        'git-toggle',
        'checks-toggle',
        'tools-outline',
        'background-toggle',
        'diagnostics-toggle',
        'tools-manual',
      ]),
    )
  })
})
