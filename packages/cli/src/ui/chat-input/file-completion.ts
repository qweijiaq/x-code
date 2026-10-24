// @x-code-cli/cli — React hook wrapper around core's workspace file scanner.
//
// The pure scanner/ranker lives in `@x-code-cli/core` so the desktop renderer
// can share it; only the lifecycle hook is terminal-specific.
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
}

/** React hook: scan once on mount, expose entries + loading flag. cwd is
 *  read from `process.cwd()` at scan time and never re-checked — shell
 *  tools that internally chdir don't affect the menu. */
export function useFileCompletion(): UseFileCompletionResult {
  const [entries, setEntries] = useState<readonly FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    scanWorkspaceFiles({ rootDir: process.cwd(), signal: ac.signal })
      .then((result) => {
        if (cancelled) return
        setEntries(result)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  return { entries, loading }
}
