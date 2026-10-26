// @x-code-cli/core — 插件安装器
//
// 支持三种来源类型：
//
//   - 'local'   文件系统目录 → 递归复制进缓存
//                （跳过 .git / node_modules / 操作系统垃圾文件）
//   - 'git'     任意 git URL    → 浅克隆（depth 1，可选 ref）
//   - 'github'  github:owner/repo → 通过 resolveCloneUrl 浅克隆
//                支持 monorepo 的 `subdir`：先浅克隆整个仓库，再把指定
//                子目录复制进新的临时目录，其余部分丢弃。
//
// 安装流程：
//   1. 把来源取到临时目录
//   2. 发现 + 解析 manifest（在此拒绝仅 Gemini 的来源）
//   3. 计算最终缓存路径：cache/<marketplace>/<plugin>/<version>/
//   4. 在最终缓存路径旁暂存新目录树
//   5. 原子地把暂存 → 最终，保留旧目录树用于回滚
//   6. 追加 / 更新 installed_plugins.json，再删除回滚目录树
//
// AbortSignal 贯穿 git clone（经 execa 的 `signal`）和递归复制（在条目间
// 协作检查），因此长安装过程中按 Esc 能干净地取消进行中的工作。
//
// 缓存布局有意按版本划分，好让 `/plugin update` 能并排安装新版本并原子
// 切换（后续改进）；目前 registry 指向一个活动版本，各缓存版本并排保留。
import { execa } from 'execa'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { debugLog, errorMessage } from '../utils.js'
import { atomicWriteFile } from '../utils/atomic-file.js'
import { type ConsentPreview, buildConsentPreview, probePluginRoot } from './consent.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { RESERVED_MARKETPLACE_NAMES, readKnownMarketplaces, resolveCloneUrl } from './marketplace.js'
import { installedPluginsPath, pluginCacheDir, pluginCacheParent } from './paths.js'
import type {
  InstalledPluginRecord,
  InstalledPlugins,
  ManifestFormat,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'
import { type UserConfigValue, setPluginUserConfig } from './user-config.js'

export interface InstallRequest {
  source: PluginSource
  /** 该插件所属的市场。对于不关联任何已订阅市场的直接 git/local 安装，
   *  用 `"local"`——生成的插件 id 将是 `<name>@local`。 */
  marketplace: string
  /** 安装记录在哪个作用域（即哪个 settings.json 的 `enabledPlugins` 映射
   *  会提到它）。默认为 `'user'`。 */
  scope?: PluginScope
  /** 若设置，当 manifest 的 `name` 字段不匹配时安装器中止——供市场安装
   *  路径用于拦截伪造条目。 */
  expectedName?: string
  /** 市场条目是否把该插件标记为 verified。传给授权回调，让用户知道该
   *  条目是否带有策展人背书。纯元数据——我们不会基于该标志授予额外信任。 */
  verified?: boolean
  /** 在 manifest 解析之后、临时目录移到缓存之前调用。返回 false 即中止
   *  安装——临时目录被清理，缓存不受影响。缺省 ⇒ 不提示直接安装（供测试
   *  与 `--yes` CLI 标志使用）。 */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
  /** 当 manifest 声明 `userConfig` 时，在授权通过之后调用。调用方（CLI /
   *  TUI 处理器）为每个字段收集值——通常是一次提示一个字段，对
   *  `sensitive: true` 的字段屏蔽输入——然后解析成 `{ key: value }` 映射，
   *  经 user-config.ts 持久化。返回 `null` 即中止安装（视同拒绝授权）。
   *  缺省 ⇒ 跳过提示；非敏感字段回落到 manifest 默认值，敏感字段则直接
   *  不设置（插件的 hooks / MCP 条目会看到空的环境变量，与目前一致）。 */
  userConfigPrompt?: (fields: PluginManifest['userConfig']) => Promise<Record<string, UserConfigValue> | null>
  signal?: AbortSignal
}

export interface InstallResult {
  pluginId: string
  rootDir: string
  manifest: PluginManifest
  manifestFormat: ManifestFormat
  record: InstalledPluginRecord
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export async function installPlugin(req: InstallRequest): Promise<InstallResult> {
  // ── 前置策略检查（廉价、快速失败） ──
  // `strictKnownMarketplaces` 和 `blockedPlugins` 来自
  // ~/.x-code/plugins/known_marketplaces.json。当管理员（通常是企业）
  // 启用严格模式时，每次安装都必须来自已订阅的市场——直接的 git /
  // github / local 安装会被拒绝。`blockedPlugins` 在 manifest 解析之后
  // 检查（我们需要规范 id）。
  const km = await readKnownMarketplaces()
  if (km.strictKnownMarketplaces) {
    const subscribed = km.marketplaces.some((m) => m.name === req.marketplace)
    if (!subscribed) {
      throw new InstallError(
        `strict marketplace mode is enabled (known_marketplaces.json:strictKnownMarketplaces=true) — ` +
          `plugins can only be installed from a subscribed marketplace, but "${req.marketplace}" is not one. ` +
          `Either subscribe it first (\`xc plugin marketplace add\`) or turn strict mode off.`,
      )
    }
  }

  const tempDir = await fetchToTemp(req.source, req.signal)

  try {
    await validatePluginTree(tempDir, req.signal)
    const discovery = await discoverManifest(tempDir)
    if (!discovery) {
      throw new InstallError(
        'no plugin manifest found in source (looked for .x-code-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      )
    }
    if (discovery.format === 'gemini') {
      throw new InstallError(
        'this is a Gemini extension (gemini-extension.json) — x-code-cli does not support Gemini extensions; see docs/plugins.md',
      )
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      if (err instanceof ManifestParseError) throw new InstallError(err.message)
      throw err
    }

    if (req.expectedName && manifest.name !== req.expectedName) {
      throw new InstallError(`manifest name "${manifest.name}" does not match expected "${req.expectedName}"`)
    }

    // 现在知道了规范插件 id，执行第二个策略检查：来自
    // known_marketplaces.json 的 blockedPlugins。这是管理员式的强制禁用
    // 列表——对被屏蔽 id 的安装尝试，无论市场 / 授权如何都会被拒绝。
    // 接受两种匹配形式：
    //   - 全限定 id `name@marketplace` —— 精确（管理员可以只屏蔽某一个
    //     市场的变体而不影响其它 fork）
    //   - 裸名 `name` —— 宽泛（管理员可以一次性屏蔽所有市场中同名插件；
    //     符合部分管理员期望的 npm `--ignore` 风格）
    const earlyId = `${manifest.name}@${req.marketplace}`
    const blocked = km.blockedPlugins?.find((b) => b === earlyId || b === manifest.name)
    if (blocked) {
      throw new InstallError(
        `plugin "${earlyId}" is on the blockedPlugins list in known_marketplaces.json ` +
          `(matched entry: "${blocked}") — remove it from that list (or use a different plugin) to install.`,
      )
    }

    // ── 授权闸门 ──
    // 基于已解析的 manifest 构建，好让调用方渲染该插件将贡献内容（hooks、
    // mcp、作用域）的预览并显式询问用户。对非交互路径，跳过提示（回调
    // 缺省）是有意为之——CLI 通过不传 `consent` 来实现 `--yes`。
    if (req.consent) {
      const rootProbe = await probePluginRoot(tempDir)
      const preview = buildConsentPreview({
        pluginId: `${manifest.name}@${req.marketplace}`,
        manifest,
        source: req.source,
        marketplace: req.marketplace,
        verified: req.verified,
        fromReservedMarketplace: req.marketplace in RESERVED_MARKETPLACE_NAMES,
        rootProbe,
      })
      const accepted = await req.consent(preview)
      if (!accepted) {
        throw new InstallError('install cancelled by user (consent declined)')
      }
    }

    // ── userConfig 提示（授权之后、提交之前） ──
    // 仅当 manifest 声明 userConfig 字段且调用方接入了提示回调时才触发。
    // 非交互路径（--yes、CI）跳过提示——字段保持未设置，插件在 hook /
    // mcp 启动时看到空的环境变量，与此功能之前一致。提示返回 null 即
    // 中止安装（视同拒绝授权）；非 null 对象经 setPluginUserConfig 持久化。
    if (manifest.userConfig && manifest.userConfig.length > 0 && req.userConfigPrompt) {
      const collected = await req.userConfigPrompt(manifest.userConfig)
      if (collected === null) {
        throw new InstallError('install cancelled by user (userConfig prompt aborted)')
      }
      // 在把临时目录移到缓存之前持久化，这样两个阶段之间崩溃时，用户
      // 既不会留下坏插件，也不会留下孤立的密钥。该 settings 文件以插件
      // id 为键，重装时干净覆盖。
      const pluginIdForConfig = `${manifest.name}@${req.marketplace}`
      await setPluginUserConfig(pluginIdForConfig, collected)
    }

    const pluginId = `${manifest.name}@${req.marketplace}`
    const finalDir = pluginCacheDir(req.marketplace, manifest.name, manifest.version)
    const record: InstalledPluginRecord = {
      id: pluginId,
      name: manifest.name,
      marketplace: req.marketplace,
      version: manifest.version,
      source: req.source,
      installedAt: new Date().toISOString(),
      installScope: req.scope ?? 'user',
    }
    await withPluginMutationLock(async () => {
      const swap = await stageAndSwapPluginDirectory(tempDir, finalDir, req.signal)
      try {
        await recordInstallation(record)
        await swap.commit()
      } catch (error) {
        await swap.rollback()
        throw error
      }
    })

    return { pluginId, rootDir: finalDir, manifest, manifestFormat: discovery.format, record }
  } catch (err) {
    // 安装中途任何失败时尽力清理临时目录。moveOrCopy 的成功路径会把
    // 临时目录 rename 走，所以这里只在 move 之前出错时才触发。
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* 无可作为 */
    })
    if (err instanceof InstallError || err instanceof ManifestParseError) throw err
    throw new InstallError(errorMessage(err))
  }
}

// ── 来源 → 临时目录 ───────────────────────────────────────────────────

async function fetchToTemp(source: PluginSource, signal?: AbortSignal): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-install-'))

  if (source.kind === 'local') {
    const resolved = path.resolve(source.path)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      // 在错误里带出 cwd：相对路径会按 process.cwd() 解析，而通过
      // `pnpm dev` 启动 xc 时 cwd 是 `packages/cli/` 而不是仓库根目录——
      // 这种不一致会让在 slash 命令里输入 `./foo` 的用户困惑。同时展示
      // 解析后的绝对路径和 cwd，能让原因一目了然。
      const isRelative = !path.isAbsolute(source.path)
      const cwdHint = isRelative ? ` (resolved relative to cwd: ${process.cwd()})` : ''
      throw new InstallError(`local source is not a directory: ${resolved}${cwdHint}`)
    }
    await copyDirFiltered(resolved, tempDir, signal)
    return tempDir
  }

  if (source.kind === 'git' || source.kind === 'github') {
    const cloneUrl = source.kind === 'git' ? source.url : resolveCloneUrl(`github:${source.owner}/${source.repo}`)
    const args = ['clone', '--depth', '1']
    if (source.ref) args.push('--branch', source.ref)
    // 对 subdir 安装我们仍浅克隆整个仓库。真正的 sparse-checkout 在巨大
    // monorepo 上会更快，但 `--depth 1 --filter=blob:none --sparse` 序列
    // 在不同 git 版本间很脆弱；即使是大型 monorepo，depth-1 克隆通常也
    // 不到 100 MB。若日后成为痛点再重新考虑。
    args.push(cloneUrl, tempDir)

    try {
      await execa('git', args, { signal, stdio: 'pipe' })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new InstallError(`git clone failed: ${errorMessage(err)}`)
    }

    // 完整性校验：当 marketplace.json 钉死了 `sha` 时，校验我们实际克隆的
    // 提交是否与之匹配。用于防御在市场评审与最终用户安装之间上游 ref 被
    // 强推、或仓库被攻破的情况。必须在下面删除 `.git` 之前运行（rev-parse
    // 需要仓库元数据）。
    //
    // 前缀匹配语义：声明的 sha 可以是短 sha（≥7 位十六进制），仍能对照
    // 完整的 40 位 HEAD 校验——与 `git checkout <short-sha>` 的容错一致，
    // 也是真实市场产生的形式（anthropics/claude-plugins-official 有时
    // 会发布 7 位 sha）。
    //
    // 为什么是硬失败而不是警告：sha 不匹配按定义要么是 marketplace.json
    // 配置错误（作者 bug），要么是真实的供应链异常。无论哪种，用户都不
    // 应该在磁盘上留下未评审的代码。与其静默安装恰好是 HEAD 的东西，
    // 不如抛出指向市场作者的响亮错误。
    if (source.expectedSha) {
      try {
        const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir, stdio: 'pipe', signal })
        const actualSha = result.stdout.trim().toLowerCase()
        const expected = source.expectedSha.toLowerCase()
        if (!actualSha.startsWith(expected)) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          throw new InstallError(
            `sha integrity check failed for ${cloneUrl}${source.ref ? `@${source.ref}` : ''}: ` +
              `marketplace.json declared sha=${expected}, actual HEAD=${actualSha}. ` +
              `The upstream ref may have been force-pushed or the repo compromised. ` +
              `Contact the marketplace author or pin to a different version.`,
          )
        }
      } catch (err) {
        if (err instanceof InstallError) throw err
        // rev-parse 失败（在全新克隆上不应发生）——视作完整性失败，以免
        // 静默安装未经校验的内容。
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`failed to verify sha for ${cloneUrl}: ${errorMessage(err)}`)
      }
    }

    // 删除 .git 目录——安装后不再需要，且对历史悠久的仓库会显著撑大缓存。
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => {})

    // subdir 处理：插件实际位于 <tempDir>/<subdir>。重新暂存，让安装流程
    // 的其余部分（manifest 发现 + moveOrCopy 到缓存）只针对该子目录操作。
    // 最简单的做法：把子目录复制进新的临时目录，丢弃原始克隆。
    const subdir = source.subdir
    if (subdir) {
      const cloneRoot = await fs.realpath(tempDir)
      const lexicalSubdirPath = path.resolve(tempDir, subdir)
      const lexicalRelative = path.relative(tempDir, lexicalSubdirPath)
      if (
        path.isAbsolute(subdir) ||
        lexicalRelative === '..' ||
        lexicalRelative.startsWith('..' + path.sep) ||
        path.isAbsolute(lexicalRelative)
      ) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`subdir "${subdir}" escapes the cloned repository`)
      }
      const subdirPath = await fs.realpath(lexicalSubdirPath).catch(() => lexicalSubdirPath)
      const physicalRelative = path.relative(cloneRoot, subdirPath)
      if (
        physicalRelative === '..' ||
        physicalRelative.startsWith('..' + path.sep) ||
        path.isAbsolute(physicalRelative)
      ) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`subdir "${subdir}" resolves outside the cloned repository`)
      }
      const stat = await fs.stat(subdirPath).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`subdir "${subdir}" not found in cloned repo ${cloneUrl}`)
      }
      const subdirTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-subdir-'))
      try {
        await copyDirFiltered(subdirPath, subdirTemp, signal)
      } catch (err) {
        await fs.rm(subdirTemp, { recursive: true, force: true }).catch(() => {})
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`failed to extract subdir: ${errorMessage(err)}`)
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      return subdirTemp
    }
    return tempDir
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  throw new InstallError(`unknown source kind: ${(source as PluginSource).kind}`)
}

