import fs from 'node:fs'
import path from 'node:path'

import type { AllowRule } from '@x-code-cli/core'

import type { PermissionRuleType, PermissionRuleView } from '../shared/protocol.js'

const RULE_TYPES: PermissionRuleType[] = ['exact', 'prefix', 'tool']

/** 比较用的路径归一化：解析符号链接与大小写差异（macOS 上 `/var` 与
 *  `/private/var`、Windows 盘符大小写、通过链接打开的工作区）。不存在的
 *  尾部逐级回退到最深的已存在祖先，因此“尚未创建”的工作区也能匹配。 */
function comparablePath(input: string): string {
  const resolved = path.resolve(input)
  const tail: string[] = []
  let current = resolved
  let result = resolved
  for (;;) {
    try {
      result = path.join(fs.realpathSync.native(current), ...tail)
      break
    } catch (error) {
      // 只有“不存在”才值得继续向上回退；其它错误保留字面路径。
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') break
      const parent = path.dirname(current)
      if (parent === current) break
      tail.unshift(path.basename(current))
      current = parent
    }
  }
  return process.platform === 'win32' ? result.toLowerCase() : result
}

export function permissionRuleLabel(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

export function toPermissionRuleView(rule: AllowRule): PermissionRuleView {
  return {
    tool: rule.tool,
    pattern: rule.pattern,
    type: rule.type,
    ...(rule.cwd ? { cwd: rule.cwd } : {}),
    label: permissionRuleLabel(rule),
  }
}

/** 某个项目 permissions.json 中存储的规则；shell 规则属于其
 *  获批的项目，因此只显示绑定到 `workspace` 的那些。 */
export function visiblePermissionRules(rules: AllowRule[], workspace: string): PermissionRuleView[] {
  const root = comparablePath(workspace)
  return (
    rules
      // 无 cwd 的 shell 规则（遗留 `shell:*`、写入时没有 executionCwd 的规则）在
      // 执行期仍可能命中（匹配器在 executionCwd 也为 undefined 时放行），因此不能
      // 从可管理列表里静默隐藏——用户会既看不到也无法撤销一条实际生效的授权。
      .filter((rule) => rule.tool !== 'shell' || rule.cwd === undefined || comparablePath(rule.cwd) === root)
      .map(toPermissionRuleView)
      .sort(
        (a, b) => a.tool.localeCompare(b.tool) || a.type.localeCompare(b.type) || a.pattern.localeCompare(b.pattern),
      )
  )
}

/** 校验用户编写的规则并把 shell 规则绑定到项目。只有
 *  shell 支持精确/前缀匹配；其他工具是工具级。 */
export function normalizeNewPermissionRule(
  toolName: string,
  type: PermissionRuleType,
  pattern: string,
  workspace: string,
): AllowRule {
  const tool = toolName.trim()
  if (!tool) throw new Error('工具名不能为空')
  // label 用 `:` / `=` 作分隔符，反解时也按它切分：含分隔符或空白的工具名会被
  // 反解成另一条（甚至语义更宽的）规则。
  if (!/^[A-Za-z0-9._-]+$/.test(tool)) throw new Error('工具名只能包含字母、数字、点、下划线和连字符')
  if (!RULE_TYPES.includes(type)) throw new Error('未知的规则类型')
  // 空工作区会让 path.resolve('') 落到桌面应用自己的 cwd，把规则绑定到错误项目。
  const root = workspace.trim()
  if (!root) throw new Error('项目路径不能为空')
  const trimmed = pattern.trim()
  if (type !== 'tool') {
    if (!trimmed || trimmed === '*') throw new Error('匹配模式不能为空')
    if (tool !== 'shell') throw new Error('只有 shell 工具支持前缀或精确匹配')
    // 对齐执行侧 SessionPermissionStore.matches() 的 isReusablePrefixPattern：
    // 单 token 前缀（如 `git`）永远不会命中，用户会以为「以后不再询问」。
    if (type === 'prefix' && !/\s/.test(trimmed) && !/^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/.test(trimmed)) {
      throw new Error('前缀模式至少包含两个 token（如 "git commit"）')
    }
    // `git commit:*` 这种 label 形式不能当 pattern 录入，否则会生成永不匹配的
    // `shell:git commit:*:*`。
    if (type === 'prefix' && trimmed.endsWith(':*')) throw new Error('前缀模式不要带结尾的 ":*"')
    return { tool, pattern: trimmed, type, cwd: path.resolve(root) }
  }
  return { tool, pattern: '*', type: 'tool', ...(tool === 'shell' ? { cwd: path.resolve(root) } : {}) }
}
