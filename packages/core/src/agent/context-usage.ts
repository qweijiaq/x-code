// @x-code-cli/core — 上下文构成拆解
//
// 提供商只会报告一次请求的「总」输入 token 数——没有任何一家
// 把它拆成「多少是系统提示词 vs 对话」。因此 /usage 的构成展示
// 在本地估算每个类别（与 context-window.ts 相同的字节/token 比例），
// 然后校准拆分比例，使各部分之和恰好等于 API 报告的真实数字。
//
// 类别映射（对应 Cursor 的 Context Usage 面板）：
//   - system:        基础系统提示词 + plan 模式覆盖层
//   - tools:         请求中发送的内置工具 JSON schema
//   - rules:         知识上下文（用户 AGENTS.md、记忆 profile、
//                    项目 AGENTS.md 链、AGENTS.local.md）
//   - skills:        `## Available Skills` 块
//   - mcp:           `## MCP Tools` / `## Deferred Tools` 块，加上
//                    MCP / 动态激活工具的 schema
//   - subagents:     task 工具的描述（内嵌 agent 列表）
//   - summary:       `[Previous conversation summary]` 压缩消息
//   - conversation:  消息历史中的其余一切
import type { ModelMessage } from 'ai'

import { toSystemPromptEntries } from '../mcp/tool-bridge.js'
import type { AgentOptions } from '../types/index.js'
import { estimateMessageTokenCount, estimateTextTokenCount } from './context-window.js'
import type { LoopState } from './loop-state.js'
import { buildTools } from './loop.js'
import { formatDeferredCapabilities, formatMcpCapabilities, formatSkillCapabilities } from './system-prompt.js'
import { estimateToolDefinitionTokens } from './tool-schema.js'
import { DIRECT_TOOL_TOKEN_BUDGET, composeTurnTools } from './tool-search/catalog.js'

export type ContextCategoryKey =
  | 'system'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'mcp'
  | 'subagents'
  | 'summary'
  | 'conversation'

export interface ContextCategoryEstimate {
  key: ContextCategoryKey
  label: string
  /** 基于字节的原始估算，尚未校准到真实 API 总数。 */
  estimatedTokens: number
}

export interface ContextBreakdown {
  /** 按展示顺序排列的非零类别（对应 Cursor 的面板顺序）。 */
  categories: ContextCategoryEstimate[]
  /** 不重叠的初始化子部分，用于诊断提示词增长。 */
  details?: ContextDetailEstimate[]
  warnings?: string[]
  estimatedTotal: number
}

export interface ContextDetailEstimate {
  label: string
  estimatedTokens: number
}

export interface CalibratedContextCategory extends ContextCategoryEstimate {
  /** 取整到整数，并调整使总和等于 `realTotal`。 */
  tokens: number
}

export interface ContextBreakdownInput {
  /** 完整的字节稳定系统提示词（`state.systemPromptCache`）。 */
  systemPrompt: string
  /** 嵌入在系统提示词末尾的知识上下文。 */
  knowledgeContext?: string
  /** 重新计算的 `## Available Skills` 块（可能只是安装提示）。 */
  skillBlock?: string
  /** 重新计算的 `## MCP Tools` + `## Deferred Tools` 块（可能为 ''）。 */
  mcpDeferredBlock?: string
  messages: ModelMessage[]
  /** 下一次请求的有效工具映射（基础 + 已激活）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>
  /** MCP 支撑（或动态激活）的工具名，计入 mcp 类别而非 tools。 */
  mcpToolNames?: ReadonlySet<string>
  /** 完整 catalog 和已激活集合让 /usage 能区分「现在发送的 schema」
   *  和「仅名字的 deferred 元数据」。 */
  deferredTools?: readonly { name: string; source: 'builtin' | 'mcp' }[]
  activatedToolNames?: ReadonlySet<string>
}

// 必须与 compression.ts 的私有常量字节一致——估算器依赖
// 相同的前缀来检测压缩消息。
const SUMMARY_PREFIX = '[Previous conversation summary]\n'

