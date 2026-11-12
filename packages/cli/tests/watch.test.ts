import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectSnapshot, diffSnapshots, formatWatchPrompt, hasChanges, parseWatchArgs } from '../src/watch.js'

const directories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(dir)
  return dir
}

async function write(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('parseWatchArgs', () => {
  it('parses paths, prompt and optional tuning flags', () => {
    expect(
      parseWatchArgs([
        'src',
        'tests',
        '--on-change',
        'run the tests',
        '--debounce=500',
        '--interval',
        '2000',
        '--trust',
      ]),
    ).toEqual({
      paths: ['src', 'tests'],
      prompt: 'run the tests',
      debounceMs: 500,
      intervalMs: 2000,
      trust: true,
    })
  })

  it('defaults the path to the current directory', () => {
    expect(parseWatchArgs(['--on-change=fix it'])).toMatchObject({ paths: ['.'], prompt: 'fix it', trust: false })
  })

  it('requires a prompt', () => {
    const parsed = parseWatchArgs(['src'])
    expect('error' in parsed && parsed.error).toContain('--on-change')
  })

  it('rejects invalid numbers and unknown flags', () => {
    expect('error' in parseWatchArgs(['--on-change', 'x', '--interval', '10'])).toBe(true)
    expect('error' in parseWatchArgs(['--on-change', 'x', '--debounce', 'soon'])).toBe(true)
    expect('error' in parseWatchArgs(['--on-change', 'x', '--watch-all'])).toBe(true)
  })

  it('supports help', () => {
    expect(parseWatchArgs(['--help'])).toEqual({ help: true })
  })
})

describe('watch snapshots', () => {
  it('collects nested files and skips dependency/VCS directories', async () => {
    const root = await temporaryDirectory('xc-watch-')
    await write(path.join(root, 'src', 'a.ts'), 'a')
    await write(path.join(root, 'src', 'nested', 'b.ts'), 'b')
    await write(path.join(root, 'node_modules', 'pkg', 'index.js'), 'skip')
    await write(path.join(root, '.git', 'config'), 'skip')

    const snapshot = await collectSnapshot(['.'], root)
    expect([...snapshot.files.keys()].map((file) => path.relative(root, file)).sort()).toEqual([
      path.join('src', 'a.ts'),
      path.join('src', 'nested', 'b.ts'),
    ])
  })

  it('accepts an explicit file path', async () => {
    const root = await temporaryDirectory('xc-watch-file-')
    const file = path.join(root, 'a.ts')
    await write(file, 'a')
    const snapshot = await collectSnapshot(['a.ts'], root)
    expect(snapshot.files.has(path.resolve(file))).toBe(true)
  })

  it('diffs added, modified and deleted files', () => {
    const previous = new Map([
      ['/a.ts', '1:1'],
      ['/b.ts', '1:1'],
    ])
    const next = new Map([
      ['/a.ts', '2:1'],
      ['/c.ts', '1:1'],
    ])
    const changes = diffSnapshots(previous, next)
    expect(changes).toEqual({ added: ['/c.ts'], modified: ['/a.ts'], deleted: ['/b.ts'] })
    expect(hasChanges(changes)).toBe(true)
    expect(hasChanges({ added: [], modified: [], deleted: [] })).toBe(false)
  })

  it('formats relative paths and truncation notes for the agent prompt', () => {
    const prompt = formatWatchPrompt(
      'run the tests',
      { added: ['/work/new.ts'], modified: ['/work/src/a.ts'], deleted: [] },
      '/work',
      true,
    )
    expect(prompt).toContain('[Watch] Files changed')
    expect(prompt).toContain('modified: src/a.ts')
    expect(prompt).toContain('added: new.ts')
    expect(prompt).toContain('20000 files')
  })
})