/** 我们永不复制透传的目录名。排除 `node_modules` 是因为打包了依赖的插件
 *  应该在用户机器上重新安装；若真有插件确实需要 node_modules，我们再来
 *  重新考虑。 */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])
const MAX_PLUGIN_FILES = 20_000
const MAX_PLUGIN_FILE_BYTES = 100 * 1024 * 1024
const MAX_PLUGIN_TOTAL_BYTES = 512 * 1024 * 1024

interface CopyBudget {
  files: number
  bytes: number
}

function countPluginEntry(budget: CopyBudget): void {
  budget.files++
  if (budget.files > MAX_PLUGIN_FILES) {
    throw new InstallError('plugin source exceeds the safe file-count or size limit')
  }
}

function countPluginBytes(budget: CopyBudget, size: number): void {
  budget.bytes += size
  if (size > MAX_PLUGIN_FILE_BYTES || budget.bytes > MAX_PLUGIN_TOTAL_BYTES) {
    throw new InstallError('plugin source exceeds the safe file-count or size limit')
  }
}

async function validatePluginTree(rootDir: string, signal?: AbortSignal): Promise<void> {
  const rootPhysical = await fs.realpath(rootDir)
  const budget: CopyBudget = { files: 0, bytes: 0 }
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      signal?.throwIfAborted()
      countPluginEntry(budget)
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(entryPath)
        const resolved = path.resolve(directory, target)
        const relative = path.relative(rootDir, resolved)
        const physical = await fs.realpath(resolved).catch(() => null)
        const physicalRelative = physical ? path.relative(rootPhysical, physical) : relative
        const targetStats = await fs.stat(resolved).catch(() => null)
        if (
          relative === '' ||
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative) ||
          physicalRelative === '..' ||
          physicalRelative.startsWith('..' + path.sep) ||
          path.isAbsolute(physicalRelative) ||
          targetStats?.isDirectory()
        ) {
          await fs.rm(entryPath, { force: true })
        } else if (targetStats?.isFile()) {
          // 没有 symlink 权限的 Windows 主机会把这个目标复制进缓存，因此
          // 把它的大小也计入同一预算。
          countPluginBytes(budget, targetStats.size)
        }
        continue
      }
      if (!entry.isFile()) {
        await fs.rm(entryPath, { recursive: true, force: true })
        continue
      }
      const stats = await fs.stat(entryPath)
      countPluginBytes(budget, stats.size)
    }
  }
  await visit(rootDir)
}

