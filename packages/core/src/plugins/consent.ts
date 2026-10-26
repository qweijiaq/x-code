// @x-code-cli/core — 安装时的授权预览
//
// 在插件内容提交到缓存之前，安装器会构造一个 `ConsentPreview`，
// 汇总该插件将要贡献的内容（hooks、MCP 服务器、作用域等），并交给
// 调用方提供的授权回调。若回调返回 false，安装中止，临时目录被清理。
//
// 预览基于已经解析过的 manifest 构建，因此所有校验工作都已完成——
// 等到我们向用户询问“是否接受”时，我们已经知道插件能干净解析、
// 以及它会触碰用户系统上的哪些东西。
//
// 有意不包含的内容：
//
//   - Skill / agent / command 的数量（它们藏在子目录里；仅为构建
//     预览就去扫描会拖慢每次安装，而且预览只求一瞥，不是审计）。
//   - LICENSE 文件内容——只以文件名呈现；读者应顺着主页 / 源码
//     URL 去阅读真正的条款。
//
// 有意包含的内容——真正有安全波及面的东西：hooks（任意 shell）、
// MCP 服务器（任意子进程），以及来源（让用户知道它来自可信市场，
// 还是某个随意的 GitHub 仓库）。
import fs from 'node:fs/promises'
import path from 'node:path'

import { parseHookConfig } from '../hooks/config-schema.js'
import type { HookEventName } from '../hooks/types.js'
import { parseServersBlock } from '../mcp/config-schema.js'
import { isDir, isFile } from '../utils.js'
import { extractMcpServersBlock } from './mcp-contributions.js'
import type { PluginManifest, PluginSource, UserConfigItem } from './types.js'

export interface ConsentPreview {
  pluginId: string
  version: string
  description?: string
  source: PluginSource
  marketplace: string
  /** 当安装来自标记为 `verified` 的市场时为 true。 */
  verified: boolean
  /** 当市场名是 `RESERVED_MARKETPLACE_NAMES` 之一时为 true。 */
  fromReservedMarketplace: boolean
  /** 插件注册的 hook 事件名。为空表示没有 hooks。 */
  hookEvents: HookEventName[]
  /** 以内联形式贡献的 MCP 服务器名（路径形式不预览——需要在授权前
   *  再读一个文件）。 */
  inlineMcpServerNames: string[]
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /** 当 manifest 将 `mcpServers` 声明为文件路径（而非内联）时为 true——
   *  授权时我们还没有这些名称，但可以提醒用户该插件确实会带来 MCP
   *  服务器。 */
  hasPathMcpServers: boolean
  /** 同上，用于通过路径（而非内联）声明的 hooks。 */
  hasPathHooks: boolean
  author?: string
  license?: string
  homepage?: string
  /** 插件需要用户提供的字段。安装 UI 在授权后、插件提交前收集这些值。 */
  userConfig?: UserConfigItem[]
}

/** 关于插件根目录的文件系统侧信息——仅靠 manifest 检查看不到的东西。
 *  由 [[probePluginRoot]] 填充并传给 [[buildConsentPreview]]，这样
 *  安装时的“将贡献”一行能反映自动发现的贡献（例如 Claude Code 的约定：
 *  把 `.mcp.json` 放在 plugin.json 旁边，而不是在 manifest 里声明
 *  `mcpServers`）。 */
export interface RootProbe {
  hasSkillsDir: boolean
  hasAgentsDir: boolean
  hasCommandsDir: boolean
  /** 从根级 `.mcp.json` / `mcp.json` 解析出的服务器名（平面和包裹两种
   *  形状都接受；见 [[extractMcpServersBlock]]）。当两个文件都不存在
   *  或解析失败时为空。 */
  rootMcpServerNames: string[]
  /** 当根级 mcp 文件存在、即使未能从中解析出任何名称时为 true。让授权
   *  UI 在名称暂时未知时仍能警告“该插件会贡献 MCP 服务器”。 */
  hasRootMcpFile: boolean
  /** 若存在，从根级 `hooks/hooks.json` 解析出的 hook 事件名。 */
  rootHookEvents: HookEventName[]
  /** 无论解析结果如何，只要 `hooks/hooks.json` 存在即为 true。 */
  hasRootHooksFile: boolean
}

export interface BuildPreviewInput {
  pluginId: string
  manifest: PluginManifest
  source: PluginSource
  marketplace: string
  verified?: boolean
  fromReservedMarketplace?: boolean
  /** 可选的插件根目录探测。缺省时，授权只显示 manifest 声明的部分——
   *  会漏掉那些以约定文件 / 目录（放在 `plugin.json` 旁边）方式携带
   *  贡献的 Claude Code 约定插件。 */
  rootProbe?: RootProbe
}

