/** 检测提示词中指向当前工作区之外的绝对路径。
 *
 *  当沙箱允许时，agent 可以读取工作区外的文件并运行 shell 命令，
 *  这很容易让人漏掉「忘记切换项目」的情况。
 *  这里刻意保守：只考虑用户主目录、可移动卷和 Windows 盘符路径，
 *  忽略 URL 和系统路径。
 */
const PATH_PATTERNS = [
  /(?:^|[\s"'`(])(~\/[^\s"'`()\[\]{}<>，。；：！？、]+)/g,
  /(?:^|[\s"'`(])(\/Users\/[^\s"'`()\[\]{}<>，。；：！？、]+)/g,
  /(?:^|[\s"'`(])(\/Volumes\/[^\s"'`()\[\]{}<>，。；：！？、]+)/g,
  /(?:^|[\s"'`(])([A-Za-z]:\\[^\s"'`()\[\]{}<>，。；：！？、]+)/g,
]

function trimPath(value: string): string {
  return value.replace(/[.,;:!?，。；：！？)\]}]+$/u, '')
}

function normalize(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed
}

function isInside(candidate: string, workspace: string): boolean {
  const path = normalize(candidate)
  const root = normalize(workspace)
  return path === root || path.startsWith(`${root}/`)
}

export function detectExternalWorkspacePaths(text: string, workspace: string): string[] {
  const root = workspace.trim()
  if (!root) return []
  const found = new Set<string>()
  for (const pattern of PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = trimPath(match[1] ?? '')
      if (!raw) continue
      if (raw.startsWith('~/')) {
        found.add(raw)
        continue
      }
      if (!isInside(raw, root)) found.add(raw)
    }
  }
  return [...found].slice(0, 5)
}
