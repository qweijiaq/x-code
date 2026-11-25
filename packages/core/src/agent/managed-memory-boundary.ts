import os from 'node:os'
import path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'

const MEMORY_MUTATING_COMMAND_RE =
  /(?:^|[\s;|&])(?:add-content|copy-item|mkdir|move-item|mv|new-item|out-file|remove-item|rename-item|rm|sed\s+-i|set-content|tee|touch|truncate)\b/i

function normalizePath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/')
  // POSIX 文件系统大小写敏感：只有 Windows 才需要折叠大小写。否则
  // `/home/u/.X-CODE/MEMORY` 会被当成受管记忆目录——对
  // isManagedMemoryAccess 而言后果更严重（合法工具输出会被静默丢弃）。
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 命令文本必须与 {@link normalizePath} 用同一套大小写规则归一化：标记是按
 *  normalizePath 产出的，若这里在 POSIX 上无条件小写化就永远匹配不到它们。 */
function normalizeCommandText(command: string): string {
  const slashed = command.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
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

/** PowerShell 环境变量引用写法：`$env:NAME` / `${env:NAME}`。变量名在 Windows
 *  上会被 {@link normalizeCommandText} 折叠成小写，在 POSIX 上保持原样，所以两种
 *  大小写都要登记，否则 `Remove-Item $env:USERPROFILE\.x-code\memory\...` 这种
 *  命令会因为不匹配任何标记而被判为「未引用记忆」。 */
const ENV_VARIABLE_FORMS = ['userprofile', 'USERPROFILE', 'home', 'HOME'] as const

function shellMemoryMarkers(memoryRoot: string): string[] {
  const markers = new Set([normalizePath(memoryRoot)])
  const relativeToHome = path.relative(os.homedir(), path.resolve(memoryRoot)).replace(/\\/g, '/')
  if (relativeToHome && relativeToHome !== '..' && !relativeToHome.startsWith('../')) {
    const relative = process.platform === 'win32' ? relativeToHome.toLowerCase() : relativeToHome
    markers.add(`~/${relative}`)
    markers.add(`$home/${relative}`)
    markers.add(`\${home}/${relative}`)
    markers.add(`%userprofile%/${relative}`)
    for (const variable of ENV_VARIABLE_FORMS) {
      markers.add(`$env:${variable}/${relative}`)
      markers.add(`\${env:${variable}}/${relative}`)
    }
  }
  if (
    process.env.X_CODE_HOME &&
    normalizePath(path.join(process.env.X_CODE_HOME, 'memory')) === normalizePath(memoryRoot)
  ) {
    markers.add('$x_code_home/memory')
    markers.add('${x_code_home}/memory')
    markers.add('%x_code_home%/memory')
    markers.add('$env:x_code_home/memory')
    markers.add('${env:x_code_home}/memory')
    markers.add('$env:X_CODE_HOME/memory')
    markers.add('${env:X_CODE_HOME}/memory')
  }
  return [...markers]
}

/** 分段所用的 shell 工作目录：`cwd` 缺省时按会话 projectCwd 解析。 */
function shellCwd(input: Record<string, unknown>, projectCwd: string | undefined): string {
  const cwd = input.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return resolveCwd(cwd, projectCwd)
  return path.resolve(projectCwd ?? process.cwd())
}

/** 解析会改变后续相对路径基准的分段。
 *  - `undefined` → 不是 cd/pushd 分段
 *  - `null` → 是 cd 但解析不出目标（裸 `cd`、`cd -`、带无法识别的开关），调用方
 *    必须按 fail-closed 处理：后续分段的相对路径可能已经落在记忆目录里
 *  - 其余 → 目标路径（可能仍含 `~`） */
function cdTarget(part: string): string | null | undefined {
  const trimmed = part.trim()
  const match = /^(?:cd|pushd|set-location|sl)\b/i.exec(trimmed)
  if (!match) return undefined
  const raw = trimmed
    .slice(match[0].length)
    .trim()
    .replace(/^\/[dl]\b\s*/i, '')
    .replace(/^-[A-Za-z]+\s+/, '')
    .replace(/^["']|["']$/g, '')
    .trim()
  if (!raw || raw === '-') return null
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/** `>{1,2} <marker>` 形式的重定向写入：`echo x > ~/.x-code/memory/profile.md` 的
 *  命令部分本身是只读的，写入发生在重定向上。 */
function redirectsIntoMarker(normalizedPart: string, markers: readonly string[]): boolean {
  return markers.some((marker) => new RegExp(`>{1,2}\\s*["']?${regexEscape(marker)}`).test(normalizedPart))
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
  const markers = shellMemoryMarkers(memoryRoot)
  // 逐段评估，而不是「整条命令里出现过标记就拒绝任何写操作」：
  // `cat ~/.x-code/memory/topics/profile.md && npm run build` 的后半段与记忆无关，
  // 整条拒绝会让模型反复重试一个永远不会成功的构建，且错误文案说成「记忆由
  // post-turn 服务写入」，与真实原因不符。
  //
  // `cd`/`pushd` 分段会把相对路径的基准移进记忆目录（`cd ~/.x-code/memory &&
  // rm profile.md` 的后半段自身不含任何标记），所以必须跟踪它；解析不出目标时
  // 按 fail-closed 处理：后续分段的相对路径一律视为可能落在记忆目录内。
  let segmentCwd: string | null = shellCwd(input, projectCwd)
  for (const part of splitShellCommands(command)) {
    const target = cdTarget(part)
    if (target !== undefined) {
      segmentCwd =
        target === null
          ? null
          : path.isAbsolute(target)
            ? target
            : path.resolve(segmentCwd ?? projectCwd ?? process.cwd(), target)
      continue
    }
    const normalizedPart = normalizeCommandText(part)
    const referencesMemory =
      segmentCwd === null ||
      isPathInside(segmentCwd, memoryRoot) ||
      markers.some((marker) => normalizedPart.includes(marker))
    if (!referencesMemory) continue
    if (!isReadOnly(part)) return true
    // `echo beta > profile.md` 之类的只读命令通过重定向写入记忆。
    if (redirectsIntoMarker(normalizedPart, markers)) return true
    if (MEMORY_MUTATING_COMMAND_RE.test(part)) return true
  }
  return false
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
  const command = typeof input.command === 'string' ? normalizeCommandText(input.command) : ''
  return shellMemoryMarkers(memoryRoot).some((marker) => command.includes(marker))
}
