// @x-code-cli/cli — 核心工作区文件扫描器的 React hook 封装。
//
// 纯扫描/排序逻辑放在 `@x-code-cli/core` 里，桌面渲染器也能复用；
// 只有生命周期 hook 是终端特有的。
import { useEffect, useState } from 'react'

import { scanWorkspaceFiles } from '@x-code-cli/core'
import type { FileEntry } from '@x-code-cli/core'

export {
  applyCompletion,
  detectAtToken,
  parseSimpleGitignore,
  scanWorkspaceFiles,
  scoreAndRank,
} from '@x-code-cli/core'
export type { AtTrigger, FileEntry, ScanOptions, ScoredEntry } from '@x-code-cli/core'

export interface UseFileCompletionResult {
  entries: readonly FileEntry[]
  loading: boolean
  /** 扫描失败的原因（权限不足、目录不存在、磁盘 IO 错误…）。非 null 时
   *  `entries` 为空是因为失败而不是「工作区没有文件」——调用方应提示用户，
   *  而不是静默展示一个永远空着的补全列表。卸载时的 abort 不算失败。 */
  error: Error | null
}

/** React hook：挂载时扫描一次，暴露 entries 和 loading 标志。cwd 在扫描时
 *  从 `process.cwd()` 读取且不再重新检查——内部会 chdir 的 shell 工具
 *  不会影响菜单。 */
export function useFileCompletion(): UseFileCompletionResult {
  const [entries, setEntries] = useState<readonly FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    scanWorkspaceFiles({ rootDir: process.cwd(), signal: ac.signal })
      .then((result) => {
        if (cancelled) return
        setEntries(result)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 卸载时的 `ac.abort()` 是主动取消，不能当成「扫描失败」报给用户。
        if ((err as { name?: string } | null)?.name !== 'AbortError') {
          setError(err instanceof Error ? err : new Error(String(err)))
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  return { entries, loading, error }
}
