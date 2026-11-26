// @x-code-cli/desktop — Git 与 worktree 操作
//
// 状态/diff/分支/worktree 都是围绕 workspace 的无状态包装；抽成 controller 后
// AgentHost 只保留需要自身状态的 revert/undo/checkpoint。
import type { BranchListView, GitStatusView, WorktreeOpenResult } from '../shared/protocol.js'
import {
  createBranchWorktree,
  gitBranches,
  gitFileDiff,
  gitStatus,
  openBranchWorktree,
  pruneWorktrees,
  removeBranchWorktree,
} from './git.js'

export interface GitControllerHost {
  workspace(): string
  latestCheckpoint(): { turnId: string; createdAt: string } | undefined
}

export interface GitController {
  status(): Promise<GitStatusView>
  diff(relativePath: string, staged?: boolean): Promise<{ diff: string; truncated: boolean }>
  branches(): Promise<BranchListView>
  openWorktree(branch: string, remoteRef?: string): Promise<WorktreeOpenResult>
  createWorktree(branch: string, from?: string, parentDir?: string): Promise<WorktreeOpenResult>
  removeWorktree(targetPath: string, force?: boolean): Promise<{ path: string; removed: boolean; forced: boolean }>
  prune(): Promise<{ ok: boolean }>
}

export function createGitController(host: GitControllerHost): GitController {
  /** worktree 操作内部是「prune → list → 判断是否存在 → add」的检查后执行
   *  序列（git.ts 的 openBranchWorktree / createBranchWorktree），渲染端重复
   *  点击或并发请求会让两次 `git worktree add` 交错执行，出现
   *  「already checked out」或多余的同级目录。这里对同一 workspace 的操作串行化。 */
  let worktreeQueue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = worktreeQueue.then(task, task)
    worktreeQueue = next.catch(() => undefined)
    return next
  }

  return {
    async status() {
      return gitStatus(host.workspace(), host.latestCheckpoint())
    },
    async diff(relativePath, staged) {
      return gitFileDiff(host.workspace(), relativePath, staged === true)
    },
    async branches() {
      return gitBranches(host.workspace())
    },
    async openWorktree(branch, remoteRef) {
      return serialize(() => openBranchWorktree(host.workspace(), branch, remoteRef))
    },
    async createWorktree(branch, from, parentDir) {
      return serialize(() => createBranchWorktree(host.workspace(), branch, from, parentDir))
    },
    async removeWorktree(targetPath, force) {
      return serialize(() => removeBranchWorktree(host.workspace(), targetPath, force === true))
    },
    async prune() {
      await serialize(() => pruneWorktrees(host.workspace()))
      return { ok: true }
    },
  }
}
