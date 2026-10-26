// @x-code-cli/core — 市场订阅 + 索引解析
//
// 市场是一个经过策展的插件目录（其 `marketplace.json` 是一个
// `{ name, source, ... }` 条目列表）。CLI 不托管自己的市场——见
// [[plugin-marketplace-design]] §7.1 的“订阅他人市场”理由。本模块负责：
//
//   1. 读写 `known_marketplaces.json`（用户的订阅列表），并带保留名保护。
//   2. 从 HTTPS URL（指向原始 marketplace.json）或 git URL（浅克隆并读取
//      `.claude-plugin/marketplace.json`，这是真实 Claude Code 市场发布
//      的路径）获取并缓存市场索引。
//   3. 把 marketplace.json 解析成带类型的 `Marketplace`，把每个插件的
//      `source` 字段从磁盘上的线上形式（字符串捷径、`git-subdir`、`url`，
//      …）归一化成我们内部的 `PluginSource`，让安装器只面对一种形状。
//   4. 按 `name@marketplace` 插件 id 查找安装来源。
//
// 线上格式 vs 内部 `PluginSource`：真实 Claude Code 规范用 `source` 作判别
// 符，取值 `'git-subdir'`、`'url'` 等，外加 monorepo 子目录的纯字符串捷径
// （`"./plugins/foo"`）。我们把这些都映射到 `PluginSource`，让系统其余部分
// 只面对一种形状。转换表见 [[normalizeMarketplaceSource]]。
//
// 所有磁盘 + 网络 I/O 都接受 AbortSignal，让来自 agent loop 的 Esc 取消能
// 干净地传播。
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { debugLog, errorMessage } from '../utils.js'
import { isSafePluginPathComponent, knownMarketplacesPath, marketplaceDir, marketplaceIndexPath } from './paths.js'
import type { KnownMarketplace, KnownMarketplaces, Marketplace, MarketplaceEntry, PluginSource } from './types.js'

// ── 保留市场名 ──────────────────────────────────────────

/** 只有在来源与规范上游匹配时才允许注册的名字。防止恶意者从自己的仓库发布
 *  `anthropic-marketplace` 来冒充 Anthropic。映射到预期的 GitHub 组织。 */
export const RESERVED_MARKETPLACE_NAMES: Readonly<Record<string, string>> = {
  'anthropic-marketplace': 'anthropics',
  'claude-plugins': 'anthropics',
  'x-code-official': 'qweijiaq',
}

// ── 来源归一化（线上格式 → 内部 PluginSource） ──────────

/** 把市场的 `source` 字段（磁盘上的线上形式）转换成我们内部的
 *  `PluginSource`。支持我们在真实 Claude Code 市场中见过的所有形状：
 *
 *  | 线上形式                                                     | 归一化后的 PluginSource                          |
 *  |-------------------------------------------------------------|--------------------------------------------------|
 *  | `"./plugins/foo"` or `"../shared/x"`                        | `{kind:'git', url:<marketplace-clone-url>, subdir:'plugins/foo'}` |
 *  | `"github:owner/repo[#ref]"`                                 | `{kind:'github', owner, repo, ref?}`             |
 *  | `"https://…"` or `"git@…"`                                  | `{kind:'git', url}`                              |
 *  | `{source:'git-subdir', url, path, ref?, sha?}`              | `{kind:'git', url, ref?, subdir:path}`           |
 *  | `{source:'url', url, sha?}`                                 | `{kind:'git', url}`                              |
 *  | `{source:'git', url, ref?, subdir?}`                        | `{kind:'git', url, ref?, subdir?}`               |
 *  | `{source:'github', owner, repo, ref?, subdir?}`             | `{kind:'github', owner, repo, ref?, subdir?}`    |
 *  | `{source:'local', path}`                                    | `{kind:'local', path}`                           |
 *  | `{kind:'git'\|'github'\|'local', …}`（我们的遗留形式）        | 直接透传                                         |
 *
 *  相对字符串形式（`./plugins/foo`）需要市场自己的 clone URL——那是我们要
 *  subdir 进去的仓库。经 `ctx.marketplaceCloneUrl` 传入。当字符串是相对的、
 *  却没有提供上下文时抛错（HTTPS 拉取的市场显然无法托管相对路径插件）。
 *
 *  来自 `git-subdir` / `url` / `github` 的 `sha` 字段被捕获进
 *  `PluginSource.expectedSha`（7-40 位十六进制，下方做格式校验），供安装器
 *  克隆后做 `git rev-parse HEAD` 完整性校验——见 installer.ts 的 `fetchToTemp`
 *  sha 检查。非十六进制 / 畸形值会被静默丢弃，让手误不会被误当成真实不匹配。 */
