// @x-code-cli/core — 每个服务器的 OAuth token + 客户端信息持久化
//
// 一个文件：~/.x-code/mcp-auth.json
//
//   {
//     "sentry": {
//       "url": "https://mcp.sentry.dev",
//       "clientInformation": { client_id: "...", client_secret: "...", ... },
//       "tokens":            { access_token: "...", refresh_token: "...", expires_in: 3600, ... }
//     },
//     ...
//   }
//
// 权限：POSIX 上为 0o600（仅属主可读写）；Windows 上 mode 位被忽略，
// 但文件位于用户 profile 下，其他用户的触及范围受 OS ACL 约束。
// 原子写入（tmp + rename），使写入中途崩溃不会损坏先前完好的 token。
//
// SDK 的 `OAuthClientProvider` 接口（见 ../oauth/provider.ts）才是实际
// 消费者——本模块只是裸持久化层。
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, userXcodeDir } from '../../utils.js'

function authFile(): string {
  return path.join(userXcodeDir(), 'mcp-auth.json')
}

export interface StoredServerAuth {
  /** 服务器 URL——记录下来是为了在用户日后改配置时，能检测出
   *  "这个存储的 token 属于另一个部署"。 */
  url: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** 最近一次拿到 token 时的 UTC ISO 时间戳。用于在本地计算过期时间，
   *  因为 OAuth 的 `expires_in` 是相对签发时刻的，不是绝对时间。 */
  tokensIssuedAt?: string
}

type FileShape = Record<string, StoredServerAuth>

/** 缓存/磁盘快照里永远不允许出现的 key：以裸对象（`{}`）承载时，
 *  `cache['__proto__'] ??= {...}` 会读到 `Object.prototype`（truthy，不赋值），
 *  随后 `entry.url = url` 直接污染全局原型。 */
const FORBIDDEN_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** 空快照：null 原型，索引任意名字都不会命中 `Object.prototype`。 */
function emptyFileShape(): FileShape {
  return Object.create(null) as FileShape
}

export class McpTokenStorage {
  private cache: FileShape | null = null
  /** 共享的加载 Promise：并发调用者必须看到同一次读盘结果，否则后完成的
   *  一次 `readFile` 会用"写入前的旧快照"覆盖掉刚 `setTokens` 的内存状态。 */
  private loadPromise: Promise<void> | null = null
  /** 本进程实际改动 / 删除过的 server 名。`flush()` 只把这部分合并进磁盘
   *  快照，其余 key 以磁盘为准（CLI 与 Desktop 是两个进程，各持一份实例）。 */
  private readonly dirtyServers = new Set<string>()
  private readonly removedServers = new Set<string>()
  /** 本进程内的写入串行化链。 */
  private writeChain: Promise<void> = Promise.resolve()

  async get(serverName: string): Promise<StoredServerAuth | undefined> {
    await this.ensureLoaded()
    return this.cache![serverName]
  }

