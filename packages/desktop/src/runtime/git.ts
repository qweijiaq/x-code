// Git panel + per-turn checkpoints.
//
// A checkpoint is taken before each agent turn: `git stash create` captures the
// tracked working-tree/index state without touching anything, and the untracked
// file list is recorded. Undo restores tracked files (and the index) to that
// snapshot and deletes only untracked files created by the turn — HEAD and the
// user's pre-existing modifications are never rolled back.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { BranchListView, WorktreeOpenResult } from '../shared/protocol.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const DIFF_MAX_BYTES = 300 * 1024

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // Checkpoints and test commits must work without the user's global identity.
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'X-Code',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'x-code@localhost',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'X-Code',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'x-code@localhost',
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: GIT_ENV,
    })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
      code: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

export async function gitRepoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = result.stdout.trim()
  return result.code === 0 && root ? root : null
}

export interface GitFileChange {
  path: string
  /** Two-character porcelain status, e.g. "M ", " M", "??". */
  status: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitStatusView {
  isRepo: boolean
  root?: string
  branch?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  additions: number
  removals: number
  checkpoint?: { turnId: string; createdAt: string }
}

function parsePorcelain(stdout: string): GitFileChange[] {
  const parts = stdout.split('\0')
  const files: GitFileChange[] = []
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]
    if (!entry || entry.length < 3) continue
    const status = entry.slice(0, 2)
    const filePath = entry.slice(3)
    files.push({
      path: filePath,
      status,
      staged: status[0] !== ' ' && status[0] !== '?' && status[0] !== '!',
      unstaged: status[1] !== ' ' && status[1] !== '?',
      untracked: status === '??',
    })
    // Rename/copy entries carry the original path as the next NUL field.
    if (status[0] === 'R' || status[0] === 'C') index++
  }
  return files
}

function parseNumstat(stdout: string): { additions: number; removals: number } {
  let additions = 0
  let removals = 0
  for (const line of stdout.split('\n')) {
    const [added, removed] = line.split('\t')
    const plus = Number(added)
    const minus = Number(removed)
    if (Number.isFinite(plus)) additions += plus
    if (Number.isFinite(minus)) removals += minus
  }
  return { additions, removals }
}

export interface GitCheckpoint {
  turnId: string
  root: string
  head: string | null
  stash: string | null
  untracked: string[]
  createdAt: string
}

async function untrackedFiles(root: string): Promise<string[]> {
  const result = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  return result.stdout.split('\0').filter(Boolean)
}

export async function createTurnCheckpoint(cwd: string, turnId: string): Promise<GitCheckpoint | null> {
  const root = await gitRepoRoot(cwd)
  if (!root) return null
  const headResult = await git(root, ['rev-parse', 'HEAD'])
  const head = headResult.code === 0 ? headResult.stdout.trim() : null
  let stash: string | null = null
  if (head) {
    const stashResult = await git(root, ['stash', 'create'])
    stash = stashResult.code === 0 && stashResult.stdout.trim() ? stashResult.stdout.trim() : null
  }
  return {
    turnId,
    root,
    head,
    stash,
    untracked: await untrackedFiles(root),
    createdAt: new Date().toISOString(),
  }
}

export async function undoCheckpoint(checkpoint: GitCheckpoint): Promise<{
  restored: number
  deleted: number
  message: string
}> {
  const root = checkpoint.root
  const before = new Set(checkpoint.untracked)

  let restored = 0
  if (checkpoint.stash) {
    const result = await git(root, ['checkout', checkpoint.stash, '--', '.'])
    if (result.code !== 0) {
      return { restored: 0, deleted: 0, message: `git checkout failed: ${result.stderr.trim()}` }
    }
    restored = 1
  } else if (checkpoint.head) {
    const result = await git(root, ['checkout', checkpoint.head, '--', '.'])
    if (result.code !== 0) {
      return { restored: 0, deleted: 0, message: `git checkout failed: ${result.stderr.trim()}` }
    }
    restored = 1
  }

  // Delete untracked files that appeared during the turn only.
  let deleted = 0
  const current = await untrackedFiles(root)
  for (const relative of current) {
    if (before.has(relative)) continue
    const target = path.join(root, relative)
    try {
      await fs.rm(target, { recursive: true, force: true })
      deleted++
    } catch {
      // Leave files we cannot remove and report the count that worked.
    }
  }

  return {
    restored,
    deleted,
    message:
      restored > 0
        ? `Restored tracked files to the checkpoint and removed ${deleted} new untracked file(s).`
        : `Removed ${deleted} new untracked file(s); there were no tracked changes to restore.`,
  }
}

