import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTurnCheckpoint, gitFileDiff, gitStatus, undoCheckpoint } from '../src/runtime/git.js'

let root = ''

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV })
}

function write(name: string, content: string): void {
  fs.writeFileSync(path.join(root, name), content)
}

function read(name: string): string {
  return fs.readFileSync(path.join(root, name), 'utf8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-git-'))
  git(['init', '-q'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  write('base.txt', 'base\n')
  git(['add', 'base.txt'])
  git(['commit', '-q', '-m', 'init'])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('git panel', () => {
  it('reports branch, changes, and stats', async () => {
    write('base.txt', 'base\nuser change\n')
    write('brand-new.txt', 'new\n')

    const status = await gitStatus(root)

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.files.map((file) => file.path).sort()).toEqual(['base.txt', 'brand-new.txt'])
    expect(status.files.find((file) => file.path === 'brand-new.txt')?.untracked).toBe(true)
    expect(status.additions).toBeGreaterThan(0)
  })

  it('renders an untracked file as an added diff', async () => {
    write('new.txt', 'line one\nline two\n')

    const diff = await gitFileDiff(root, 'new.txt', false)

    expect(diff.diff).toContain('+++ b/new.txt')
    expect(diff.diff).toContain('+line one')
    expect(diff.truncated).toBe(false)
  })

  it('undoes only the turn and preserves earlier user changes', async () => {
    // 本轮之前的既有状态：一处用户编辑加一个未跟踪文件。
    write('base.txt', 'base\nuser change\n')
    write('keep.txt', 'keep me\n')
    const checkpoint = await createTurnCheckpoint(root, 'turn-1')
    expect(checkpoint).not.toBeNull()

    // 本轮：重写已跟踪文件，并新建一个未跟踪文件。
    write('base.txt', 'base\nagent change\n')
    write('turn-file.txt', 'created by the agent\n')

    const result = await undoCheckpoint(checkpoint!)

    expect(result.deleted).toBe(1)
    expect(read('base.txt')).toBe('base\nuser change\n')
    expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'turn-file.txt'))).toBe(false)
  })

  it('restores tracked files to HEAD when the tree was clean before the turn', async () => {
    const checkpoint = await createTurnCheckpoint(root, 'turn-2')
    expect(checkpoint?.stash).toBeNull()

    write('base.txt', 'base\nagent change\n')
    write('turn-file.txt', 'created by the agent\n')

    await undoCheckpoint(checkpoint!)

    expect(read('base.txt')).toBe('base\n')
    expect(fs.existsSync(path.join(root, 'turn-file.txt'))).toBe(false)
  })
})
