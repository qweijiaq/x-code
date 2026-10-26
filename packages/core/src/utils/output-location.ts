import os from 'node:os'
import path from 'node:path'

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  // macOS exposes /tmp and /var as /private/... to some APIs; compare the
  // user-facing form so both spellings hit the same rule.
  return process.platform === 'darwin' && resolved.startsWith('/private/')
    ? resolved.slice('/private'.length)
    : resolved
}

/** Whether a path belongs to the OS temporary area. Only used to nudge the
 *  model toward the workspace; it never blocks a write. */
export function isSystemTempPath(filePath: string): boolean {
  const target = comparablePath(filePath)
  const roots = [os.tmpdir(), '/tmp', '/var/tmp']
  return roots.some((root) => {
    const normalized = comparablePath(root)
    return target === normalized || target.startsWith(normalized + path.sep)
  })
}

/** Model-facing reminder appended to a tool result when a deliverable landed
 *  in the system temp directory. */
export function workspaceOutputNote(filePath: string, cwd = process.cwd()): string {
  if (!isSystemTempPath(filePath)) return ''
  return `\n\n[Output location] ${path.resolve(filePath)} is in the system temporary directory. Files the user should keep belong inside the working directory (${cwd}). Use temp only for disposable intermediates and remove them when the task is done.`
}