function normalizeMarketplaceSource(raw: unknown, ctx: { marketplaceCloneUrl?: string } = {}): PluginSource {
  if (typeof raw === 'string') {
    if (raw.startsWith('./') || raw.startsWith('../')) {
      const cloneUrl = ctx.marketplaceCloneUrl
      if (!cloneUrl) {
        throw new Error(
          `relative source "${raw}" requires the marketplace's own clone URL, but the marketplace was fetched without one (typically because it was loaded from a raw HTTPS URL rather than a git repo)`,
        )
      }
      const subdir = raw.replace(/^\.\//, '')
      return { kind: 'git', url: cloneUrl, subdir }
    }
    if (raw.startsWith('github:')) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) throw new Error(`invalid github source: ${raw}`)
      return { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
    }
    if (/^https?:\/\//i.test(raw) || raw.startsWith('git@')) {
      return { kind: 'git', url: raw }
    }
    throw new Error(`unrecognised source string: ${raw}`)
  }

  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const disc = (typeof o.source === 'string' ? o.source : (o.kind as string | undefined)) as string | undefined

    // 捕获可选的 `sha` 完整性钉。我们接受 ≥7 位的十六进制字符串（与 Git 的
    // 短 sha 容错一致；安装器做前缀比较，所以短 sha 也能用）。尽早拒绝非
    // 十六进制形状——否则手误的值会掩盖真实的攻击。
    const rawSha = typeof o.sha === 'string' ? o.sha.trim().toLowerCase() : undefined
    const expectedSha = rawSha && /^[0-9a-f]{7,40}$/.test(rawSha) ? rawSha : undefined

    if (disc === 'git-subdir') {
      if (typeof o.url !== 'string' || typeof o.path !== 'string') {
        throw new Error('git-subdir source requires `url` and `path`')
      }
      return {
        kind: 'git',
        url: o.url,
        subdir: o.path,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        expectedSha,
      }
    }
    if (disc === 'url') {
      if (typeof o.url !== 'string') throw new Error('url source requires `url`')
      return { kind: 'git', url: o.url, expectedSha }
    }
    if (disc === 'git') {
      if (typeof o.url !== 'string') throw new Error('git source requires `url`')
      return {
        kind: 'git',
        url: o.url,
        ref: typeof o.ref === 'string' ? o.ref : undefined,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'github') {
      // github 来源有两种真实形状：
      //   { owner, repo, ref?, subdir? } —— owner / repo 分开
      //   { repo: "owner/repo" } —— 合并的斜杠形式（见于真实
      //                             claude-plugins-official 条目）
      let owner = typeof o.owner === 'string' ? o.owner : undefined
      let repo = typeof o.repo === 'string' ? o.repo : undefined
      if (!owner && repo && repo.includes('/')) {
        const slash = repo.indexOf('/')
        owner = repo.slice(0, slash)
        repo = repo.slice(slash + 1)
      }
      if (!owner || !repo) {
        throw new Error('github source requires `owner` + `repo` or `repo: "owner/repo"`')
      }
      const ref = typeof o.ref === 'string' ? o.ref : typeof o.commit === 'string' ? o.commit : undefined
      return {
        kind: 'github',
        owner,
        repo,
        ref,
        subdir: typeof o.subdir === 'string' ? o.subdir : undefined,
        expectedSha,
      }
    }
    if (disc === 'local') {
      if (typeof o.path !== 'string') throw new Error('local source requires `path`')
      return { kind: 'local', path: o.path }
    }
    throw new Error(
      `unknown source discriminator: ${disc ?? '(missing)'} — accepted: git-subdir, url, git, github, local`,
    )
  }

  throw new Error('source must be a string or object')
}

// ── marketplace.json 的 Zod schema ────────────────────────────────────

// `source` 在 zod 层只校验为“string 或 object”；真正的形状检查发生在
// `normalizeMarketplaceSource` 内部，因为这个联合的判别符形式太多（有的用
// `source`，有的用 `kind`），zod 的判别联合无法干净处理。
const wireSourceSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

const wireEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  verified: z.boolean().optional(),
  source: wireSourceSchema,
  version: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  // 真实 Claude Code 插件条目还带有顶层 `author`。目前不属于
  // MarketplaceEntry，但接受它以免拒绝整个条目。
  author: z.unknown().optional(),
})

const wireMarketplaceSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  owner: z
    .object({
      name: z.string().optional(),
      url: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  plugins: z.array(wireEntrySchema),
})

export class MarketplaceParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'MarketplaceParseError'
  }
}

