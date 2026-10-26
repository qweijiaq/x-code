import fs from 'node:fs/promises'
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?\])}]+$/, '')
}

/** 从命令文本里找出可能被写入的临时文件。命令里的 $TMPDIR 会先展开，
 *  否则模型常用的 `$TMPDIR/out.txt` 会漏掉。 */
export function tempPathsInText(text: string): string[] {
  const expanded = text.replace(/\$\{TMPDIR\}|\$TMPDIR\b/g, os.tmpdir())
  const patterns = [
    /(?:\/private)?\/(?:tmp|var\/tmp)\/[^\s"'`;|&<>]+/g,
    new RegExp(`${escapeRegExp(os.tmpdir())}/[^\\s"'\\\`;|&<>]+`, 'g'),
  ]
  const paths = new Set<string>()
  for (const pattern of patterns) {
    for (const match of expanded.matchAll(pattern)) {
      const candidate = stripTrailingPunctuation(match[0])
      if (candidate) paths.add(path.resolve(candidate))
    }
  }
  return [...paths]
}

/** 命令结束后检查候选路径是否在本次执行期间被创建或修改。只读取旧临时
 *  文件的命令不会触发提醒。返回可直接拼在工具结果后的提示。 */
export async function noteForRecentTempFiles(
  command: string,
  wallTimeMs: number,
  cwd = process.cwd(),
): Promise<string> {
  const cutoff = Date.now() - Math.max(0, wallTimeMs) - 10_000
  const notes: string[] = []
  for (const candidate of tempPathsInText(command)) {
    if (notes.length >= 5) break
    try {
      const stats = await fs.stat(candidate)
      if (stats.isFile() && stats.mtimeMs >= cutoff) notes.push(workspaceOutputNote(candidate, cwd))
    } catch {
      // 路径可能只是命令参数，并未真正创建文件。
    }
  }
  return notes.join('')
}
