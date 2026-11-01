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
      return openBranchWorktree(host.workspace(), branch, remoteRef)
    },
    async createWorktree(branch, from, parentDir) {
      return createBranchWorktree(host.workspace(), branch, from, parentDir)
    },
    async removeWorktree(targetPath, force) {
      return removeBranchWorktree(host.workspace(), targetPath, force === true)
    },
    async prune() {
      await pruneWorktrees(host.workspace())
      return { ok: true }
    },
  }
}