const CATEGORY_LABELS: Record<ContextCategoryKey, string> = {
  system: 'System prompt',
  tools: 'Tool definitions',
  rules: 'Rules',
  skills: 'Skills',
  mcp: 'MCP & dynamic tools',
  subagents: 'Subagent definitions',
  summary: 'Summarized conversation',
  conversation: 'Conversation',
}

function removeOnce(text: string, fragment: string | undefined): string {
  if (!fragment) return text
  const index = text.indexOf(fragment)
  return index < 0 ? text : text.slice(0, index) + text.slice(index + fragment.length)
}

function markdownSectionDetails(text: string, headingLevel: 2 | 3, labelPrefix: string): ContextDetailEstimate[] {
  if (!text) return []
  const marker = '#'.repeat(headingLevel) + ' '
  const lines = text.split('\n')
  const sections: Array<{ label: string; lines: string[] }> = []
  let current = { label: `${labelPrefix} · Preamble`, lines: [] as string[] }
  for (const line of lines) {
    if (line.startsWith(marker) && !line.startsWith(marker + '#')) {
      if (current.lines.some((item) => item.trim())) sections.push(current)
      current = { label: `${labelPrefix} · ${line.slice(marker.length).trim()}`, lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.lines.some((item) => item.trim())) sections.push(current)
  return sections
    .map((section) => ({
      label: section.label,
      estimatedTokens: estimateTextTokenCount(section.lines.join('\n')),
    }))
    .filter((section) => section.estimatedTokens > 0)
}

/** 估算下一次请求上下文的逐类别 token 拆分。当系统提示词
 *  尚未构建时（从未向模型发送过任何内容）返回空拆解。 */
export function estimateContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const systemTotal = estimateTextTokenCount(input.systemPrompt)
  const skillTokens = input.skillBlock ? estimateTextTokenCount(input.skillBlock) : 0
  const mcpBlockTokens = input.mcpDeferredBlock ? estimateTextTokenCount(input.mcpDeferredBlock) : 0
  const rulesTokens = input.knowledgeContext ? estimateTextTokenCount(input.knowledgeContext) : 0
  // 系统提示词是严格拼接：基础（含替换进来的 capability 块）
  // + '\n\n' + knowledge + plan 覆盖层。减去已知子块就能精确
  // 隔离出基础提示词 + 覆盖层。
  const systemTokens = Math.max(0, systemTotal - skillTokens - mcpBlockTokens - rulesTokens)

  let toolsTokens = 0
  let subagentsTokens = 0
  let directSubagentTokens = 0
  let mcpToolTokens = 0
  let directBuiltinTokens = 0
  let activatedBuiltinTokens = 0
  let directMcpTokens = 0
  let activatedMcpTokens = 0
  for (const [name, def] of Object.entries(input.tools)) {
    const tokens = estimateToolDefinitionTokens(name, def)
    if (name === 'task') {
      subagentsTokens += tokens
      if (!input.activatedToolNames?.has(name)) directSubagentTokens += tokens
    } else if (input.mcpToolNames?.has(name)) {
      mcpToolTokens += tokens
      if (input.activatedToolNames?.has(name)) activatedMcpTokens += tokens
      else directMcpTokens += tokens
    } else {
      toolsTokens += tokens
      if (input.activatedToolNames?.has(name)) activatedBuiltinTokens += tokens
      else directBuiltinTokens += tokens
    }
  }

  let summaryTokens = 0
  let conversationTokens = 0
  const first = input.messages[0]
  const hasSummary =
    first?.role === 'user' && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX)
  for (let i = 0; i < input.messages.length; i++) {
    const messageTokens = estimateMessageTokenCount(input.messages[i]!)
    if (i === 0 && hasSummary) summaryTokens += messageTokens
    else conversationTokens += messageTokens
  }

  const rawEntries: ContextCategoryEstimate[] = [
    { key: 'system', label: CATEGORY_LABELS.system, estimatedTokens: systemTokens },
    { key: 'tools', label: CATEGORY_LABELS.tools, estimatedTokens: toolsTokens },
    { key: 'rules', label: CATEGORY_LABELS.rules, estimatedTokens: rulesTokens },
    { key: 'skills', label: CATEGORY_LABELS.skills, estimatedTokens: skillTokens },
    { key: 'mcp', label: CATEGORY_LABELS.mcp, estimatedTokens: mcpBlockTokens + mcpToolTokens },
    { key: 'subagents', label: CATEGORY_LABELS.subagents, estimatedTokens: subagentsTokens },
    { key: 'summary', label: CATEGORY_LABELS.summary, estimatedTokens: summaryTokens },
    { key: 'conversation', label: CATEGORY_LABELS.conversation, estimatedTokens: conversationTokens },
  ]

  const categories = rawEntries.filter((entry) => entry.estimatedTokens > 0)
  let systemBase = input.systemPrompt
  systemBase = removeOnce(systemBase, input.skillBlock)
  systemBase = removeOnce(systemBase, input.mcpDeferredBlock)
  systemBase = removeOnce(systemBase, input.knowledgeContext)
  const details: ContextDetailEstimate[] = [
    ...markdownSectionDetails(systemBase, 2, 'Prompt'),
    ...markdownSectionDetails(input.knowledgeContext ?? '', 3, 'Rules'),
    ...(skillTokens > 0 ? [{ label: 'Skills · Catalog and guidance', estimatedTokens: skillTokens }] : []),
    ...(mcpBlockTokens > 0
      ? [
          {
            label: input.deferredTools
              ? `Deferred · ${input.deferredTools.length} name-only entries`
              : 'MCP · Capability catalog',
            estimatedTokens: mcpBlockTokens,
          },
        ]
      : []),
    ...(directBuiltinTokens > 0 ? [{ label: 'Tools · Direct built-ins', estimatedTokens: directBuiltinTokens }] : []),
    ...(activatedBuiltinTokens > 0
      ? [{ label: 'Tools · Activated built-ins', estimatedTokens: activatedBuiltinTokens }]
      : []),
    ...(directMcpTokens > 0 ? [{ label: 'Tools · Direct MCP', estimatedTokens: directMcpTokens }] : []),
    ...(activatedMcpTokens > 0 ? [{ label: 'Tools · Activated MCP', estimatedTokens: activatedMcpTokens }] : []),
    ...(subagentsTokens > 0 ? [{ label: 'Tools · Sub-agent registry', estimatedTokens: subagentsTokens }] : []),
  ]
  const warnings: string[] = []
  const knowledgeBytes = Buffer.byteLength(input.knowledgeContext ?? '', 'utf8')
  if (knowledgeBytes > 32 * 1024) {
    warnings.push(
      `Merged rule files use ${(knowledgeBytes / 1024).toFixed(1)} KiB before tokenization (recommended review threshold: 32 KiB).`,
    )
  }
  const initialDirectToolTokens = directBuiltinTokens + directMcpTokens + directSubagentTokens
  if (initialDirectToolTokens > DIRECT_TOOL_TOKEN_BUDGET) {
    warnings.push(
      `Initial direct tool schemas exceed the ${DIRECT_TOOL_TOKEN_BUDGET.toLocaleString('en-US')}-token target (${initialDirectToolTokens.toLocaleString('en-US')}); mandatory or alwaysLoad tools may be responsible.`,
    )
  }

  return {
    categories,
    details,
    warnings,
    estimatedTotal: categories.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
  }
}