  async setClientInformation(serverName: string, url: string, info: OAuthClientInformationMixed): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.clientInformation = info
    this.dirtyServers.add(serverName)
    this.removedServers.delete(serverName)
    await this.flush()
  }

  async setTokens(serverName: string, url: string, tokens: OAuthTokens): Promise<void> {
    await this.ensureLoaded()
    const entry = (this.cache![serverName] ??= { url })
    entry.url = url
    entry.tokens = tokens
    entry.tokensIssuedAt = new Date().toISOString()
    this.dirtyServers.add(serverName)
    this.removedServers.delete(serverName)
    await this.flush()
  }

  async clear(serverName: string): Promise<void> {
    await this.ensureLoaded()
    if (this.cache![serverName]) {
      delete this.cache![serverName]
      this.dirtyServers.delete(serverName)
      this.removedServers.add(serverName)
      await this.flush()
    }
  }

  async listServers(): Promise<Array<{ name: string; url: string; hasTokens: boolean }>> {
    await this.ensureLoaded()
    return Object.entries(this.cache!).map(([name, entry]) => ({
      name,
      url: entry.url,
      hasTokens: !!entry.tokens,
    }))
  }

  // ── 辅助方法 ────────────────────────────────────────────────────────────

  /** 从 issuedAt + expires_in 计算绝对过期时间戳。
   *  任一缺失时返回 undefined（有些服务器省略过期时间——此时调用方应
   *  乐观地使用 token，让 401 触发刷新）。 */
  static expiresAt(stored: StoredServerAuth | undefined): number | undefined {
    const t = stored?.tokens
    if (!t) return undefined
    if (typeof t.expires_in !== 'number') return undefined
    const issued = stored.tokensIssuedAt ? Date.parse(stored.tokensIssuedAt) : NaN
    if (Number.isNaN(issued)) return undefined
    return issued + t.expires_in * 1000
  }

  /** 当且仅当存在存储 token 且看起来足够新鲜（即不会在接下来 `skewMs`
   *  窗口内过期）时返回 true。过期时间未知时返回 true，交给下一次 401
   *  驱动刷新。 */
  static isAccessTokenLikelyValid(stored: StoredServerAuth | undefined, skewMs = 60_000): boolean {
    if (!stored?.tokens?.access_token) return false
    const expiresAt = McpTokenStorage.expiresAt(stored)
    if (expiresAt === undefined) return true
    return Date.now() + skewMs < expiresAt
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return
    // 只读一次：`loadMcpServers` 会并发为多个服务器构造 provider，各自
    // 调 `tokens()` / `saveTokens()`。没有共享 Promise 时它们会各读一次文件，
    // 而更早发起、更晚 resolve 的那次读取会把刚写入的 token 覆盖掉。
    this.loadPromise ??= readFile().then(
      (loaded) => {
        // 已有内存改动（并发写入抢先完成）时不要用磁盘旧快照覆盖。
        if (this.cache === null) this.cache = loaded
      },
      (err: unknown) => {
        // 读盘失败不能被记忆化：否则这个实例会被永久钉死在一个 rejected
        // promise 上，用户修好文件后也无法恢复。
        this.loadPromise = null
        throw err
      },
    )
    await this.loadPromise
  }

  private flush(): Promise<void> {
    if (!this.cache) return Promise.resolve()
    const task = this.writeChain.then(() => this.writeNow())
    this.writeChain = task.catch(() => {})
    return task
  }

  private async writeNow(): Promise<void> {
    if (!this.cache) return
    // 唯一 tmp 名：固定名在两个进程同时写时会交叉写入并产生半截 JSON。
    const tmp = `${authFile()}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(userXcodeDir(), { recursive: true })
      // 写前重新读盘并只合并本进程改动过的 key：跨进程场景（CLI 与 Desktop
      // 各持一份单例）下整体覆盖会把对方刚写入的 entry 整条抹掉——用户在
      // 另一个终端的 `/mcp logout` 或手工编辑同样会被静默回滚。
      const merged = await readFile()
      for (const serverName of this.dirtyServers) {
        const entry = this.cache[serverName]
        if (entry) merged[serverName] = entry
        else delete merged[serverName]
      }
      for (const serverName of this.removedServers) delete merged[serverName]

      this.cache = merged
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      // `mode` 只在创建新文件时生效：残留的 tmp（上次崩溃、或同机其他进程先
      // 创建）会让明文 access_token / refresh_token / client_secret 以 0o644
      // 长期留在磁盘上。显式收紧一次再看。
      if (process.platform !== 'win32') await fs.chmod(tmp, 0o600)
      await fs.rename(tmp, authFile())
      this.dirtyServers.clear()
      this.removedServers.clear()
    } catch (err) {
      // 不吞：磁盘满 / 目录只读 / 权限不足时，若这里安静地成功，OAuth 流程
      // 会向用户报告“已保存”，而下次启动仍要重走一遍完整授权（甚至因为
      // client_secret 丢失而重复注册客户端）。清掉残留 tmp 后把错误抛给调用方。
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      debugLog('mcp.token-write-failed', String(err))
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}

/** 把任意 JSON 值收敛成合法的快照：只保留"对象且 `url` 是字符串"的条目。
 *  半写坏的文件 / 手工编辑 / 旧版本格式都可能让某个 key 变成 `null`、数组或
 *  标量，直接返回给 `get()` / `listServers()` 会让 `entry.url` 在 `null` 上
 *  取属性抛 TypeError（`Object.entries` 不过滤非法值），把 `/mcp list` 整条打挂。 */
function toFileShape(value: unknown): FileShape {
  const shape = emptyFileShape()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return shape
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SERVER_NAMES.has(name)) {
      debugLog('mcp.token-entry-rejected', `reserved server name: ${name}`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      debugLog('mcp.token-entry-rejected', `${name}: not an object`)
      continue
    }
    if (typeof (entry as Record<string, unknown>).url !== 'string') {
      debugLog('mcp.token-entry-rejected', `${name}: missing url`)
      continue
    }
    shape[name] = entry as StoredServerAuth
  }
  return shape
}

/** 读取磁盘快照。**只有 ENOENT 才是合法的空态**：`writeNow()` 会
 *  "读盘 → 合并本进程的 dirty entry → rename 覆盖整份文件"，所以把一次瞬时
 *  读失败（EACCES / EIO / EDQUOT / Windows 上被独占打开 / `X_CODE_HOME` 指向
 *  尚未挂载完的卷）或半损坏文件当成空快照，会把**其它服务器**的
 *  access_token / refresh_token / client_secret 静默清空，用户下次启动必须对
 *  所有 MCP 服务器重新授权。这里如实抛错，让写入放弃并保留 dirty 标记。 */
async function readFile(): Promise<FileShape> {
  let raw: string
  try {
    raw = await fs.readFile(authFile(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFileShape()
    throw new Error(`cannot read ${authFile()}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${authFile()} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — repair or delete it`,
      { cause: err },
    )
  }
  return toFileShape(parsed)
}

/** 单例实例。接线简单：CLI 启动时构造一次，传给 loadMcpServers
 *  （它会把它穿进每个服务器的 OAuth provider）以及 /mcp auth /
 *  /mcp logout 处理器。 */
let globalInstance: McpTokenStorage | null = null
export function getTokenStorage(): McpTokenStorage {
  if (!globalInstance) globalInstance = new McpTokenStorage()
  return globalInstance
}

/** 测试钩子——替换单例，使单元测试不触碰 ~/.x-code/。注意 X_CODE_HOME
 *  也会重定向该文件，所以多数测试只需设置那个环境变量，不必用这个钩子。 */
export function setTokenStorageForTesting(s: McpTokenStorage | null): void {
  globalInstance = s
}

export type { OAuthClientInformationFull, OAuthClientInformationMixed, OAuthTokens }
