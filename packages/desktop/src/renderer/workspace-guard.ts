/** Detect absolute paths in a prompt that point outside the active workspace.
 *
 *  The agent can read files and run shell commands outside the workspace when
 *  the sandbox allows it, which makes "forgot to switch projects" easy to miss.
 *  This is intentionally conservative: only user-home, removable-volume and
 *  Windows-drive paths are considered, and URLs / system paths are ignored.
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