export interface ParseMarketplaceContext {
  /** 市场自己仓库的 git clone URL，用于解析 `"./plugins/foo"` 这类相对
   *  字符串来源。当市场从原始 HTTPS URL 拉取时为缺省（那些无法托管相对
   *  路径插件）。 */
  marketplaceCloneUrl?: string
}

/** 解析并校验 marketplace.json 字符串，并把每个插件的 `source` 归一化成
 *  内部 `PluginSource`。`sourceLabel` 会进入错误消息，让用户知道是哪个市场
 *  失败。 */
export function parseMarketplace(raw: string, sourceLabel: string, ctx: ParseMarketplaceContext = {}): Marketplace {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new MarketplaceParseError(`not valid JSON: ${errorMessage(err)}`, sourceLabel)
  }
  const result = wireMarketplaceSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new MarketplaceParseError(`invalid marketplace.json — ${issues}`, sourceLabel)
  }

  const normalised: MarketplaceEntry[] = []
  const sourceErrors: string[] = []
  for (let i = 0; i < result.data.plugins.length; i++) {
    const entry = result.data.plugins[i]!
    try {
      const source = normalizeMarketplaceSource(entry.source, ctx)
      normalised.push({
        name: entry.name,
        description: entry.description,
        category: entry.category,
        verified: entry.verified,
        version: entry.version,
        homepage: entry.homepage,
        keywords: entry.keywords,
        source,
      })
    } catch (err) {
      // 一个坏插件条目不应毁掉整个市场——多数用户关心目录里的其它插件。
      // 收集起来，在尝试过所有条目之后以单一错误一并呈现。
      sourceErrors.push(`plugins.${i} (${entry.name}): ${errorMessage(err)}`)
    }
  }
  if (normalised.length === 0 && sourceErrors.length > 0) {
    throw new MarketplaceParseError(`no plugin entries parsed — ${sourceErrors.join('; ')}`, sourceLabel)
  }
  if (sourceErrors.length > 0) {
    debugLog('plugins.marketplace-source-errors', `${sourceLabel}: ${sourceErrors.join(' | ')}`)
  }

  // `name` 是调用方传入的订阅别名（sourceLabel），而不是上游 marketplace.json
  // 的 `name` 字段。存储路径、安装 id 和查找都以别名为键——此前
  // `parseMarketplace` 在这里泄漏上游名，曾导致 `plugin marketplace info
  // <alias>` 失败，也让 `plugin search` 给插件打上错误的市场标签。我们把
  // 上游名保留在 `upstreamName` 上，让 `info` 在二者不同时仍能展示它。
  return {
    schemaVersion: result.data.schemaVersion ?? '1',
    name: sourceLabel,
    upstreamName: result.data.name !== sourceLabel ? result.data.name : undefined,
    displayName: result.data.displayName,
    description: result.data.description,
    owner: result.data.owner ? { name: result.data.owner.name, url: result.data.owner.url } : undefined,
    plugins: normalised,
  }
}

// ── known_marketplaces.json：读写 ───────────────────────────────

/** 全新的空状态。做成函数（而非 const），让每次调用都返回新的
 *  `marketplaces: []`——若用共享常量，一个调用方的改动会泄漏进下一个调用方
 *  的“空”结果。 */
function freshKnown(): KnownMarketplaces {
  return { marketplaces: [] }
}

