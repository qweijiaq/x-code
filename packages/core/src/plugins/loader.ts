// @x-code-cli/core — 插件启动加载器
//
// 从 CLI 入口调用的一次性编排。两轮：
//
//   Pass 1 —— 来自 installed_plugins.json 的 user 作用域安装。每条记录
//            指向一个带版本的缓存目录；我们加载记录所指的那个版本。孤儿
//            记录（记录存在但缓存目录缺失）会以 PluginLoadError 浮现。
//
//   Pass 2 —— <cwd>/.x-code/plugins/<name>/ 下的项目本地插件。它们不在
//            installed_plugins.json 中跟踪——而是作为仓库内插件提交进仓库。
//            这些插件的市场名恒为 "local"。
//
// `installed_plugins.json` 是 user 作用域安装的事实来源。孤儿缓存目录
// （无记录）被静默忽略——它们会在用户下次运行 `/plugin uninstall` 时清理。
//
// 单个坏插件（坏 JSON、缺 manifest、schema 违规）绝不中止启动——错误收集
// 进 `PluginLoadError[]`，供 `/plugin doctor` 呈现。
//
// 返回的 `PluginRegistry` 意在本次会话内冻结（与 MCP / skills 相同的字节
// 稳定约束——见 CLAUDE.md）。CLI 在启动时调用一次 `loadAllPlugins()`，并把
// 结果挂在 `AgentOptions` 上。`/plugin refresh` 通过 `registry.reload(...)`
// 换掉内存状态，并使 `systemPromptCache` 失效。
import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage, isDir, isFile } from '../utils.js'
import { EnableState } from './enable-state.js'
import { listInstalledPlugins } from './installer.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { pluginCacheDir, projectPluginsDir } from './paths.js'
import { PluginRegistry } from './registry.js'
import type {
  InlineHookConfig,
  InlineMcpServers,
  LoadedPlugin,
  PluginLoadError,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'

export interface LoadOptions {
  /** 当前工作目录。用于查找项目本地插件。 */
  cwd: string
  /** 完全跳过插件加载。接到 `--no-plugins` 启动标志上。返回空 registry。 */
  disabled?: boolean
}

export interface LoadResult {
  registry: PluginRegistry
  /** 每个插件解析后的贡献路径。Workflow B（skill / agent / mcp loader
   *  集成）从这里读取，以并入插件提供的内容。以插件 id 为键。 */
  contributions: Map<string, ResolvedContributions>
}

/** 插件的 manifest 贡献，相对路径已按 `rootDir` 解析。`mcpServers` 与
 *  `hooks` 上的 `path` / `inline` 判别符反映了 manifest 的联合类型——作者
 *  要么指向文件，要么内联配置。 */
export interface ResolvedContributions {
  /** 插件的 skills 目录绝对路径（若有）。其下每个子目录都应按既有的
   *  `<name>/SKILL.md` 布局组织（这样 skill loader 无需改动即可扫描）。 */
  skillsDir?: string
  /** 插件 sub-agent .md 文件目录的绝对路径。 */
  agentsDir?: string
  /** 插件 slash 命令 .md 文件目录的绝对路径。 */
  commandsDir?: string
  /** mcpServers 贡献——要么是形如 `{ mcpServers: { ... } }` 的 JSON 文件
   *  路径，要么是内联记录（与 ~/.x-code/config.json 的 `mcpServers` 形状
   *  一致）。 */
  mcpServers?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineMcpServers }
  /** hooks 贡献——hooks.json 的路径或内联对象。schema 校验位于
   *  packages/core/src/hooks（workflow C）。 */
  hooks?: { kind: 'path'; path: string } | { kind: 'inline'; data: InlineHookConfig }
}

