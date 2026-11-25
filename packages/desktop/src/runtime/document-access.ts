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

export class DocumentPathError extends Error {
  constructor(
    readonly code: 'document-path-unresolvable',
    message: string,
  ) {
    super(message)
    this.name = 'DocumentPathError'
  }
}

/**
 * 解析真实路径。只有 ENOENT 可以降级：对“最深的已存在祖先”做 realpath，
 * 再把尚不存在的后缀拼回去。这样 `workspace/link/new-file.md`（link 指向
 * 工作区外的目录）仍会被解析成工作区外的路径并拒绝，而其它错误
 * （EACCES/ELOOP/ENOTDIR）说明路径本身不可信，必须 fail closed，绝不能
 * 返回未解析的字面路径——那会让 `isWithin` 的工作区前缀校验失效。
 */
export function physicalPath(input: string): string {
  const target = path.resolve(input)
  const suffix: string[] = []
  let current = target
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        throw new DocumentPathError('document-path-unresolvable', `无法解析文档路径：${code ?? 'unknown'}`)
      }
      const parent = path.dirname(current)
      if (parent === current) return target
      suffix.unshift(path.basename(current))
      current = parent
    }
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