export async function readKnownMarketplaces(): Promise<KnownMarketplaces> {
  const file = knownMarketplacesPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return freshKnown()
    const obj = parsed as Record<string, unknown>
    const list = Array.isArray(obj.marketplaces) ? (obj.marketplaces as KnownMarketplace[]) : []
    return {
      marketplaces: list.filter(
        (m) => m && typeof m.name === 'string' && isSafePluginPathComponent(m.name) && typeof m.source === 'string',
      ),
      strictKnownMarketplaces:
        typeof obj.strictKnownMarketplaces === 'boolean' ? obj.strictKnownMarketplaces : undefined,
      blockedPlugins: Array.isArray(obj.blockedPlugins)
        ? (obj.blockedPlugins as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return freshKnown()
    debugLog('plugins.known-marketplaces-read-failed', String(err))
    return freshKnown()
  }
}

async function writeKnownMarketplaces(km: KnownMarketplaces): Promise<void> {
  const file = knownMarketplacesPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // 读-改-写，以免未来任何无关字段被覆盖。
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    // 首次写入
  }
  existing.marketplaces = km.marketplaces
  if (km.strictKnownMarketplaces !== undefined) existing.strictKnownMarketplaces = km.strictKnownMarketplaces
  if (km.blockedPlugins !== undefined) existing.blockedPlugins = km.blockedPlugins
  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

/** 确保默认市场订阅存在。CLI 启动时调用，让全新安装预订阅 Anthropic 官方
 *  市场，`/plugin search` 无需用户手动添加任何东西就能返回结果。对具名
 *  条目幂等：无关订阅被保留，而被删除的默认项会在下次调用时恢复。
 *
 *  目标是 `anthropics/claude-plugins-official`（203 个插件），而不是
 *  `anthropics/claude-code` 里捆绑的较小市场——专用仓库才是规范发现入口。 */
export async function ensureDefaultMarketplaces(): Promise<void> {
  const km = await readKnownMarketplaces()
  const haveAnthropic = km.marketplaces.some((m) => m.name === 'anthropic-marketplace')
  if (haveAnthropic) return

  // 用 addKnownMarketplace 让保留名校验生效——它会设 `reservedName: true`
  // + `officialSource: 'anthropics'`。
  try {
    await addKnownMarketplace({
      name: 'anthropic-marketplace',
      source: 'github:anthropics/claude-plugins-official',
    })
  } catch (err) {
    debugLog('plugins.default-marketplace-add-failed', String(err))
  }
}

/** 注册一个新的市场订阅。拒绝来源与规范上游不匹配的保留名——见
 *  RESERVED_MARKETPLACE_NAMES。幂等：重复添加同名会更新来源。 */
export async function addKnownMarketplace(entry: KnownMarketplace): Promise<void> {
  if (!isSafePluginPathComponent(entry.name)) {
    throw new Error('Marketplace name must be one safe cross-platform filesystem path component')
  }
  const reservedOrg = RESERVED_MARKETPLACE_NAMES[entry.name]
  if (reservedOrg !== undefined) {
    if (!sourceMatchesOrg(entry.source, reservedOrg)) {
      throw new Error(
        `Marketplace name "${entry.name}" is reserved; only sources under github:${reservedOrg}/* may use it. ` +
          `Got: ${entry.source}`,
      )
    }
    entry.reservedName = true
    entry.officialSource = reservedOrg
  }

  const km = await readKnownMarketplaces()
  const idx = km.marketplaces.findIndex((m) => m.name === entry.name)
  if (idx >= 0) {
    km.marketplaces[idx] = entry
  } else {
    km.marketplaces.push(entry)
  }
  await writeKnownMarketplaces(km)
}

export async function removeKnownMarketplace(name: string): Promise<'removed' | 'noop'> {
  if (!isSafePluginPathComponent(name)) return 'noop'
  const km = await readKnownMarketplaces()
  const before = km.marketplaces.length
  km.marketplaces = km.marketplaces.filter((m) => m.name !== name)
  if (km.marketplaces.length === before) return 'noop'
  await writeKnownMarketplaces(km)
  return 'removed'
}

function sourceMatchesOrg(source: string, expectedOrg: string): boolean {
  // 接受 `github:org/repo[...]` 和 `https://github.com/org/repo[...]`。
  const ghShort = source.match(/^github:([^/]+)\//i)
  if (ghShort) return ghShort[1]!.toLowerCase() === expectedOrg.toLowerCase()
  const ghHttps = source.match(/^https?:\/\/github\.com\/([^/]+)\//i)
  if (ghHttps) return ghHttps[1]!.toLowerCase() === expectedOrg.toLowerCase()
  return false
}

// ── 拉取 / 刷新市场索引 ─────────────────────────────────

export interface FetchOptions {
  signal?: AbortSignal
  /** 若缓存索引存在且比该值新，则跳过网络。 */
  maxAgeMs?: number
}

/** 把新的 marketplace.json 拉进本地缓存并解析。支持两种来源形状：
 *
 *    - `https://...` 或 `http://...` —— 指向 marketplace.json 的直接 URL
 *    - 其它（`github:owner/repo`、git URL） —— 浅克隆，然后读取
 *      `.claude-plugin/marketplace.json`（规范 Claude Code 路径——参考布局
 *      见 `anthropics/claude-code` 与 `anthropics/claude-plugins-official`）
 *
 *  返回前把解析出的文件写入
 *  ~/.x-code/plugins/marketplaces/<name>/marketplace.json。 */
export async function fetchMarketplace(entry: KnownMarketplace, opts: FetchOptions = {}): Promise<Marketplace> {
  const cachedPath = marketplaceIndexPath(entry.name)

  if (opts.maxAgeMs !== undefined) {
    const fresh = await isFreshEnough(cachedPath, opts.maxAgeMs)
    if (fresh) {
      const raw = await fs.readFile(cachedPath, 'utf-8')
      return parseMarketplace(raw, entry.name, contextForKnownEntry(entry))
    }
  }

  const isHttp = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  const rawJson = isHttp
    ? await fetchHttpJson(entry.source, opts.signal)
    : await fetchViaShallowClone(entry.source, opts.signal)

  const marketplace = parseMarketplace(rawJson, entry.name, contextForKnownEntry(entry))

  await fs.mkdir(marketplaceDir(entry.name), { recursive: true })
  await fs.writeFile(cachedPath, rawJson, 'utf-8')

  return marketplace
}

/** 从已知市场条目构建 `ParseMarketplaceContext`。对 git 克隆的市场，它提供
 *  clone URL，让 `"./plugins/foo"` 这类相对字符串来源能解析到市场自己仓库的
 *  那个子目录。对原始 HTTPS 市场没有 clone URL；这类市场里的相对来源会
 *  归一化失败（正确——没有可引用的仓库）。 */
function contextForKnownEntry(entry: KnownMarketplace): ParseMarketplaceContext {
  const isRawHttps = /^https?:\/\//i.test(entry.source) && /\.json($|\?)/i.test(entry.source)
  if (isRawHttps) return {}
  return { marketplaceCloneUrl: resolveCloneUrl(entry.source) }
}

async function isFreshEnough(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return Date.now() - stat.mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

async function fetchHttpJson(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
  }
  return res.text()
}

/** 把给定来源的仓库克隆进临时目录（depth 1），返回市场索引的内容。先探测
 *  规范 `.claude-plugin/marketplace.json`，对非标准布局回退到根级
 *  `marketplace.json`。无论成功与否，返回前都会删除该克隆。 */
async function fetchViaShallowClone(source: string, signal?: AbortSignal): Promise<string> {
  const cloneUrl = resolveCloneUrl(source)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-marketplace-'))
  try {
    await execa('git', ['clone', '--depth', '1', cloneUrl, tempDir], { signal, stdio: 'pipe' })
    const candidates = [
      path.join(tempDir, '.claude-plugin', 'marketplace.json'),
      path.join(tempDir, 'marketplace.json'),
    ]
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf-8')
      } catch {
        // 尝试下一个候选
      }
    }
    throw new Error(
      `marketplace repo ${cloneUrl} has no .claude-plugin/marketplace.json (also tried root marketplace.json)`,
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* 尽力而为 */
    })
  }
}