/** 缩放原始估算，使它们的和等于提供商报告的真实输入 token 数
 *  （`realTotal`），吸收 tokenizer 漂移和提供商侧的提示词转换。
 *  取整误差落到最大类别上，使展示的各部分始终相加等于 `realTotal`。 */
export function calibrateContextBreakdown(breakdown: ContextBreakdown, realTotal: number): CalibratedContextCategory[] {
  if (breakdown.estimatedTotal <= 0 || realTotal <= 0) return []
  const scale = realTotal / breakdown.estimatedTotal
  const categories = breakdown.categories.map((category) => ({
    ...category,
    tokens: Math.round(category.estimatedTokens * scale),
  }))
  const sum = categories.reduce((total, category) => total + category.tokens, 0)
  const drift = realTotal - sum
  if (drift !== 0 && categories.length > 0) {
    const largest = categories.reduce((a, b) => (b.tokens > a.tokens ? b : a))
    largest.tokens = Math.max(0, largest.tokens + drift)
  }
  return categories
}

/** 从活跃会话状态组装估算器输入，镜像 agentLoop 在下一轮实际
 *  发送的内容：缓存的系统提示词、相同的 capability 块（用相同
 *  的 formatter 重新计算）、以及有效工具映射（基础 + 已激活的
 *  deferred 工具）。在第一轮之前、系统提示词尚未构建时返回 null。 */
