// @x-code-cli/core — MCP 工具权限门
//
// 与 packages/core/src/permissions/index.ts（它门禁内置的
// writeFile / edit / shell）平行存在。MCP 工具住在自己的池子里，因为：
//   - 它们的名字是运行时发现的，无法在静态规则表里枚举；
//   - 用户"这个 MCP 工具没问题，别再问了"的决定按工具持久化到
//     ~/.x-code/mcp-permissions.json，独立于任何按 shell 前缀的 allow 规则。
//
// 默认策略：每个 MCP 工具都从 "ask" 起步，直到用户选 "always allow"。
// 不做基于名字的启发式——MCP 工具太杂，`list_/read_/search_` 风格的分类
// 不安全（有些 "list_*" 工具会变更，有些 "create_*" 工具是空操作）。
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PermissionDecision } from '../types/index.js'
import { debugLog, userXcodeDir } from '../utils.js'

function permissionsFile(): string {
  return path.join(userXcodeDir(), 'mcp-permissions.json')
}

interface StoreShape {
  alwaysAllow: string[]
}

/** 持久化文件的内存镜像 + 一个会话级的 "仅本次会话" 允许集合。持久化
 *  集合在首次检查时惰性加载；会话集合在构造时清空，且绝不写盘。 */
export class McpPermissionStore {
  private persisted: Set<string> | null = null
  private session = new Set<string>()

  /** 预加载持久化文件。可选——检查反正会惰性加载。 */
  async preload(): Promise<void> {
    await this.ensurePersistedLoaded()
  }

  /** 当且仅当用户已批准该工具时返回 true（要么是持久化的 "always allow"，
   *  要么是内存中的 "this session"）。 */
  async isApproved(callableName: string): Promise<boolean> {
    if (this.session.has(callableName)) return true
    await this.ensurePersistedLoaded()
    return this.persisted!.has(callableName)
  }

  /** 把该工具标记为仅本次会话其余时间批准。不持久化。 */
  approveForSession(callableName: string): void {
    this.session.add(callableName)
  }

  /** 把该工具标记为永久批准——写盘。写盘失败会被记录但绝不抛出；
   *  最坏情况是用户下次会话要再点一次 "always allow"。 */
  async approvePermanently(callableName: string): Promise<void> {
    await this.ensurePersistedLoaded()
    if (this.persisted!.has(callableName)) return
    this.persisted!.add(callableName)
    // 同时反映到会话集合，使紧接着的下一次调用不会与写盘竞争。
    this.session.add(callableName)
    try {
      await this.writePersisted()
    } catch (err) {
      debugLog('mcp.perm-write-failed', String(err))
      // 尽力而为：失败时不要把项从内存集合里移除——
      // 用户明确说了是，就在本会话内兑现。
    }
  }

  private async ensurePersistedLoaded(): Promise<void> {
    if (this.persisted !== null) return
    this.persisted = await readPersisted()
  }

  private async writePersisted(): Promise<void> {
    if (!this.persisted) return
    await fs.mkdir(userXcodeDir(), { recursive: true })
    const tmp = permissionsFile() + '.tmp'
    const payload: StoreShape = { alwaysAllow: [...this.persisted].sort() }
    // 0600——仅用户可读。与 mcp-auth.json 姿态一致
    // （同样的注意事项：Windows 忽略 mode 位，但文件在 ~/.x-code 下，
    // 所以实际泄露面限于以同一用户运行的其他应用）。
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, permissionsFile())
  }
}

async function readPersisted(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(permissionsFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoreShape
    if (parsed && Array.isArray(parsed.alwaysAllow)) {
      return new Set(parsed.alwaysAllow.filter((s): s is string => typeof s === 'string'))
    }
  } catch {
    // 缺失 / 格式错误——从空 allow 列表开始，退化为全部 ask
  }
  return new Set<string>()
}

/** 从现有 askPermission 回调里抽出 "yes" / "always" / "no"。该回调的
 *  契约返回这三者之一（或一个携带用户反馈的拒绝）；我们把它们映射为
 *  自己调用方的结构化选择。 */
export type McpPermissionDecision = 'allow-once' | 'allow-always' | 'deny'

export function classifyDecision(raw: PermissionDecision): McpPermissionDecision {
  if (raw === 'always') return 'allow-always'
  if (raw === 'yes') return 'allow-once'
  return 'deny'
}
