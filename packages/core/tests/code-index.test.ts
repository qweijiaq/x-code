import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { clearCodeIndex, codeIndexStats, indexCode, searchCodeIndex } from '../src/code-index/index.js'
import { collectContextResults } from '../src/tools/context-search.js'

let home = ''
let workspace = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-code-index-home-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-code-index-workspace-'))
  process.env.X_CODE_HOME = home
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(workspace, 'src', 'auth.ts'),
    [
      'export function login(user: string) {',
      '  // validate the login token',
      '  return `session:${user}`',
      '}',
      '',
      'export function logout() {',
      '  return null',
      '}',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(path.join(workspace, 'README.md'), 'not code', 'utf8')
})

afterAll(async () => {
  delete process.env.X_CODE_HOME
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('code index', () => {
  it('indexes code files and skips non-code files', async () => {
    const result = await indexCode(workspace, { semantic: false })
    expect(result.files).toBe(1)
    expect(result.chunks).toBeGreaterThan(0)
    expect(result.errors).toEqual([])

    const search = await searchCodeIndex('login token', { path: workspace, semantic: false })
    expect(search.results.length).toBeGreaterThan(0)
    expect(search.results[0]?.filePath.endsWith('auth.ts')).toBe(true)
    expect(search.results[0]?.startLine).toBeGreaterThan(0)
  })

  it('reuses unchanged files on a second index run', async () => {
    const result = await indexCode(workspace, { semantic: false })
    expect(result.skipped).toBe(1)
    expect(result.indexed).toBe(0)
  })

  it('lets contextSearch use the semantic code index', async () => {
    const state = createLoopState('default', { projectCwd: workspace })
    state.messages.push({ role: 'user', content: 'where is login handled?' } as never)
    const result = await collectContextResults({ projectCwd: workspace, state }, 'login', ['code'], 5)
    expect(result.results.some((entry) => entry.source === 'code' && entry.path?.endsWith('auth.ts'))).toBe(true)
  })

  it('reports stats and clears the index', async () => {
    const stats = await codeIndexStats()
    expect(stats.files).toBe(1)
    expect(stats.chunks).toBeGreaterThan(0)
    await clearCodeIndex()
    const cleared = await codeIndexStats()
    expect(cleared.files).toBe(0)
    expect((await searchCodeIndex('login', { semantic: false })).results).toEqual([])
  })
})