export function buildContextBreakdownInput(options: AgentOptions, state: LoopState): ContextBreakdownInput | null {
  if (!state.systemPromptCache) return null

  // buildTools 是 loop 的会话启动例程，会重新填充 state.deferredCatalog
  // （确定性的——内容与现有 catalog 相同，但是一个新的引用）。
  // 这是只读的报告路径：快照并恢复，这样活跃会话状态绝不会被它改动。
  const catalogBefore = state.deferredCatalog
  const manualExecutorsBefore = new Map(state.manualToolExecutors)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let baseTools: Record<string, any>
  try {
    baseTools = buildTools(options, state)
  } finally {
    state.deferredCatalog = catalogBefore
    state.manualToolExecutors.clear()
    for (const [name, execute] of manualExecutorsBefore) state.manualToolExecutors.set(name, execute)
  }
  const tools = composeTurnTools(baseTools, state.deferredCatalog, state.activatedTools, state.permissionMode)

  // 优先使用构建提示词时快照下来的块（loop.ts）：会话中途的
  // /skill 或 /mcp 刷新会改变 registry 现在会产生的内容，
  // 那将不再与 systemPromptCache 里嵌入的内容一致。对于从未经过
  // 提示词构建的状态（测试、下一轮之前的已恢复会话），回退到重新计算。
  const blocks = state.systemPromptBlocks
  const skillBlock =
    blocks?.skill ??
    formatSkillCapabilities(state.permissionMode === 'plan' ? undefined : options.skillRegistry?.list())
  const activeMcpRegistry = options.mcpRegistry?.hasModelCapabilities() ? options.mcpRegistry : undefined
  const mcpDeferredBlock =
    blocks?.mcpDeferred ??
    (state.permissionMode === 'plan'
      ? ''
      : state.deferredCatalog
        ? formatDeferredCapabilities(
            state.deferredCatalog.map((entry) => ({
              name: entry.name,
              serverName: entry.serverName,
              source: entry.source,
            })),
          )
        : formatMcpCapabilities(activeMcpRegistry ? toSystemPromptEntries(activeMcpRegistry.list()) : undefined))

  // MCP 支撑的工具：alwaysLoad 条目直接在 buildTools 里注册，
  // 其余经 deferred catalog 到达。registry 列表也覆盖了
  // 无延迟回退（极小 catalog）的情况，此时每个 MCP 工具都被完整注入。
  const mcpToolNames = new Set<string>()
  for (const entry of state.deferredCatalog ?? []) {
    if (entry.source === 'mcp') mcpToolNames.add(entry.name)
  }
  for (const entry of options.mcpRegistry?.list() ?? []) {
    mcpToolNames.add(entry.callableName)
  }

  return {
    systemPrompt: state.systemPromptCache,
    knowledgeContext: blocks?.knowledge ?? state.knowledgeContext ?? '',
    skillBlock,
    mcpDeferredBlock,
    messages: state.messages,
    tools,
    mcpToolNames,
    deferredTools: state.deferredCatalog?.map((entry) => ({ name: entry.name, source: entry.source })),
    activatedToolNames: state.activatedTools,
  }
}
