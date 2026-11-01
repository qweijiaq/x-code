import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  directoryStats,
  formatTokens,
  realpathAllowMissing,
  toCheckResultView,
  toFileEditView,
  toTodoViews,
  toUserConfigFields,
} from '../src/runtime/agent-host-support.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xc-agent-host-support-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })))
})

describe('agent host support', () => {
  it('formats token counts', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2_400_000)).toBe('2.4m')
  })

  it('maps todos without leaking extra fields', () => {
    expect(
      toTodoViews([
        { content: 'a', activeForm: 'doing a', status: 'in_progress' },
        { content: 'b', activeForm: 'doing b', status: 'pending' },
      ]),
    ).toEqual([
      { content: 'a', activeForm: 'doing a', status: 'in_progress' },
      { content: 'b', activeForm: 'doing b', status: 'pending' },
    ])
  })

  it('maps plugin user-config fields and drops undefined options', () => {
    expect(
      toUserConfigFields([
        { key: 'token', type: 'string', sensitive: true, required: true, prompt: 'Token' },
        { key: 'count', type: 'number', default: 2, description: 'How many' },
      ]),
    ).toEqual([
      { key: 'token', type: 'string', sensitive: true, required: true, prompt: 'Token' },
      { key: 'count', type: 'number', sensitive: false, required: false, default: 2, description: 'How many' },
    ])
    expect(toUserConfigFields(undefined)).toEqual([])
  })

  it('marks an edit revertible only when the before/after snapshots allow it', () => {
    const updated = toFileEditView({
      filePath: '/tmp/a.ts',
      additions: 1,
      removals: 1,
      isCreate: false,
      beforeContent: 'old',
      afterContent: 'new',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    })
    expect(updated.revertible).toBe(true)
    expect(updated.hunks).toHaveLength(1)

    const createdWithoutSnapshot = toFileEditView({
      filePath: '/tmp/b.ts',
      additions: 1,
      removals: 0,
      isCreate: true,
      content: 'new',
      hunks: [],
    })
    // 创建文件时只需要 afterContent 才是可回退的；没有快照就禁用。
    expect(createdWithoutSnapshot.revertible).toBe(false)
  })

  it('joins a check command line', () => {
    const view = toCheckResultView({
      id: 'test',
      label: 'Unit',
      kind: 'node',
      command: 'pnpm',
      args: ['test'],
      status: 'passed',
      exitCode: 0,
      durationMs: 12,
      output: 'ok',
    })
    expect(view.commandLine).toBe('pnpm test')
    expect(view).toMatchObject({ id: 'test', status: 'passed', durationMs: 12 })
  })

  it('counts files and bytes without following symlinks', async () => {
    const dir = await temporaryDirectory()
    await fsp.mkdir(path.join(dir, 'nested'))
    await fsp.writeFile(path.join(dir, 'a.txt'), '12345')
    await fsp.writeFile(path.join(dir, 'nested', 'b.txt'), '123')
    await fsp.symlink(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'))

    await expect(directoryStats(dir)).resolves.toEqual({ bytes: 8, files: 2 })
  })

  it('resolves the deepest existing ancestor for a missing path', async () => {
    const dir = await temporaryDirectory()
    const target = path.join(dir, 'missing', 'nested', 'file.txt')
    const resolved = realpathAllowMissing(target)
    expect(resolved.endsWith(path.join('missing', 'nested', 'file.txt'))).toBe(true)
    expect(fs.existsSync(path.dirname(resolved))).toBe(false)
  })
})
