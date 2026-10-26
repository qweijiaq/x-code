// @x-code-cli/core — toolSearch 的延迟工具目录
//
// 顶层代理过去会在 streamText 的 `tools` 数组里公布每一个 MCP 工具的完整 JSON Schema，
// 外加每个非核心内置工具。一旦连接了几个 MCP server，每次请求就是几万 token。Claude Code
// 和 Codex 都用同一招解决：保持核心工具已加载，把其余工具藏到单个 `toolSearch` 工具后面，
// 只在模型请求时才加载某个工具的真实 schema。
//
// 本模块构建延迟工具的“目录”——模型能通过 toolSearch 发现、但在被激活之前并不在请求工具
// 列表里的那些东西。每个条目携带：
//   - 面向模型的名称（callable 名称），
//   - 预计算的小写 `searchText` 草堆（名称 token + 描述 + MCP schema 属性名——与 Codex 的
//     BM25 文档同思路），
//   - 激活时拼接回来的 AI SDK 工具定义。
//
// 延迟只关乎顶层代理。子代理已经通过 toolFilter 运行一套精心挑选的小工具集，因此保持完整
// 注入——见 loop.ts 的 buildTools。
import { listMcpResources, readMcpResource } from '../../mcp/resources.js'
import { bridgeMcpTool, truncateDescription } from '../../mcp/tool-bridge.js'
import { toolRegistry } from '../../tools/index.js'
import { toolSearch } from '../../tools/tool-search.js'
import type { AgentOptions, PermissionMode } from '../../types/index.js'
import { estimateToolDefinitionTokens } from '../tool-schema.js'

// 文档工具集落地后从 10k 上调：23 个内置工具加上视觉检查工具刚好超过 10k，会悄悄地把每个
// 会话的 webSearch / webFetch / todoWrite 都延迟掉。一旦 MCP server 或更大的工具面把请求
// 顶上去，这个预算仍会延迟工具。
export const DIRECT_TOOL_TOKEN_BUDGET = 12_000

/** 被延迟的非核心内置工具（在 toolSearch 加载它们之前只有名称）。核心的编辑 / 搜索 / 执行
 *  工具（readFile、writeFile、edit、shell、grep、glob、listDir）加上 task / askUser /
 *  plan 模式控制保持直接加载——它们几乎每个任务都会用到，藏到一轮搜索往返之后，
 *  造成的损失远大于省下的几百 token。这些才是真正偶尔用到的。这复刻了 Claude Code，
 *  它把 WebSearch / WebFetch / TodoWrite（以及后台 shell 类 helper）标记为 shouldDefer，
 *  同时让 file / grep / exec 保持直接。小巧的 browserVisualCheck 组合保持直接，是因为
 *  延迟它会给常见的前端编辑后验证路径额外增加一整轮模型往返。 */
export const DEFERRED_BUILTIN_TOOLS = ['webSearch', 'webFetch', 'todoWrite'] as const

const STANDARD_DEFERRED_BUILTIN_TOOLS = ['task', 'webSearch', 'webFetch'] as const

const PLAN_MODE_TOOL_NAMES = new Set([
  'readFile',
  'glob',
  'grep',
  'listDir',
  'webSearch',
  'webFetch',
  'askUser',
  'writeFile',
  'edit',
  'exitPlanMode',
])

export type ToolProfile = 'full' | 'standard'

export function resolveEffectiveToolProfile(requested: ToolProfile | undefined): ToolProfile {
  return requested === 'standard' ? 'standard' : 'full'
}

export interface DeferredToolEntry {
  /** 面向模型的 callable 名称——目录键、模型通过 `select:` 传给 `toolSearch` 的名称，
   *  以及落到 activatedTools 里的键。 */
  name: string
  /** 简短的人类可读描述，显示在激活结果行。已截断。 */
  description: string
  /** 小写的搜索草堆：分词后的名称 + 描述 + （MCP 的）schema 属性名。
   *  由 search.ts 里的关键词打分器来匹配。 */
  searchText: string
  source: 'builtin' | 'mcp'
  /** 所属 MCP server（仅 mcp 来源）——在系统提示词列表里对目录分组。 */
  serverName?: string
  /** 当该条目被激活时，拼接进请求 `tools` map 的 AI SDK 工具定义。在这里构造一次，
   *  这样激活就是一次廉价的 map 插入。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function descriptionOf(def: any): string {
  const d = def?.description
  return typeof d === 'string' ? d : ''
}

/** 把工具名分词为可搜索的单词：`mcp__server__tool` 按 `__` / `_` 拆分，
 *  CamelCase 按边界拆分。小写、空格连接。 */
function nameTokens(name: string): string {
  const withoutPrefix = name.startsWith('mcp__') ? name.slice(5) : name
  return withoutPrefix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .toLowerCase()
}

/** 从原始 JSON Schema 收集属性名 + 嵌套描述，让打分器能把 "create issue title" 这类查询
 *  匹配到一个描述简略、但参数名为 `title` / `body` 的工具。递归有界——MCP schema 实际
 *  都很浅。 */
function collectSchemaText(schema: unknown, out: string[], depth = 0): void {
  if (!schema || typeof schema !== 'object' || depth > 4) return
  const s = schema as Record<string, unknown>
  if (typeof s.description === 'string') out.push(s.description)
  const props = s.properties
  if (props && typeof props === 'object') {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      out.push(key)
      collectSchemaText(val, out, depth + 1)
    }
  }
  if (s.items) collectSchemaText(s.items, out, depth + 1)
}