async function copyDirFiltered(
  src: string,
  dst: string,
  signal?: AbortSignal,
  root?: string,
  budget: CopyBudget = { files: 0, bytes: 0 },
): Promise<void> {
  // `root` 在第一次（非递归）调用时捕获，这样下面的 symlink 逃逸检查是
  // 针对原始插件来源校验，而不是当前递归的 `src`（它随每个子目录变动）。
  const rootDir = root ?? src
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (COPY_SKIP.has(entry.name)) continue
    countPluginEntry(budget)
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirFiltered(s, d, signal, rootDir, budget)
    } else if (entry.isFile()) {
      const stats = await fs.stat(s)
      countPluginBytes(budget, stats.size)
      await fs.copyFile(s, d)
    } else if (entry.isSymbolicLink()) {
      // 相对其所在目录解析 symlink 目标。若解析后的目标逃逸出插件来源
      // 根目录，就丢弃该 symlink 而不是保留：在 POSIX 上，插件树里的
      // `evil -> /etc/passwd` 会在缓存中留下一个宿主文件指针，供 loader /
      // hooks 在运行时解引用；在 Windows 上，下面的回退会把类似
      // `/etc/passwd` 的东西直接复制进缓存。我们不顺着 symlink 去校验目标
      // 是否存在——一个断了但仍位于边界内的 symlink 保留起来仍是安全的。
      const target = await fs.readlink(s)
      const resolved = path.resolve(path.dirname(s), target)
      const rel = path.relative(rootDir, resolved)
      if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        debugLog('plugins.copy-symlink-escape', `${s} -> ${target} (resolved ${resolved}, outside ${rootDir})`)
        continue
      }
      const targetStats = await fs.stat(resolved).catch(() => null)
      if (targetStats?.isFile()) countPluginBytes(budget, targetStats.size)
      try {
        await fs.symlink(target, d)
      } catch {
        // 没有 symlink 权限的 Windows：回退为复制已解析的文件。尽力而为——
        // 断掉的 symlink 直接丢弃。
        await fs.copyFile(s, d).catch(() => {})
      }
    }
  }
}