/** 把来源字符串转成 `git clone` 能理解的形式：
 *  `github:owner/repo` → `https://github.com/owner/repo.git`。其它形式
 *  原样透传（真实 git URL、ssh: 等）。 */
export function resolveCloneUrl(source: string): string {
  const m = source.match(/^github:([^/]+)\/(.+?)(?:\.git)?$/i)
  if (m) {
    return `https://github.com/${m[1]}/${m[2]}.git`
  }
  return source
}

// ── 查找辅助函数 ──────────────────────────────────────────────────────

/** 读取每个缓存的市场索引。供 `/plugin search` 和
 *  `/plugin install <name@marketplace>` 查找使用。缓存索引损坏的市场会被
 *  跳过并记日志；一个坏市场不会影响其它市场。 */
export async function readAllCachedMarketplaces(): Promise<Marketplace[]> {
  const km = await readKnownMarketplaces()
  const out: Marketplace[] = []
  for (const entry of km.marketplaces) {
    try {
      const raw = await fs.readFile(marketplaceIndexPath(entry.name), 'utf-8')
      out.push(parseMarketplace(raw, entry.name, contextForKnownEntry(entry)))
    } catch (err) {
      debugLog('plugins.marketplace-cache-read-failed', `${entry.name}: ${String(err)}`)
    }
  }
  return out
}

/** 按 `name@marketplace` id 查找一个插件条目。当市场未订阅或插件未列出时
 *  返回 `undefined`。 */
export async function lookupPlugin(
  pluginId: string,
): Promise<{ marketplace: Marketplace; entry: MarketplaceEntry } | undefined> {
  const at = pluginId.lastIndexOf('@')
  if (at <= 0) return undefined
  const pluginName = pluginId.slice(0, at)
  const marketplaceName = pluginId.slice(at + 1)

  const km = await readKnownMarketplaces()
  const known = km.marketplaces.find((m) => m.name === marketplaceName)

  try {
    const raw = await fs.readFile(marketplaceIndexPath(marketplaceName), 'utf-8')
    const m = parseMarketplace(raw, marketplaceName, known ? contextForKnownEntry(known) : {})
    const entry = m.plugins.find((p) => p.name === pluginName)
    if (!entry) return undefined
    return { marketplace: m, entry }
  } catch {
    return undefined
  }
}
