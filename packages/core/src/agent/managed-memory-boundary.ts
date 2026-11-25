import os from 'node:os'
import path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'

const MEMORY_MUTATING_COMMAND_RE =
  /(?:^|[\s;|&])(?:add-content|copy-item|mkdir|move-item|mv|new-item|out-file|remove-item|rename-item|rm|sed\s+-i|set-content|tee|touch|truncate)\b/i

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase()
}

function isPathInside(filePath: string, root: string): boolean {
  const file = normalizePath(filePath)
  const directory = normalizePath(root)
  return file === directory || file.startsWith(directory + '/')
}

/** 把可能是相对路径的 `cwd` 解析成绝对路径。必须按会话 projectCwd 解析，
 *  用 process.cwd() 会在两者不同时把边界判到错误的目录树上。 */
function resolveCwd(cwd: string, projectCwd: string | undefined): string {
  return path.isAbsolute(cwd) ? cwd : path.resolve(projectCwd ?? process.cwd(), cwd)
}

/** `shell` 的 cwd 落在记忆目录内时，命令里的相对路径同样构成受管记忆访问。 */
function isShellCwdInsideMemory(
  input: Record<string, unknown>,
  memoryRoot: string,
  projectCwd: string | undefined,
): boolean {
  const cwd = input.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  return isPathInside(resolveCwd(cwd, projectCwd), memoryRoot)
}

function shellMemoryMarkers(memoryRoot: string): string[] {
  const markers = new Set([normalizePath(memoryRoot)])
  const relativeToHome = path.relative(os.homedir(), path.resolve(memoryRoot)).replace(/\\/g, '/')
  if (relativeToHome && relativeToHome !== '..' && !relativeToHome.startsWith('../')) {
    const relative = relativeToHome.toLowerCase()
    markers.add(`~/${relative}`)
    markers.add(`$home/${relative}`)
    markers.add(`\${home}/${relative}`)
    markers.add(`%userprofile%/${relative}`)
  }
  if (
    process.env.X_CODE_HOME &&
    normalizePath(path.join(process.env.X_CODE_HOME, 'memory')) === normalizePath(memoryRoot)
  ) {
    markers.add('$x_code_home/memory')
    markers.add('${x_code_home}/memory')
    markers.add('%x_code_home%/memory')
  }
  return [...markers]
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 通用 agent 工具不得绕过持久化记忆存储的单一写入者。 */
export function isManagedMemoryMutation(
  toolName: string,
  input: Record<string, unknown>,
  memoryRoot: string | undefined,
  projectCwd?: string,
): boolean {
  if (!memoryRoot) return false
  if (toolName === 'writeFile' || toolName === 'edit') {
    const filePath = typeof input.filePath === 'string' ? input.filePath : ''
    return Boolean(filePath) && isPathInside(filePath, memoryRoot)
  }
  if (toolName !== 'shell') return false

  const command = typeof input.command === 'string' ? input.command : ''
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  // cwd 落在记忆目录内时，命令里出现的全是相对路径（`rm -rf topics/*.md`、
  // `echo x > profile.md`），下面按绝对标记做的判定会直接放行。这里先按 cwd 拦住。
  if (isShellCwdInsideMemory(input, memoryRoot, projectCwd)) {
    if (splitShellCommands(command).some((part) => !isReadOnly(part))) return true
    if (MEMORY_MUTATING_COMMAND_RE.test(command)) return true
  }
  const referencedMarkers = shellMemoryMarkers(memoryRoot).filter((marker) => normalized.includes(marker))
  if (referencedMarkers.length === 0) return false
  if (splitShellCommands(command).some((part) => !isReadOnly(part))) return true
  if (MEMORY_MUTATING_COMMAND_RE.test(command)) return true
  return referencedMarkers.some((marker) => new RegExp(`>{1,2}\\s*["']?${regexEscape(marker)}`).test(normalized))
}

/** 记忆诊断可以读取受管文件，而无需把它们作为聊天内容展示出来。 */
export function isManagedMemoryAccess(
  toolName: string,
  input: Record<string, unknown>,
  memoryRoot: string | undefined,
  projectCwd?: string,
): boolean {
  if (!memoryRoot) return false
  const pathKeys: Record<string, readonly string[]> = {
    readFile: ['filePath'],
    writeFile: ['filePath'],
    edit: ['filePath'],
    glob: ['cwd'],
    grep: ['path'],
    listDir: ['dirPath'],
  }
  const keys = pathKeys[toolName]
  if (keys?.some((key) => typeof input[key] === 'string' && isPathInside(input[key] as string, memoryRoot))) {
    return true
  }
  if (toolName !== 'shell') return false
  // cwd 在记忆目录内时，命令不含任何绝对标记（`cat topics/x.md`）同样是受管记忆访问。
  if (isShellCwdInsideMemory(input, memoryRoot, projectCwd)) return true
  const command = typeof input.command === 'string' ? input.command.replace(/\\/g, '/').toLowerCase() : ''
  return shellMemoryMarkers(memoryRoot).some((marker) => command.includes(marker))
}