/** 从临时目录移动到最终目录。当 src 与 dst 在同一文件系统时，rename 原子
 *  且廉价；否则（主要是 Windows 上的 EXDEV）回退为 copy + rm。 */
async function moveOrCopy(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  try {
    await fs.rename(src, dst)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
      // 此处若抛出原始错误，会因瞬时异常而阻断安装；下面 copy 回退在我们
      // 见过的所有实际场景里都能成功。仍记日志以便事后排查。
      debugLog('plugins.install-rename-fallback', String(err))
    }
  }
  await copyDirFiltered(src, dst, signal)
  await fs.rm(src, { recursive: true, force: true }).catch(() => {})
}

async function stageAndSwapPluginDirectory(
  sourceDir: string,
  finalDir: string,
  signal?: AbortSignal,
): Promise<{ commit: () => Promise<void>; rollback: () => Promise<void> }> {
  const parent = path.dirname(finalDir)
  const nonce = `${process.pid}-${randomUUID()}`
  const stageDir = path.join(parent, `.${path.basename(finalDir)}.${nonce}.stage`)
  const backupDir = path.join(parent, `.${path.basename(finalDir)}.${nonce}.backup`)
  await fs.mkdir(parent, { recursive: true })
  try {
    await moveOrCopy(sourceDir, stageDir, signal)
  } catch (error) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  let hasBackup = false
  try {
    await fs.rename(finalDir, backupDir)
    hasBackup = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  try {
    await fs.rename(stageDir, finalDir)
  } catch (error) {
    if (hasBackup) await fs.rename(backupDir, finalDir).catch(() => {})
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    commit: async () => {
      if (hasBackup) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch((error) => {
          debugLog('plugins.install-backup-cleanup-failed', errorMessage(error))
        })
      }
    },
    rollback: async () => {
      await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {})
      if (hasBackup) await fs.rename(backupDir, finalDir).catch(() => {})
    },
  }
}

