// @x-code-cli/desktop — 文档路径访问策略
//
// `document:*` 不应该成为 renderer 的任意路径读写入口。允许的范围是：
//   1. 当前工作区（含真实路径，阻止 symlink 逃逸）；
//   2. 用户通过原生文件选择器显式授权的路径（main → runtime 的不可伪造事件）；
//   3. 最近打开过的文档（用户此前已经授权过）。
//
// 这里刻意保持纯函数、无 Electron 依赖，便于单测覆盖。
import fs from 'node:fs'
import path from 'node:path'

export const MAX_GRANTED_DOCUMENTS = 100

export interface DocumentAccessOptions {
  workspaceRoot: () => string
  recentPaths: () => string[]
  maxGrants?: number
}

export interface DocumentAccess {
  grant(input: string): void
  assert(input: string): string
}

export function physicalPath(input: string): string {
  try {
    return fs.realpathSync.native(path.resolve(input))
  } catch {
    return path.resolve(input)
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(physicalPath(root), physicalPath(candidate))
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}

export function createDocumentAccess(options: DocumentAccessOptions): DocumentAccess {
  const granted = new Set<string>()
  const maxGrants = options.maxGrants ?? MAX_GRANTED_DOCUMENTS

  return {
    grant(input: string): void {
      granted.add(physicalPath(input))
      while (granted.size > maxGrants) {
        const oldest = granted.values().next().value
        if (!oldest) break
        granted.delete(oldest)
      }
    },

    assert(input: string): string {
      const resolved = physicalPath(input)
      if (isWithin(options.workspaceRoot(), resolved) || granted.has(resolved)) return resolved
      if (options.recentPaths().some((item) => physicalPath(item) === resolved)) return resolved
      throw new Error('document-path-not-allowed')
    },
  }
}
