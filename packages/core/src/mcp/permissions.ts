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
  /** 共享的加载 Promise：判空是同步的而那行 `await` 之前不会赋值，多个并发
   *  调用会各读一次文件，最后完成的赋值会整体替换掉先完成的那份 Set——
   *  期间 `approvePermanently` 加进去的条目就此在内存中消失。 */
  private loadPromise: Promise<void> | null = null
  /** 本实例的写入串行化链 + 用于生成唯一 tmp 名的序号。 */
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0

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
    this.loadPromise ??= readPersisted().then((loaded) => {
      // 已有并发写入产生的内存集合时取并集，避免丢掉刚授予的项。
      this.persisted = this.persisted ? new Set([...this.persisted, ...loaded]) : loaded
    })
    await this.loadPromise
  }

  private writePersisted(): Promise<void> {
    if (!this.persisted) return Promise.resolve()
    const task = this.writeChain.then(() => this.writePersistedNow())
    this.writeChain = task.catch(() => {})
    return task
  }

  private async writePersistedNow(): Promise<void> {
    if (!this.persisted) return
    await fs.mkdir(userXcodeDir(), { recursive: true, mode: 0o700 })
    // 写前与磁盘取并集：多个 CLI 会话 / Desktop 进程并发批准不同工具时，整体
    // 覆盖是 last-writer-wins，后写的一方会把先写的一方的授权整条抹掉。
    const onDisk = await readPersisted()
    const merged = new Set([...onDisk, ...this.persisted])
    this.persisted = merged

    const payload: StoreShape = { alwaysAllow: [...merged].sort() }
    // 唯一 tmp 名：固定名会让同一轮里两个并发 "always allow" 交叉写入同一个
    // 文件（产生半截 JSON），第二次 rename 又会因 tmp 已被移走而 ENOENT。
    const tmp = `${permissionsFile()}.tmp-${process.pid}-${(this.writeSeq++).toString(36)}`
    try {
      // 0600——仅用户可读。与 mcp-auth.json 姿态一致（同样的注意事项：
      // Windows 忽略 mode 位，但文件在 ~/.x-code 下，所以实际泄露面限于以
      // 同一用户运行的其他应用）。
      //
      // 'wx' 独占创建：`mode` 只在**创建**时生效，复用上次崩溃残留的 0644
      // 同名 tmp（或被预先放好的符号链接）会让权限位保持原样。
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      })
      if (process.platform !== 'win32') await fs.chmod(tmp, 0o600)
      await fs.rename(tmp, permissionsFile())
    } finally {
      // rename 成功后 tmp 已不存在；失败时清掉残留，避免污染下一次写入。
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
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
