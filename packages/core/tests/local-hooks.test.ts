import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadLocalHookConfigs, localHookPaths } from '../src/hooks/local.js'

const roots: string[] = []
const previousHome = process.env.X_CODE_HOME

function makeRoots(): { home: string; workspace: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-hooks-home-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-hooks-ws-'))
  roots.push(home, workspace)
  process.env.X_CODE_HOME = home
  return { home, workspace }
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('local hook configs', () => {
  it('registers user and project hooks with their scopes', () => {
    const { home, workspace } = makeRoots()
    const paths = localHookPaths(workspace)
    expect(paths.user).toBe(path.join(home, 'hooks.json'))
    expect(paths.project).toBe(path.join(workspace, '.x-code', 'hooks.json'))

    fs.writeFileSync(paths.user, JSON.stringify({ TurnComplete: [{ command: 'echo user' }] }))
    fs.mkdirSync(path.dirname(paths.project), { recursive: true })
    fs.writeFileSync(paths.project, JSON.stringify({ PreToolUse: [{ matcher: 'edit', command: 'echo project' }] }))

    const loaded = loadLocalHookConfigs(workspace, { allowProjectHooks: true })
    expect(loaded.errors).toEqual([])
    expect(loaded.sources.map((source) => [source.scope, source.exists])).toEqual([
      ['user', true],
      ['project', true],
    ])
    expect(loaded.registered.map((hook) => [hook.pluginId, hook.event, hook.entry.command])).toEqual([
      ['user', 'TurnComplete', 'echo user'],
      ['project', 'PreToolUse', 'echo project'],
    ])
  })

  it('does not register project hooks without explicit trust', () => {
    const { workspace } = makeRoots()
    const paths = localHookPaths(workspace)
    fs.mkdirSync(path.dirname(paths.project), { recursive: true })
    fs.writeFileSync(paths.project, JSON.stringify({ SessionStart: [{ command: 'echo project' }] }))

    const loaded = loadLocalHookConfigs(workspace)
    expect(loaded.errors).toEqual([])
    expect(loaded.registered).toEqual([])
    expect(loaded.sources.find((source) => source.scope === 'project')?.config).toEqual({
      SessionStart: [{ command: 'echo project' }],
    })
  })

  it('keeps the other scope usable when one file is malformed', () => {
    const { workspace } = makeRoots()
    const paths = localHookPaths(workspace)
    fs.writeFileSync(paths.user, '{ not json')
    fs.mkdirSync(path.dirname(paths.project), { recursive: true })
    fs.writeFileSync(paths.project, JSON.stringify({ SessionStart: [{ command: 'echo project' }] }))

    const loaded = loadLocalHookConfigs(workspace, { allowProjectHooks: true })
    expect(loaded.errors).toHaveLength(1)
    expect(loaded.errors[0]).toContain('user hooks')
    expect(loaded.registered).toHaveLength(1)
    expect(loaded.registered[0].pluginId).toBe('project')
  })
})
