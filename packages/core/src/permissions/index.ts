// @x-code-cli/core — 权限系统（三级模型）
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionDecision, PermissionLevel, PermissionMode } from '../types/index.js'
import { persistRule } from './persistence.js'
import { addSessionAllowRule, buildAllowRule, sessionRulesMatch } from './session-store.js'

type PermissionInput = Record<string, unknown>

/**
 * 以完整命令字符串为键的 shell 权限级别缓存。
 * 破坏性 / 只读模式的判定在进程生命周期内保持不变，因此普通 Map 即可，
 * 无需 TTL。上限用于防止长时间运行的 agent 无限制累积唯一命令。
 */
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

function evaluateShellPermission(command: string): PermissionLevel {
  const subCommands = splitShellCommands(command)
  // 任一子命令具有破坏性 → 拒绝整条命令
  if (subCommands.some(isDestructive)) return 'deny'
  // 所有子命令均为只读 → 自动允许
  if (subCommands.every(isReadOnly)) return 'always-allow'
  // 否则 → 询问
  return 'ask'
}

function resolveShellPermission(input: PermissionInput): PermissionLevel {
  const cmd = (input.command as string) ?? ''
  const cached = shellPermissionCache.get(cmd)
  if (cached) {
    // 刷新使用时间：命中时把条目移到末尾，使下方的“淘汰最旧”成为真正的 LRU 而非 FIFO。
    shellPermissionCache.delete(cmd)
    shellPermissionCache.set(cmd, cached)
    return cached
  }

  const level = evaluateShellPermission(cmd)

  if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
    // 淘汰最旧条目（Map 保持插入顺序）。
    const oldest = shellPermissionCache.keys().next().value
    if (oldest !== undefined) shellPermissionCache.delete(oldest)
  }
  shellPermissionCache.set(cmd, level)
  return level
}

/** 各工具的权限规则 */
const rules: Record<string, (input: PermissionInput) => PermissionLevel> = {
  readFile: () => 'always-allow',
  readDocument: () => 'always-allow',
  glob: () => 'always-allow',
  grep: () => 'always-allow',
  listDir: () => 'always-allow',
  webSearch: () => 'always-allow',
  webFetch: () => 'always-allow',
  askUser: () => 'always-allow',
  transcribe: () => 'always-allow',
  edit: () => 'ask',
  writeFile: () => 'ask',
  batchRename: () => 'ask',
  convert: () => 'ask',
  spreadsheet: (input) => (input.action === 'read' || input.action === 'query' ? 'always-allow' : 'ask'),
  documentExport: () => 'ask',
  documentSearch: () => 'always-allow',
  documentLibrary: (input) => (input.action === 'clear' ? 'ask' : 'always-allow'),
  shell: resolveShellPermission,
}

/** 获取某次工具调用的权限级别 */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  const rule = rules[toolName]
  if (!rule) return 'ask' // 未知工具默认询问
  return rule(input)
}

// ── 写工具的路径安全 ──
// 即使启用了 acceptEdits 也不应自动批准的敏感 dotfile / 配置路径。
// 对齐 Claude Code 的 isDangerousFilePathToAutoEdit。
const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.bashrc$/i,
  /[\\/]\.bash_profile$/i,
  /[\\/]\.profile$/i,
  /[\\/]\.zshrc$/i,
  /[\\/]\.zprofile$/i,
  /[\\/]\.gitconfig$/i,
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.env$/i,
  /[\\/]\.git[\\/]/i,
  /[\\/]\.vscode[\\/]/i,
  /[\\/]\.idea[\\/]/i,
]

/** 通过符号链接解析出最深层的已存在祖先目录，再拼接上不存在的后缀。
 * 这样权限检查就与文件系统实际将要修改的路径保持一致。 */
export function resolvePhysicalPath(filePath: string, baseDir: string = process.cwd()): string {
  let candidate = path.resolve(baseDir, filePath)
  const suffix: string[] = []
  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...suffix.reverse())
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return path.resolve(baseDir, filePath)
      suffix.push(path.basename(candidate))
      candidate = parent
    }
  }
}

