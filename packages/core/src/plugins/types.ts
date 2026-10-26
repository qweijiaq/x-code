// @x-code-cli/core — 插件系统核心类型
//
// 插件把 skills / sub-agents / slash commands / MCP servers / hooks 打包在
// 单个 manifest 和命名空间之下。插件在 CLI 启动时被发现、在本会话内冻结
// （与 skills + sub-agents 相同的字节稳定约束——见 CLAUDE.md 关于
// systemPromptCache 的说明），仅通过 `/plugin refresh` 重新加载，它会显式
// 使提示词缓存失效。
//
// Manifest 格式有意与 Claude Code 的 `.claude-plugin/plugin.json` 字节兼容，
// 让同一插件包可装进任一 CLI。原生的 `.x-code-plugin/plugin.json` 路径也
// 被接受（新写的纯 x-code 插件优先使用），根目录的裸 `plugin.json` 也容忍。

// ── 插件来源（它来自哪里） ───────────────────────────────────

/** 插件从何安装而来——安装器使用的内部规范形式，记录在
 *  `installed_plugins.json` 里。市场条目以不同的磁盘线上格式（字符串捷径、
 *  `git-subdir`、`url`）到达，并由 [[normalizeMarketplaceSource]] 归一化成
 *  此形状。`subdir` 在 git 与 github 上都支持，让 monorepo 发布的插件
 *  （在 `anthropics/claude-plugins-official` 这类真实 Claude Code 市场里
 *  很常见）能正确安装。
 *
 *  `expectedSha` 是可选的完整性钉，从 git 来源的市场条目 marketplace.json
 *  的 `sha` 字段传播而来。设置后，安装器克隆、运行 `git rev-parse HEAD`，
 *  不匹配就以 `InstallError` 中止。用于防御市场作者评审之后、用户安装之前，
 *  上游 ref 被强推或仓库被攻破。缺省字段则跳过该检查（这样未钉 sha 的市场
 *  仍能安装）。 */
export type PluginSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string; subdir?: string; expectedSha?: string }
  | { kind: 'local'; path: string }

/** 双作用域插件启用，与 mcp 和 skill 使用的约定一致（见
 *  packages/core/src/skills/settings.ts）：
 *
 *    'user'     →  ~/.x-code/settings.json
 *    'project'  →  <cwd>/.x-code/settings.local.json  （已 gitignore）
 *
 *  `'project'` 读取 `.local.json` 文件是从 skills 继承的小命名别扭——它是
 *  针对单个仓库的 per-user 覆盖，不是团队共享文件。日后可在此联合类型不变
 *  的前提下另加一个团队共享（需提交）的作用域。 */
export type PluginScope = 'user' | 'project'

// ── Manifest（作者编写的契约） ───────────────────────────────

export interface PluginAuthor {
  name?: string
  email?: string
  url?: string
}

/** 单个由用户填写的配置项（API key、base URL 等）。当 `sensitive: true` 时，
 *  值存放在系统 keyring 而非 settings.json。schema 与 Claude Code 一致，
 *  让同一插件无需作者另写配置块即可在任一 CLI 工作。 */
export interface UserConfigItem {
  key: string
  type: 'string' | 'number' | 'boolean'
  sensitive?: boolean
  prompt?: string
  required?: boolean
  default?: string | number | boolean
  description?: string
}

/** 内联 hook 配置（hooks 文件路径的替代）。这里只是宽松形状——完整校验在
 *  packages/core/src/hooks/config-schema.ts，这样仅涉及 hooks 的改动不会
 *  渗透进插件层。 */
export type InlineHookConfig = Record<string, unknown>

/** 内联 mcpServers 记录（路径字符串的替代）。与 ~/.x-code/config.json 里
 *  `mcpServers` 的形状一致——由既有 mcp config-schema 校验，不在这里重复。 */
export type InlineMcpServers = Record<string, unknown>

/** 从磁盘解析出的插件 manifest。所有路径都按原样存储——按插件根解析发生在
 *  [[loader]]。源 JSON 中的未知字段被静默剥除（zod 默认），让带我们不懂
 *  字段的较新 Claude Code manifest 仍能干净加载。 */
export interface PluginManifest {
  /** Schema 版本。缺省时默认 "1"。只有对 manifest 契约做破坏性变更时我们才
   *  提升它；旧插件只要字段能通过校验仍可加载。 */
  schemaVersion: string
  name: string
  version: string
  description?: string
  author?: PluginAuthor
  keywords?: string[]
  homepage?: string
  license?: string

  // ── 贡献（全部可选，全部相对插件根） ─────────
  /** 指向 skills 目录的路径，每个都采用 `<name>/SKILL.md` 形式（与
   *  `~/.x-code/skills/` 布局相同）。或单个文件路径。 */
  skills?: string
  /** 指向 sub-agent `.md` 文件目录的路径（与 `~/.x-code/agents/` 布局
   *  相同）。 */
  agents?: string
  /** 指向 slash 命令 `.md` 文件目录的路径。 */
  commands?: string
  /** 要么是带 `{ mcpServers: { ... } }` 的 JSON 文件路径，要么是内联
   *  `mcpServers` 记录。内联形式与 ~/.x-code/config.json 使用的形状一致。 */
  mcpServers?: string | InlineMcpServers
  /** 要么是 hooks.json 的路径，要么是内联 hook 配置。 */
  hooks?: string | InlineHookConfig

