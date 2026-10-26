import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  // macOS 对某些 API 会把 /tmp 和 /var 暴露为 /private/...；比较面向用户的
  // 形式，让两种写法命中同一条规则。
  return process.platform === 'darwin' && resolved.startsWith('/private/')
    ? resolved.slice('/private'.length)
    : resolved
}

/** 判断路径是否属于操作系统临时区域。仅用于把模型引导向工作区；它从不拦截
 *  写入。 */
export function isSystemTempPath(filePath: string): boolean {
  const target = comparablePath(filePath)
  const roots = [os.tmpdir(), '/tmp', '/var/tmp']
  return roots.some((root) => {
    const normalized = comparablePath(root)
    return target === normalized || target.startsWith(normalized + path.sep)
  })
}

/** 当交付物落到了系统临时目录时，追加到工具结果里的、面向模型的提醒。 */
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