// ── installed_plugins.json 记账 ──────────────────────────────────

let pluginMutationTail: Promise<void> = Promise.resolve()

async function withPluginMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pluginMutationTail.catch(() => {})
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  pluginMutationTail = previous.then(() => gate)
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

async function readInstalledPlugins(): Promise<InstalledPlugins> {
  const file = installedPluginsPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as InstalledPlugins
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
      return { schemaVersion: '1', plugins: [] }
    }
    return { schemaVersion: parsed.schemaVersion ?? '1', plugins: parsed.plugins }
  } catch {
    return { schemaVersion: '1', plugins: [] }
  }
}

async function writeInstalledPlugins(data: InstalledPlugins): Promise<void> {
  const file = installedPluginsPath()
  await atomicWriteFile(file, JSON.stringify(data, null, 2) + '\n')
}

async function recordInstallation(record: InstalledPluginRecord): Promise<void> {
  const data = await readInstalledPlugins()
  const idx = data.plugins.findIndex((p) => p.id === record.id)
  if (idx >= 0) data.plugins[idx] = record
  else data.plugins.push(record)
  await writeInstalledPlugins(data)
}

export async function listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const data = await readInstalledPlugins()
  return data.plugins
}

export async function findInstalledPlugin(id: string): Promise<InstalledPluginRecord | undefined> {
  const data = await readInstalledPlugins()
  return data.plugins.find((p) => p.id === id)
}