/** 探测插件根目录下 loader 的 `resolveContributions` 在运行时会拾取的
 *  约定贡献文件 / 目录。授权 UI 用它来保证“将贡献”不会说谎——当插件把
 *  `skills/`、`.mcp.json` 等放在根目录却未在 manifest 里点名时。可对任意
 *  目录安全调用——每次探测都是尽力而为的 stat / read，缺失或不可读的
 *  文件一律视为“不存在”。 */
export async function probePluginRoot(rootDir: string): Promise<RootProbe> {
  const [hasSkillsDir, hasAgentsDir, hasCommandsDir] = await Promise.all([
    isDir(path.join(rootDir, 'skills')),
    isDir(path.join(rootDir, 'agents')),
    isDir(path.join(rootDir, 'commands')),
  ])

  let rootMcpServerNames: string[] = []
  let hasRootMcpFile = false
  for (const conv of ['.mcp.json', 'mcp.json']) {
    const p = path.join(rootDir, conv)
    if (!(await isFile(p))) continue
    hasRootMcpFile = true
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const block = extractMcpServersBlock(parsed)
      const { servers } = parseServersBlock(block)
      rootMcpServerNames = Object.keys(servers)
    } catch {
      // 有意吞掉解析错误——它们在加载时会以精确的消息浮现。授权预览
      // 只需要知道文件存在。
    }
    break
  }

  let rootHookEvents: HookEventName[] = []
  let hasRootHooksFile = false
  const hooksPath = path.join(rootDir, 'hooks', 'hooks.json')
  if (await isFile(hooksPath)) {
    hasRootHooksFile = true
    try {
      const raw = await fs.readFile(hooksPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const cfg = parseHookConfig(parsed, rootDir)
      rootHookEvents = Object.keys(cfg) as HookEventName[]
    } catch {
      // 与 mcp 探测同理——加载时的错误优先。
    }
  }

  return {
    hasSkillsDir,
    hasAgentsDir,
    hasCommandsDir,
    rootMcpServerNames,
    hasRootMcpFile,
    rootHookEvents,
    hasRootHooksFile,
  }
}

/** 从已解析的 manifest 构建 `ConsentPreview`。hook + mcp 字段仅按内联
 *  形状检查；路径形式的贡献以 `has*` 布尔值呈现，这样授权 UI 即使在
 *  名称尚未可知时也能警告“该插件会贡献 MCP 服务器”。
 *
 *  当 `input.rootProbe` 存在时，约定式的根级贡献（未声明的 `.mcp.json`、
 *  `hooks/hooks.json`、`skills/` 等）也会合并进来——loader 会在运行时
 *  拾取它们，所以授权 UI 现在就需要知道。 */
export function buildConsentPreview(input: BuildPreviewInput): ConsentPreview {
  const m = input.manifest
  const probe = input.rootProbe

  let hookEvents: HookEventName[] = []
  let hasPathHooks = false
  if (m.hooks !== undefined) {
    if (typeof m.hooks === 'string') {
      hasPathHooks = true
    } else {
      try {
        const cfg = parseHookConfig(m.hooks, input.pluginId)
        hookEvents = Object.keys(cfg) as HookEventName[]
      } catch {
        // 不要因 hook 解析错误而让授权失败——安装路径会妥善地浮现这些
        // 错误。这里只让 hookEvents 保持为空，避免预览谎报注册内容。
      }
    }
  } else if (probe?.hasRootHooksFile) {
    hookEvents = probe.rootHookEvents
    hasPathHooks = true
  }

  let inlineMcpServerNames: string[] = []
  let hasPathMcpServers = false
  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers === 'string') {
      hasPathMcpServers = true
    } else {
      const { servers } = parseServersBlock(m.mcpServers)
      inlineMcpServerNames = Object.keys(servers)
    }
  } else if (probe?.hasRootMcpFile) {
    // 在插件根目录按约定发现的 `.mcp.json`——其波及面与 manifest 声明的
    // 路径条目相同。能解析时呈现名称；否则只标记该文件的存在。
    inlineMcpServerNames = probe.rootMcpServerNames
    hasPathMcpServers = true
  }

  return {
    pluginId: input.pluginId,
    version: m.version,
    description: m.description,
    source: input.source,
    marketplace: input.marketplace,
    verified: input.verified ?? false,
    fromReservedMarketplace: input.fromReservedMarketplace ?? false,
    hookEvents,
    inlineMcpServerNames,
    hasSkillsDir: !!m.skills || !!probe?.hasSkillsDir,
    hasAgentsDir: !!m.agents || !!probe?.hasAgentsDir,
    hasCommandsDir: !!m.commands || !!probe?.hasCommandsDir,
    hasPathMcpServers,
    hasPathHooks,
    author: m.author?.name,
    license: m.license,
    homepage: m.homepage,
    ...(m.userConfig && m.userConfig.length > 0 ? { userConfig: m.userConfig } : {}),
  }
}