export async function gitStatus(
  cwd: string,
  checkpoint?: { turnId: string; createdAt: string },
): Promise<GitStatusView> {
  const root = await gitRepoRoot(cwd)
  if (!root) return { isRepo: false, files: [], additions: 0, removals: 0 }
  const [statusResult, branchResult] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--branch']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  let branch = branchResult.code === 0 ? branchResult.stdout.trim() : ''
  let ahead = 0
  let behind = 0
  let body = statusResult.stdout
  // The --branch header arrives as the first NUL-terminated field.
  const headerMatch = /^## ([^\0]+)\0/.exec(body)
  if (headerMatch) {
    const header = headerMatch[1]!
    body = body.slice(headerMatch[0].length)
    const aheadMatch = /ahead (\d+)/.exec(header)
    const behindMatch = /behind (\d+)/.exec(header)
    if (aheadMatch) ahead = Number(aheadMatch[1])
    if (behindMatch) behind = Number(behindMatch[1])
    if (!branch || branch === 'HEAD') {
      const branchName = header.split('...')[0]?.trim()
      if (branchName && !branchName.startsWith('No commits')) branch = branchName
    }
  }
  const files = parsePorcelain(body)
  const [unstagedStats, stagedStats] = await Promise.all([
    git(root, ['diff', '--numstat']),
    git(root, ['diff', '--cached', '--numstat']),
  ])
  const unstaged = parseNumstat(unstagedStats.stdout)
  const staged = parseNumstat(stagedStats.stdout)
  return {
    isRepo: true,
    root,
    branch: branch || undefined,
    ahead,
    behind,
    files,
    additions: unstaged.additions + staged.additions,
    removals: unstaged.removals + staged.removals,
    ...(checkpoint ? { checkpoint } : {}),
  }
}

interface ParsedWorktree {
  path: string
  branch?: string
  locked?: boolean
}

async function listWorktrees(cwd: string): Promise<ParsedWorktree[]> {
  const result = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (result.code !== 0) return []
  const worktrees: ParsedWorktree[] = []
  for (const block of result.stdout.split(/\n\s*\n/)) {
    const entry: ParsedWorktree = { path: '' }
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
      else if (line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length)
      else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true
    }
    if (entry.path) worktrees.push(entry)
  }
  for (const worktree of worktrees) {
    if (!worktree.locked && (await worktreeLocked(worktree.path))) worktree.locked = true
  }
  return worktrees
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Resolve symlinks so /var/... and /private/var/... compare equal on macOS. */
async function canonicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** Git < 2.17 does not report `locked` in `worktree list --porcelain`; the
 *  administrative directory carries a `locked` file instead. */
async function worktreeLocked(target: string): Promise<boolean> {
  const result = await git(target, ['rev-parse', '--git-dir'])
  if (result.code !== 0) return false
  const adminDir = path.resolve(target, result.stdout.trim())
  return pathExists(path.join(adminDir, 'locked'))
}

/** Local branches plus the worktree (if any) that has each one checked out.
 *  Used by the "open branch in a window" picker. */
export async function gitBranches(cwd: string): Promise<BranchListView> {
  const root = await gitRepoRoot(cwd)
  if (!root) return { isRepo: false, branches: [] }
  const [branchResult, currentResult, worktrees] = await Promise.all([
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    listWorktrees(root),
  ])
  const current = currentResult.code === 0 ? currentResult.stdout.trim() : ''
  const mainPath = worktrees[0]?.path ? await canonicalPath(worktrees[0].path) : undefined
  const byBranch = new Map<string, { path: string; removable: boolean }>()
  for (const entry of worktrees) {
    if (!entry.branch) continue
    if (!(await isDirectory(entry.path))) continue
    byBranch.set(entry.branch, {
      path: entry.path,
      removable: mainPath !== undefined && !entry.locked && (await canonicalPath(entry.path)) !== mainPath,
    })
  }
  const names = branchResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const branches = names
    .map((name) => {
      const worktree = byBranch.get(name)
      return {
        name,
        current: name === current,
        ...(worktree ? { worktreePath: worktree.path, removable: worktree.removable } : {}),
      }
    })
    .sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name))
  return { isRepo: true, ...(current && current !== 'HEAD' ? { current } : {}), branches }
}

/** Return the worktree for `branch`, creating a sibling directory when the
 *  branch is not checked out anywhere yet. */
export async function openBranchWorktree(cwd: string, branch: string): Promise<WorktreeOpenResult> {
  const root = await gitRepoRoot(cwd)
  if (!root) throw new Error('当前工作区不是 Git 仓库')
  const target = branch.trim()
  if (!target) throw new Error('分支名不能为空')
  const refs = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  const branches = refs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!branches.includes(target)) throw new Error(`分支不存在：${target}`)

  // A manually deleted worktree directory leaves a stale record and would make
  // `git worktree add` fail with "already checked out".
  await git(root, ['worktree', 'prune'])
  const worktrees = await listWorktrees(root)
  const existing = worktrees.find((entry) => entry.branch === target)
  if (existing && (await isDirectory(existing.path))) {
    return { branch: target, workspacePath: existing.path, created: false }
  }

  const mainPath = worktrees[0]?.path ?? root
  const parent = path.dirname(mainPath)
  const base = path.basename(mainPath)
  const safe = target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'branch'
  let workspacePath = path.join(parent, `${base}-${safe}`)
  let suffix = 2
  while (await pathExists(workspacePath)) {
    workspacePath = path.join(parent, `${base}-${safe}-${suffix++}`)
  }
  const added = await git(root, ['worktree', 'add', workspacePath, target])
  if (added.code !== 0) {
    throw new Error(added.stderr.trim() || `git worktree add 失败：${target}`)
  }
  return { branch: target, workspacePath, created: true }
}