// ── 卸载 ──────────────────────────────────────────────────────────

export interface UninstallResult {
  /** 从缓存删除的版本。若插件未被缓存则为空。 */
  removedVersions: string[]
  /** installed_plugins.json 记录是否被删除。 */
  removedRecord: boolean
}

/** 删除某插件的所有缓存版本，并去掉它的 installed_plugins.json 记录。
 *  保留数据目录（`~/.x-code/plugins/data/<id>/`）不动，这样用户日后重装
 *  不会丢失状态。 */
export async function uninstallPlugin(id: string): Promise<UninstallResult> {
  return withPluginMutationLock(async () => {
    const data = await readInstalledPlugins()
    const record = data.plugins.find((plugin) => plugin.id === id)
    const result: UninstallResult = { removedVersions: [], removedRecord: false }

    if (record) {
      const parent = pluginCacheParent(record.marketplace, record.name)
      try {
        const versions = await fs.readdir(parent)
        result.removedVersions = versions.filter((version) => !version.startsWith('.'))
        await fs.rm(parent, { recursive: true, force: true })
      } catch {
        // 没有缓存条目——该记录可能是陈旧的。下面删除记录仍会执行。
      }
    }

    const before = data.plugins.length
    data.plugins = data.plugins.filter((plugin) => plugin.id !== id)
    if (data.plugins.length !== before) {
      await writeInstalledPlugins(data)
      result.removedRecord = true
    }

    return result
  })
}
