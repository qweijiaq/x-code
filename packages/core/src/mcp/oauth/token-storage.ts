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
    this.loadPromise ??= readFile().then((loaded) => {
      // 已有内存改动（并发写入抢先完成）时不要用磁盘旧快照覆盖。
      if (this.cache === null) this.cache = loaded
    })
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
    try {
      await fs.mkdir(userXcodeDir(), { recursive: true })
      // 写前重新读盘并只合并本进程改动过的 key：跨进程场景（CLI 与 Desktop
      // 各持一份单例）下整体覆盖会把对方刚写入的 entry 整条抹掉——用户在
      // 另一个终端的 `/mcp logout` 或手工编辑同样会被静默回滚。
      const merged: FileShape = { ...(await readFile()) }
      for (const serverName of this.dirtyServers) {
        const entry = this.cache[serverName]
        if (entry) merged[serverName] = entry
        else delete merged[serverName]
      }
      for (const serverName of this.removedServers) delete merged[serverName]

      this.cache = merged
      // 唯一 tmp 名：固定名在两个进程同时写时会交叉写入并产生半截 JSON。
      const tmp = `${authFile()}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmp, authFile())
      this.dirtyServers.clear()
      this.removedServers.clear()
    } catch (err) {
      debugLog('mcp.token-write-failed', String(err))
    }
  }
}

async function readFile(): Promise<FileShape> {
  try {
    const raw = await fs.readFile(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FileShape
    }
  } catch {
    // 缺失 / 格式错误——从干净状态开始
  }
  return {}
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