  // ── 作者可见、用户安装时填写的配置 ───────────
  userConfig?: UserConfigItem[]

  // ── 插件间依赖与运行时兼容性 ────────────────────────────
  /** 以 `name@marketplace` ID 表示的依赖。裸 `name` 解析到与依赖它的插件
   *  相同的市场。 */
  dependencies?: string[]
  engines?: { 'x-code'?: string }
}

// ── 已加载插件（registry 运行时持有的） ──────────────────

/** 我们加载的是哪个 manifest 文件。`'gemini'` 永不出现——Gemini 扩展按设计
 *  在安装时就被拒绝（见 plugin-marketplace-design.md §3.4），该值仅用于错误
 *  报告，表示“这看起来是 Gemini 扩展，我们不支持”。 */
export type ManifestFormat = 'native' | 'claude' | 'bare' | 'gemini'

export interface LoadedPlugin {
  /** 组合 id `name@marketplace`。对从本地路径安装（即仓库内自研）的插件，
   *  `marketplace` 为 `"local"`。 */
  id: string
  manifest: PluginManifest
  /** 插件根目录的绝对路径。 */
  rootDir: string
  /** 我们加载的 manifest 文件的绝对路径。 */
  manifestPath: string
  manifestFormat: ManifestFormat
  /** 该插件最初来自哪里。仅当插件被手动放进缓存而无元数据这种罕见情况时才
   *  为 `undefined`。 */
  source: PluginSource | undefined
  /** 该插件所属的市场名。对从本地路径安装 / 仓库内自研的插件为 `"local"`。 */
  marketplace: string
  scope: PluginScope
  /** 合并所有作用域之后的有效启用状态。 */
  enabled: boolean
}

/** 一条非致命加载错误——由 loader 收集，经 `/plugin doctor` 呈现。单个坏
 *  插件绝不至于让 CLI 崩溃。 */
export interface PluginLoadError {
  /** 若进展到足以知晓则为 `name@marketplace`。 */
  id?: string
  /** 触发错误的文件系统路径，即使没有解析出任何 manifest。 */
  path: string
  message: string
}

// ── 市场（索引 / 目录格式） ────────────────────────────

/** 市场内的单个插件条目。`source` 告诉安装器从哪里获取该插件。 */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  /** 市场策展人声称的“已审查”。我们在 UI 中呈现它，但绝不基于它授予额外
   *  信任——安装授权仍会执行。 */
  verified?: boolean
  source: PluginSource
  /** 钉住的版本（若有）。否则安装器从获取的 manifest 读取版本。 */
  version?: string
  homepage?: string
  keywords?: string[]
}

export interface Marketplace {
  schemaVersion: string
  /** 该市场的用户可见规范身份——用户输入的订阅别名（如
   *  `anthropic-marketplace`）。存储路径、安装 id（`<plugin>@<name>`）和查找
   *  都以它为键。 */
  name: string
  /** 市场在其 `marketplace.json` 里自声明的 `name`（如
   *  `claude-plugins-official`）。保留它是为了让 `info` 能在上游自称与订阅
   *  别名不同时向用户展示。绝不作为查找身份使用。 */
  upstreamName?: string
  displayName?: string
  description?: string
  owner?: { name?: string; url?: string }
  plugins: MarketplaceEntry[]
}

/** `~/.x-code/plugins/known_marketplaces.json` 中的一条——用户订阅的一个
 *  市场。`source` 字符串可以是 git URL（`github:owner/repo`、`https://...`）
 *  或指向 marketplace.json 的直接 HTTPS URL。 */
export interface KnownMarketplace {
  name: string
  source: string
  /** 设在内置条目上（如默认的 `anthropic-marketplace`）。保留名只接受其规范
   *  来源——见 [[marketplace]] 中的 RESERVED_MARKETPLACE_NAMES。 */
  reservedName?: boolean
  /** 保留名预期的 GitHub 组织。安装器会拒绝任何把保留名指向别处的注册尝试。 */
  officialSource?: string
}

export interface KnownMarketplaces {
  marketplaces: KnownMarketplace[]
  /** 为 true 时，插件只能从 `marketplaces` 列表中的市场安装。默认关闭；
   *  企业管理员会打开它。 */
  strictKnownMarketplaces?: boolean
  /** 无论用户设置如何都被强制禁用的插件 ID（`name@marketplace`）。管理员
   *  式的屏蔽列表。 */
  blockedPlugins?: string[]
}

// ── 已安装插件注册表（~/.x-code/plugins/installed_plugins.json） ─

/** 已安装注册表中的一条——我们为每个缓存安装保留的记账，让更新 / 卸载 /
 *  作用域变更无需重读每个 manifest 即可工作。 */
export interface InstalledPluginRecord {
  id: string
  name: string
  marketplace: string
  version: string
  source: PluginSource
  installedAt: string
  /** 哪个作用域的 settings.json 触发了安装（在哪里记录启用）。默认是 user
   *  作用域。 */
  installScope: PluginScope
}

export interface InstalledPlugins {
  schemaVersion: string
  plugins: InstalledPluginRecord[]
}