export async function loadAllPlugins(opts: LoadOptions): Promise<LoadResult> {
  if (opts.disabled) {
    return { registry: new PluginRegistry([], []), contributions: new Map() }
  }

  const enableState = await EnableState.load(opts.cwd)
  const plugins: LoadedPlugin[] = []
  const errors: PluginLoadError[] = []
  const contributions = new Map<string, ResolvedContributions>()

  // ── Pass 1：user 作用域安装 ────────────────────────────────────────
  const installed = await listInstalledPlugins()
  for (const record of installed) {
    const rootDir = pluginCacheDir(record.marketplace, record.name, record.version)
    await loadOnePlugin({
      rootDir,
      fallbackId: record.id,
      marketplace: record.marketplace,
      scope: record.installScope,
      source: record.source,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  // ── Pass 2：项目本地插件 ──────────────────────────────────────
  const projectRoot = projectPluginsDir(opts.cwd)
  let projectEntries: import('node:fs').Dirent[] = []
  try {
    projectEntries = await fs.readdir(projectRoot, { withFileTypes: true })
  } catch {
    /* 没有项目插件目录——常见情况 */
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue
    const pluginRoot = path.join(projectRoot, entry.name)
    await loadOnePlugin({
      rootDir: pluginRoot,
      // 由目录名派生的临时 id；解析 manifest 后会被 manifest.name 覆盖。
      fallbackId: `${entry.name}@local`,
      marketplace: 'local',
      scope: 'project',
      source: undefined,
      enableState,
      plugins,
      errors,
      contributions,
    })
  }

  return { registry: new PluginRegistry(plugins, errors), contributions }
}

interface LoadOneArgs {
  rootDir: string
  fallbackId: string
  marketplace: string
  scope: PluginScope
  source: PluginSource | undefined
  enableState: EnableState
  plugins: LoadedPlugin[]
  errors: PluginLoadError[]
  contributions: Map<string, ResolvedContributions>
}

async function loadOnePlugin(args: LoadOneArgs): Promise<void> {
  try {
    const discovery = await discoverManifest(args.rootDir)
    if (!discovery) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message:
          'no plugin manifest found (looked for .x-code-plugin/plugin.json, .claude-plugin/plugin.json, plugin.json)',
      })
      return
    }
    if (discovery.format === 'gemini') {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: 'Gemini extensions are not supported (gemini-extension.json detected); see docs/plugins.md',
      })
      return
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      args.errors.push({
        id: args.fallbackId,
        path: args.rootDir,
        message: err instanceof ManifestParseError ? err.message : String(err),
      })
      return
    }

    // 规范 id 始终来自 manifest，而非缓存目录名。对已安装插件，它与记录
    // 的 id 一致；对项目本地插件，它可能与目录名不同，此时 manifest 优先。
    const id = `${manifest.name}@${args.marketplace}`
    const enableResolution = args.enableState.resolve(id)

    const plugin: LoadedPlugin = {
      id,
      manifest,
      rootDir: args.rootDir,
      manifestPath: discovery.manifestPath,
      manifestFormat: discovery.format,
      source: args.source,
      marketplace: args.marketplace,
      scope: args.scope,
      enabled: enableResolution.enabled,
    }
    args.plugins.push(plugin)
    args.contributions.set(id, await resolveContributions(plugin))
  } catch (err) {
    args.errors.push({
      id: args.fallbackId,
      path: args.rootDir,
      message: errorMessage(err),
    })
  }
}

/** 把插件的 manifest 贡献字段解析成绝对路径（或内联对象）。之所以导出，
 *  是因为个别调用方偶尔需要重算（例如 `/plugin info` 针对单个插件）。
 *
 *  **每种贡献类型有两轮发现：**
 *
 *  1. **manifest 声明** —— 若 manifest 指名了路径（如
 *     `"skills": "./my-skills"`），就用它。
 *  2. **基于约定的回退** —— 若未声明，就探测约定目录（`skills/`、
 *     `agents/`、`commands/`）和约定文件（`hooks/hooks.json`、
 *     `.mcp.json`、`mcp.json`）。真实 Claude Code 插件就是这样工作的——
 *     它们的 manifest 通常只有 `name`/`version`/`description`，并把贡献
 *     文件放在旁边。
 *
 *  之所以是 async，是因为约定探测需要 stat 目录。 */
export async function resolveContributions(plugin: LoadedPlugin): Promise<ResolvedContributions> {
  const m = plugin.manifest
  const root = plugin.rootDir
  const result: ResolvedContributions = {}

  // skills / agents / commands —— 目录类贡献
  if (m.skills) {
    result.skillsDir = path.resolve(root, m.skills)
  } else if (await isDir(path.join(root, 'skills'))) {
    result.skillsDir = path.join(root, 'skills')
  }
  if (m.agents) {
    result.agentsDir = path.resolve(root, m.agents)
  } else if (await isDir(path.join(root, 'agents'))) {
    result.agentsDir = path.join(root, 'agents')
  }
  if (m.commands) {
    result.commandsDir = path.resolve(root, m.commands)
  } else if (await isDir(path.join(root, 'commands'))) {
    result.commandsDir = path.join(root, 'commands')
  }

  // mcpServers —— 要么已声明（路径 / 内联），要么从约定文件自动发现
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      result.mcpServers = { kind: 'path', path: path.resolve(root, m.mcpServers) }
    } else {
      result.mcpServers = { kind: 'inline', data: m.mcpServers }
    }
  } else {
    // Claude Code 约定：插件根目录下的 `.mcp.json`。我们也接受不带点的
    // `mcp.json` 作为实用回退——有些作者用这种可见形式。
    for (const conv of ['.mcp.json', 'mcp.json']) {
      const p = path.join(root, conv)
      if (await isFile(p)) {
        result.mcpServers = { kind: 'path', path: p }
        break
      }
    }
  }

  // hooks —— 同样的模式，约定文件为 `hooks/hooks.json`
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      result.hooks = { kind: 'path', path: path.resolve(root, m.hooks) }
    } else {
      result.hooks = { kind: 'inline', data: m.hooks }
    }
  } else {
    const conv = path.join(root, 'hooks', 'hooks.json')
    if (await isFile(conv)) {
      result.hooks = { kind: 'path', path: conv }
    }
  }

  return result
}