function builtinEntry(name: string, def: unknown): DeferredToolEntry {
  const raw = descriptionOf(def)
  const searchText = `${name} ${nameTokens(name)} ${raw}`.toLowerCase()
  return { name, description: truncateDescription(raw), searchText, source: 'builtin', def }
}

/** 为当前会话构建延迟工具目录。目录持有把初始直接工具面压到 DIRECT_TOOL_TOKEN_BUDGET
 *  以内所需的最低优先级候选。全部放得下时返回 []。
 *
 *  顺序稳定（内置工具在前，MCP 按 registry 顺序按 server 分组），因此系统提示词列表和任何
 *  缓存前缀都保持字节稳定。 */
export function buildDeferredCatalog(
  options: AgentOptions,
  availableTools: Record<string, unknown> = toolRegistry,
): DeferredToolEntry[] {
  const entries: DeferredToolEntry[] = []
  const profile = resolveEffectiveToolProfile(options.toolProfile)
  const deferredBuiltins = profile === 'standard' ? STANDARD_DEFERRED_BUILTIN_TOOLS : DEFERRED_BUILTIN_TOOLS

  for (const name of deferredBuiltins) {
    const def = availableTools[name]
    if (def) entries.push(builtinEntry(name, def))
  }

  if (options.mcpRegistry?.hasModelCapabilities()) {
    entries.push(builtinEntry('listMcpResources', listMcpResources))
    entries.push(builtinEntry('readMcpResource', readMcpResource))

    for (const e of options.mcpRegistry.list()) {
      // Gate 3：带 annotations.alwaysLoad 的 MCP 工具跳过延迟——server 作者声明该工具足够
      // 关键，要始终直接可用（例如每个任务都要用到的 RAG 搜索工具）。
      if (e.annotations?.alwaysLoad === true) continue

      const schemaText: string[] = []
      collectSchemaText(e.inputSchema, schemaText)
      // Gate 5：来自 annotations 的 searchHint 丰富搜索草堆。
      const hint = typeof e.annotations?.searchHint === 'string' ? (e.annotations.searchHint as string) : ''
      const searchText =
        `${e.callableName} ${nameTokens(e.callableName)} ${e.serverName} ${e.description} ${hint} ${schemaText.join(' ')}`.toLowerCase()
      entries.push({
        name: e.callableName,
        description: truncateDescription(e.description),
        searchText,
        source: 'mcp',
        serverName: e.serverName,
        def: bridgeMcpTool(e),
      })
    }
  }

  if (entries.length === 0) return []

  const candidateBuiltinNames = new Set(
    entries.filter((entry) => entry.source === 'builtin').map((entry) => entry.name),
  )
  let directTokens = Object.entries(availableTools).reduce(
    (sum, [name, def]) => (candidateBuiltinNames.has(name) ? sum : sum + estimateToolDefinitionTokens(name, def)),
    0,
  )
  for (const entry of options.mcpRegistry?.list() ?? []) {
    if (entry.annotations?.alwaysLoad === true) {
      directTokens += estimateToolDefinitionTokens(entry.callableName, bridgeMcpTool(entry))
    }
  }
  for (const entry of entries) directTokens += estimateToolDefinitionTokens(entry.name, entry.def)

  if (directTokens <= DIRECT_TOOL_TOKEN_BUDGET) return []

  directTokens += estimateToolDefinitionTokens('toolSearch', toolSearch)
  const deferred: DeferredToolEntry[] = []
  for (const entry of entries) {
    if (directTokens <= DIRECT_TOOL_TOKEN_BUDGET) break
    deferred.push(entry)
    directTokens -= estimateToolDefinitionTokens(entry.name, entry.def)
  }
  return deferred
}

/** 把每个已激活延迟工具的定义拼接进单轮的基础工具集。当没有任何激活时原样返回 `base`
 *  （同一引用），因此从不搜索的会话能保持稳定的工具前缀。已激活条目按插入顺序追加在
 *  稳定基础键之后，因此缓存的 tool-schema 前缀只在尾部变化。 */
export function composeTurnTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: Record<string, any>,
  catalog: readonly DeferredToolEntry[] | undefined,
  activated: ReadonlySet<string>,
  permissionMode?: PermissionMode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  let tools = base
  if (catalog && activated.size > 0) {
    const byName = new Map(catalog.map((e) => [e.name, e]))
    tools = { ...base }
    for (const name of activated) {
      const e = byName.get(name)
      if (e) tools[name] = e.def
    }
  }
  if (permissionMode === undefined) return tools
  if (tools === base) tools = { ...base }
  if (permissionMode === 'plan') {
    for (const entry of catalog ?? []) {
      if (PLAN_MODE_TOOL_NAMES.has(entry.name)) tools[entry.name] = entry.def
    }
    for (const name of Object.keys(tools)) {
      if (!PLAN_MODE_TOOL_NAMES.has(name)) delete tools[name]
    }
  } else {
    delete tools.exitPlanMode
  }
  return tools
}
