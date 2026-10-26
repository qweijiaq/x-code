// @x-code-cli/core — 知识加载器
//
// 分层项目上下文加载。来源（节内按根到叶的优先级；各节按下述顺序拼接）：
//
//   1. 用户 AGENTS.md（~/.x-code/）——缺失时回退到 CLAUDE.md
//   2. 用户记忆 Core profile（~/.x-code/memory/MEMORY.md）
//   3. 项目 AGENTS.md 链——每目录回退到 CLAUDE.md
//   4. 项目根目录的 AGENTS.local.md        ——个人偏好，已 gitignore
//
// 对模型而言后面的节权重更高：monorepo 子包（链中更深）覆盖共享上下文，
// 本地个人偏好覆盖团队共享的知识文件。
//
// 文件名策略是只读回退：在每个目录里先找 `AGENTS.md`（我们的约定，也是
// `/init` 所创建的），仅当它不存在时才回退到 `CLAUDE.md`（Claude Code 兼容——
// 让已有 CLAUDE.md 的用户无需重命名即可继续使用）。当两者在同一目录共存时，
// AGENTS.md 直接胜出，CLAUDE.md 被忽略。写入（`/init`、未来的工具）始终针对
// AGENTS.md。
import path from 'node:path'

import { fileExists, readFileSafe, userXcodeDir } from '../utils.js'
import type { MemoryService } from './memory/service.js'

/** 每个目录中识别的文件名，按顺序尝试。找到的第一个在该目录胜出；其余被
 *  跳过。AGENTS.md 是我们的首选约定；CLAUDE.md 是只读的兼容回退。 */
const KNOWLEDGE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** 读取 `dir` 中 AGENTS.md / CLAUDE.md 里存在的那个，优先前者。两者都不存在
 *  时返回 null。 */
async function readKnowledgeFile(dir: string): Promise<{ fileName: string; filePath: string; content: string } | null> {
  for (const fileName of KNOWLEDGE_FILENAMES) {
    const filePath = path.join(dir, fileName)
    const content = await readFileSafe(filePath)
    if (content) return { fileName, filePath, content }
  }
  return null
}

/**
 * 从 `startDir` 向上遍历，每目录收集一个知识文件。与 Codex 约定一致：仓库根
 * 文件适用于整个项目，包级文件（在 monorepo 中）以更具体的上下文覆盖它。
 * 在第一个包含 `.git` 的目录（含该目录）或文件系统根处停止。
 *
 * 按根到叶的顺序返回条目，因此最深的文件最后追加。每个目录至多贡献一个
 * 条目（有 AGENTS.md 就用它，否则用 CLAUDE.md，再否则跳过）。
 */
async function collectProjectKnowledgeChain(
  startDir: string,
): Promise<Array<{ dir: string; fileName: string; filePath: string; content: string }>> {
  const dirs: string[] = []
  let dir = path.resolve(startDir)
  const fsRoot = path.parse(dir).root

  while (true) {
    dirs.push(dir)
    if (await fileExists(path.join(dir, '.git'))) break
    if (dir === fsRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const entries: Array<{ dir: string; fileName: string; filePath: string; content: string }> = []
  for (const d of dirs.reverse()) {
    const found = await readKnowledgeFile(d)
    if (found) entries.push({ dir: d, ...found })
  }
  return entries
}

/** 构建完整的知识上下文，用于注入系统提示 */
export async function buildKnowledgeContext(options?: {
  sessionContext?: string
  memoryService?: MemoryService
  cwd?: string
}): Promise<string> {
  const sections: string[] = []
  const seenPaths = new Set<string>()
  const seenContents = new Set<string>()
  const pushUniqueSection = (heading: string, content: string, filePath?: string): void => {
    const resolvedPath = filePath ? path.resolve(filePath).replace(/\\/g, '/') : undefined
    const normalizedPath = resolvedPath && process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
    if ((normalizedPath && seenPaths.has(normalizedPath)) || seenContents.has(content)) return
    if (normalizedPath) seenPaths.add(normalizedPath)
    seenContents.add(content)
    sections.push(`${heading}\n${content}`)
  }

  // 用户作用域人工撰写的偏好：优先 AGENTS.md；回退到 CLAUDE.md，让已有
  // `~/.x-code/CLAUDE.md`（或从 Claude Code 主目录复制来的那个）的用户无需
  // 重命名即可被拾取。
  const userKnowledge = await readKnowledgeFile(userXcodeDir())
  if (userKnowledge) {
    pushUniqueSection(
      `### User Preferences (~/.x-code/${userKnowledge.fileName})`,
      userKnowledge.content,
      userKnowledge.filePath,
    )
  }

  const userMemoryContent = options?.memoryService?.getCoreProfile().trim()
  if (userMemoryContent) {
    pushUniqueSection('### User Auto Memory', userMemoryContent)
  }

  const cwd = options?.cwd ?? process.cwd()
  const projectKnowledge = await collectProjectKnowledgeChain(cwd)
  for (const entry of projectKnowledge) {
    const relPath = path.relative(cwd, entry.dir) || '.'
    pushUniqueSection(`### Project ${entry.fileName} (${relPath})`, entry.content, entry.filePath)
  }

  const localPrefs = await readFileSafe(path.join(cwd, 'AGENTS.local.md'))
  if (localPrefs) {
    pushUniqueSection('### Local Preferences (AGENTS.local.md)', localPrefs, path.join(cwd, 'AGENTS.local.md'))
  }

  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## Project Knowledge\n\n' + sections.join('\n\n')
}