/** Remove a linked worktree. The main checkout and the workspace this runtime
 *  is currently using are never allowed. Dirty worktrees need `force`. */
export async function removeBranchWorktree(
  cwd: string,
  targetPath: string,
  force = false,
): Promise<{ path: string; removed: boolean; forced: boolean }> {
  const root = await gitRepoRoot(cwd)
  if (!root) throw new Error('当前工作区不是 Git 仓库')
  const raw = targetPath.trim()
  if (!raw) throw new Error('worktree 路径为空')
  const target = await canonicalPath(raw)
  await git(root, ['worktree', 'prune'])
  const worktrees = await listWorktrees(root)
  const mainPath = worktrees[0]?.path ? await canonicalPath(worktrees[0].path) : undefined
  let entry: ParsedWorktree | undefined
  for (const worktree of worktrees) {
    if ((await canonicalPath(worktree.path)) === target) {
      entry = worktree
      break
    }
  }
  if (!entry) throw new Error('找不到该 worktree（可能已被移除）')
  if (entry.locked) throw new Error('该 worktree 已锁定，请先在 Git 中解锁')
  if (mainPath && mainPath === target) throw new Error('不能移除主工作区')
  const current = await canonicalPath(cwd)
  if (current === target || current.startsWith(`${target}${path.sep}`)) {
    throw new Error('不能移除当前窗口正在使用的工作区，请先关闭该窗口')
  }
  if (!force) {
    const status = await git(target, ['status', '--porcelain'])
    if (status.code === 0 && status.stdout.trim()) {
      throw new Error('该 worktree 有未提交的改动，请先提交，或选择强制移除')
    }
  }
  const args = force ? ['worktree', 'remove', '--force', target] : ['worktree', 'remove', target]
  const result = await git(root, args)
  if (result.code !== 0) {
    // `git worktree remove` arrived in Git 2.17; older installations only
    // offer add/list/lock/prune/unlock. Removing the directory and pruning the
    // administrative record is the equivalent operation there.
    const unsupported = result.code === 129 || /usage: git worktree|unknown subcommand/i.test(result.stderr)
    if (!unsupported) throw new Error(result.stderr.trim() || '移除 worktree 失败')
    try {
      await fs.rm(target, { recursive: true, force: true })
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '移除 worktree 失败')
    }
    await git(root, ['worktree', 'prune'])
    const remaining = await listWorktrees(root)
    for (const worktree of remaining) {
      if ((await canonicalPath(worktree.path)) === target) {
        throw new Error('移除 worktree 失败（该 worktree 可能已被锁定）')
      }
    }
    return { path: target, removed: true, forced: force }
  }
  await git(root, ['worktree', 'prune'])
  return { path: target, removed: true, forced: force }
}

/** Drop records for worktree directories that no longer exist. */
export async function pruneWorktrees(cwd: string): Promise<void> {
  const root = await gitRepoRoot(cwd)
  if (!root) throw new Error('当前工作区不是 Git 仓库')
  await git(root, ['worktree', 'prune'])
}

export async function gitFileDiff(
  cwd: string,
  relativePath: string,
  staged: boolean,
): Promise<{ diff: string; truncated: boolean }> {
  const root = await gitRepoRoot(cwd)
  if (!root) return { diff: '', truncated: false }
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--', relativePath])
  const entry = parsePorcelain(status.stdout)[0]
  if (entry?.untracked) {
    const target = path.join(root, relativePath)
    try {
      const stats = await fs.stat(target)
      if (stats.isDirectory()) return { diff: '', truncated: false }
      const buffer = await fs.readFile(target)
      const text = buffer.subarray(0, DIFF_MAX_BYTES).toString('utf8')
      const lines = text.split('\n').map((line) => `+${line}`)
      return {
        diff: [`--- /dev/null`, `+++ b/${relativePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines].join('\n'),
        truncated: buffer.length > DIFF_MAX_BYTES,
      }
    } catch {
      return { diff: '', truncated: false }
    }
  }

  const args = staged ? ['diff', '--cached', '--', relativePath] : ['diff', '--', relativePath]
  const result = await git(root, args)
  const text = result.stdout
  if (Buffer.byteLength(text, 'utf8') <= DIFF_MAX_BYTES) return { diff: text, truncated: false }
  return { diff: Buffer.from(text, 'utf8').subarray(0, DIFF_MAX_BYTES).toString('utf8'), truncated: true }
}