/** 当 `filePath` 经物理解析后位于 `projectDir` 内（或与之相等）时返回 true。
 * 大小写折叠仅在 Windows 上生效；Linux 和区分大小写的 macOS 卷不得把不同路径混为一谈。 */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  const dir = resolvePhysicalPath(projectDir)
  const file = resolvePhysicalPath(filePath, projectDir)
  const relative = path.relative(dir, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))
}

/** 检查权限，支持信任模式与权限模式。
 *
 *  `permissionMode` 语义：
 *    - 'default'：行为与之前完全一致——`ask` 级别的工具会弹出询问。
 *    - 'acceptEdits'：仅当目标路径位于项目目录内且不是敏感 dotfile 时，
 *      自动允许 `writeFile` 与 `edit`。位于 cwd 之外或指向 .bashrc/.git 等
 *      的路径回退到 `ask`，要求用户明确同意。shell 仍走正常分类流程，
 *      破坏性命令依旧受限，`deny` 级别的结果也依旧拒绝。
 *    - 'plan'：agent 调度器暴露只读/计划白名单，并在进入本函数之前
 *      拒绝写入 currentPlanPath 之外的路径。
 *
 *  信任模式是全局覆盖，除显式 `deny` 外优先于一切。 */
export interface PermissionGateResult {
  approved: boolean
  /** 用户通过“No，并告诉 X-Code 该怎么做”选项拒绝时输入的自由文本说明；
   *  普通 No 时为 undefined。调用方会把它附到拒绝的工具结果上。 */
  feedback?: string
}

/** checkPermission 的详细版本，还会返回用户的拒绝反馈。
 * 下方布尔包装保留给只关心允许/拒绝的调用方（目标校验器、既有测试）。 */
export async function checkPermissionDetailed(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<PermissionDecision>,
  permissionMode: PermissionMode = 'default',
  projectCwd?: string,
  executionCwd?: string,
): Promise<PermissionGateResult> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)
  if (level === 'always-allow' || trustMode) return { approved: true }
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    const filePath = (toolCall.input.filePath as string) ?? ''
    const projectDir = projectCwd ?? process.cwd()
    const physicalPath = filePath ? resolvePhysicalPath(filePath, projectDir) : ''
    if (
      filePath &&
      isPathWithinProject(filePath, projectDir) &&
      !isSensitivePath(filePath) &&
      !isSensitivePath(physicalPath)
    ) {
      return { approved: true }
    }
    // 路径在项目之外或指向敏感文件——落入询问分支
  }
  if (sessionRulesMatch(toolCall.toolName, toolCall.input, executionCwd)) return { approved: true }

  const decision = await onAskPermission(toolCall)
  if (typeof decision === 'object') return { approved: false, feedback: decision.feedback }
  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input, executionCwd)
    if (result) {
      // 对于 `git commit && git push` 这类复合 shell，buildAllowRule 可能返回
      // 多条规则——用户可见的标签（"git commit:*, git push:*"）会同时展示两者，
      // 这里也一并保存，使下一次复合调用能够自动批准。
      for (const rule of result.rules) {
        addSessionAllowRule(rule)
        if (result.persist && projectCwd) persistRule(projectCwd, rule)
      }
    }
    return { approved: true }
  }
  return { approved: decision === 'yes' }
}

export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<PermissionDecision>,
  permissionMode: PermissionMode = 'default',
  projectCwd?: string,
  executionCwd?: string,
): Promise<boolean> {
  return (await checkPermissionDetailed(toolCall, trustMode, onAskPermission, permissionMode, projectCwd, executionCwd))
    .approved
}

export { addSessionAllowRule, clearSessionRules, buildAllowRule, removeSessionAllowRule } from './session-store.js'
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './session-store.js'
export { loadPersistedRules, persistRule, reloadPersistedRules } from './session-store.js'
export { readPersistedRules, removePersistedRule } from './persistence.js'
export {
  MAX_EGRESS_APPROVAL_BYTES,
  authoritySnapshotHash,
  canonicalizeToolInput,
  classifyToolCall,
  evaluateToolAuthority,
  sha256Text,
  verifyAuthorityApproval,
} from './authority.js'
