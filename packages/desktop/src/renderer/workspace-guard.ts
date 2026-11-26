/** 检测提示词中指向当前工作区之外的绝对路径。
 *
 *  当沙箱允许时，agent 可以读取工作区外的文件并运行 shell 命令，
 *  这很容易让人漏掉「忘记切换项目」的情况。
 *  这里刻意保守：只考虑用户主目录（macOS / Linux）、可移动卷挂载点和
 *  Windows 盘符路径，忽略 URL 和系统路径。
 *
 *  路径前允许出现的边界字符：空白、引号、各类括号、Markdown / 代码引用符号
 *  和全角标点。各模式共用同一份定义，避免两边对「路径边界」的判断不一致
 *  而漏报（例如 `[/Users/x/a.ts](…)`、`code=/Users/x/a`、`、/Users/x/a`）。 */
const PATH_BOUNDARY = '[\\s"\'`(\\[<>=*，。、；：！？（【]'
/** 路径正文：遇空白、引号、括号或标点（含全角）即结束。 */
const PATH_BODY = '[^\\s"\'`()\\[\\]{}<>，。；：！？、（）【】《》]+'

const PATH_PATTERNS = [
  new RegExp(`(?:^|${PATH_BOUNDARY})(~/${PATH_BODY})`, 'g'),
  new RegExp(`(?:^|${PATH_BOUNDARY})(/Users/${PATH_BODY})`, 'g'),
  new RegExp(`(?:^|${PATH_BOUNDARY})(/Volumes/${PATH_BODY})`, 'g'),
  // Linux / CI 桌面端：主目录与常见可移动卷的挂载点。
  new RegExp(`(?:^|${PATH_BOUNDARY})(/home/${PATH_BODY})`, 'g'),
  new RegExp(`(?:^|${PATH_BOUNDARY})(/(?:mnt|media)/${PATH_BODY})`, 'g'),
  new RegExp(`(?:^|${PATH_BOUNDARY})([A-Za-z]:\\\\${PATH_BODY})`, 'g'),
]

function trimPath(value: string): string {
  return value.replace(/[.,;:!?，。；：！？)\]}*]+$/u, '')
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
