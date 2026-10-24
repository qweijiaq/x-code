import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createBranchWorktree,
  gitBranches,
  openBranchWorktree,
  pruneWorktrees,
  removeBranchWorktree,
} from '../src/runtime/git.js'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
}

let base = ''
let repo = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-worktree-'))
  repo = path.join(base, 'demo')
  fs.mkdirSync(repo)
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' })
  git(['init', '-q'])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  git(['branch', 'feature/x'])
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('git worktrees', () => {
  it('lists local branches and marks the current one', async () => {
    const view = await gitBranches(repo)
    expect(view.isRepo).toBe(true)
    expect(view.current).toBe('main')
    expect(view.branches.map((branch) => branch.name)).toEqual(['main', 'feature/x'])
    expect(view.branches.find((branch) => branch.name === 'main')?.current).toBe(true)
    expect(view.branches.find((branch) => branch.name === 'feature/x')?.worktreePath).toBeUndefined()
  })

  it('creates a sibling worktree once and reuses it afterwards', async () => {
    const first = await openBranchWorktree(repo, 'feature/x')
    expect(first.created).toBe(true)
    expect(path.dirname(first.workspacePath)).toBe(fs.realpathSync(base))
    expect(path.basename(first.workspacePath)).toBe('demo-feature-x')
    expect(fs.existsSync(path.join(first.workspacePath, 'README.md'))).toBe(true)
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: first.workspacePath,
        env: GIT_ENV,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('feature/x')

    const view = await gitBranches(repo)
    expect(view.branches.find((branch) => branch.name === 'feature/x')?.worktreePath).toBe(first.workspacePath)
    expect(view.branches.find((branch) => branch.name === 'feature/x')?.removable).toBe(true)
    expect(view.branches.find((branch) => branch.name === 'main')?.removable).toBe(false)

    const second = await openBranchWorktree(repo, 'feature/x')
    expect(second).toEqual({ ...first, created: false })
  })

  it('removes a clean worktree but keeps the branch', async () => {
    const opened = await openBranchWorktree(repo, 'feature/x')
    const removed = await removeBranchWorktree(repo, opened.workspacePath)
    expect(removed).toEqual({ path: opened.workspacePath, removed: true, forced: false })
    expect(fs.existsSync(opened.workspacePath)).toBe(false)
    const view = await gitBranches(repo)
    const branch = view.branches.find((entry) => entry.name === 'feature/x')
    expect(branch?.worktreePath).toBeUndefined()
    expect(branch).toBeDefined()
  })

  it('requires force for a dirty worktree and protects the main/current checkout', async () => {
    const opened = await openBranchWorktree(repo, 'feature/x')
    fs.writeFileSync(path.join(opened.workspacePath, 'README.md'), '# changed\n')
    await expect(removeBranchWorktree(repo, opened.workspacePath)).rejects.toThrow('未提交')
    await expect(removeBranchWorktree(repo, repo)).rejects.toThrow('主工作区')
    await expect(removeBranchWorktree(opened.workspacePath, opened.workspacePath)).rejects.toThrow('当前窗口')
    const forced = await removeBranchWorktree(repo, opened.workspacePath, true)
    expect(forced.forced).toBe(true)
    expect(fs.existsSync(opened.workspacePath)).toBe(false)
  })

  it('creates a new branch from HEAD in its own worktree', async () => {
    const created = await createBranchWorktree(repo, 'feature/new')
    expect(created.created).toBe(true)
    expect(fs.existsSync(path.join(created.workspacePath, 'README.md'))).toBe(true)
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: created.workspacePath,
        env: GIT_ENV,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('feature/new')
    expect((await gitBranches(repo)).branches.some((branch) => branch.name === 'feature/new')).toBe(true)
  })

  it('creates a new branch worktree under a chosen parent directory', async () => {
    const parent = path.join(base, 'custom-parent')
    fs.mkdirSync(parent)
    const created = await createBranchWorktree(repo, 'feature/custom', undefined, parent)
    expect(created.created).toBe(true)
    expect(path.dirname(created.workspacePath)).toBe(parent)
    expect(path.basename(created.workspacePath)).toBe('demo-feature-custom')
  })

  it('lists remote branches and creates a local tracking worktree', async () => {
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: repo, env: GIT_ENV, encoding: 'utf-8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/remote-feature', head], { cwd: repo, env: GIT_ENV })
    const view = await gitBranches(repo)
    const remote = view.branches.find((branch) => branch.name === 'origin/remote-feature')
    expect(remote).toMatchObject({ remote: true, localName: 'remote-feature' })

    const opened = await openBranchWorktree(repo, 'remote-feature', 'origin/remote-feature')
    expect(opened.created).toBe(true)
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: opened.workspacePath,
        env: GIT_ENV,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('remote-feature')
  })

  it('refuses to remove a locked worktree', async () => {
    const opened = await openBranchWorktree(repo, 'feature/x')
    execFileSync('git', ['worktree', 'lock', opened.workspacePath], { cwd: repo, env: GIT_ENV })
    const view = await gitBranches(repo)
    expect(view.branches.find((branch) => branch.name === 'feature/x')?.removable).toBe(false)
    await expect(removeBranchWorktree(repo, opened.workspacePath)).rejects.toThrow('锁定')
    expect(fs.existsSync(opened.workspacePath)).toBe(true)
    execFileSync('git', ['worktree', 'unlock', opened.workspacePath], { cwd: repo, env: GIT_ENV })
  })

  it('prunes records for deleted worktree directories', async () => {
    const opened = await openBranchWorktree(repo, 'feature/x')
    fs.rmSync(opened.workspacePath, { recursive: true, force: true })
    await pruneWorktrees(repo)
    const listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf-8',
    })
    expect(listing).not.toContain(opened.workspacePath)
  })

  it('avoids an existing file at the default worktree path', async () => {
    fs.writeFileSync(path.join(base, 'demo-feature-x'), 'occupied')
    const result = await openBranchWorktree(repo, 'feature/x')
    expect(path.basename(result.workspacePath)).toBe('demo-feature-x-2')
    expect(fs.statSync(result.workspacePath).isDirectory()).toBe(true)
  })

  it('rejects unknown branches and non-repositories', async () => {
    await expect(openBranchWorktree(repo, 'missing')).rejects.toThrow('分支不存在')
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    expect(await gitBranches(plain)).toEqual({ isRepo: false, branches: [] })
    await expect(openBranchWorktree(plain, 'main')).rejects.toThrow('不是 Git 仓库')
  })
})
