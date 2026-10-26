// @x-code-cli/core — 子代理运行器
//
// 以隔离上下文把子代理作为嵌套 agentLoop 执行。父代理只收到最终文本结果；
// 中间的工具调用和消息都留在子循环内部。
import type { LanguageModel, UserContent } from 'ai'

import { loadUserConfig, resolveModelId } from '../../config/index.js'
import type { HookBus } from '../../hooks/bus.js'
import type { HookEvent } from '../../hooks/types.js'
import { activeMemoryRecallAttachments } from '../../knowledge/memory/recall-state.js'
import { tokenizeMemoryText } from '../../knowledge/memory/search-index.js'
import { capabilitiesOf, modelSupportsVision } from '../../providers/capabilities.js'
import type { ShellSessionController } from '../../tools/shell-session/types.js'
import type { AgentCallbacks, AgentOptions, ExecutionAuthority, TokenUsage } from '../../types/index.js'
import { debugLog, errorMessage, isAbortError } from '../../utils.js'
import { withBrowserOperation } from '../browser/operation-lock.js'
import { type BrowserMcp, PLAYWRIGHT_MCP_PACKAGE, getBrowserMcp } from '../browser/registry.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import { appendUsage } from '../session-store.js'
import { buildSubAgentSystemPrompt } from '../system-prompt.js'
import { accumulateChildUsage } from '../usage.js'
import { pickVisionProvider } from '../vision-fallback.js'
import { BROWSER_TREE_ONLY_NOTE, BROWSER_VISION_ADDENDUM, BROWSER_VISION_CAPTION_ADDENDUM } from './built-in.js'
import type { SubAgentRegistry } from './registry.js'
import type { SubAgentDefinition } from './types.js'

/** 触发 SubagentStart / SubagentStop hook。尽力而为——父代理一旦决定委派，子代理调用
 *  就是强制性的，因此 hook 失败和中止绝不能向上冒泡。 */
function emitSubAgentHook(
  bus: HookBus | undefined,
  event: HookEvent & { name: 'SubagentStart' | 'SubagentStop' },
  signal: AbortSignal | undefined,
): void {
  if (!bus?.has(event.name)) return
  void bus.emit(event, { signal }).catch((err) => debugLog(`agent.hook-${event.name.toLowerCase()}-error`, String(err)))
}

export interface RunSubAgentArgs {
  parentState: LoopState
  parentOptions: AgentOptions
  callbacks: AgentCallbacks
  toolCallId: string
  agentName: string
  description: string
  prompt: string
  knowledgeContext: string
  isGitRepo: boolean
  authority?: ExecutionAuthority
}

export interface RunSubAgentResult {
  resultText: string
  tokenUsage: TokenUsage
  turnCount: number
  toolCallCount: number
  durationMs: number
  aborted: boolean
  cleanupFailed?: boolean
}

export type SubAgentLoopRunner = (
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
) => Promise<{ state: LoopState; turnCount: number }>

export interface SubAgentShellCleanupFailure {
  shellIds: string[]
  message: string
}

const SUBAGENT_CLEANUP_RETRY_BUDGET = { gracefulMs: 250, forceMs: 750, confirmMs: 250 } as const

export async function cleanupSubAgentShellSessions(
  parent: ShellSessionController,
  child: ShellSessionController,
  agentName: string,
): Promise<SubAgentShellCleanupFailure | undefined> {
  let shellIds: string[] = []
  let cleanupError: unknown
  try {
    let cleanup = await child.dispose('subagent-finished')
    if (cleanup.results.some((result) => !result.treeConfirmedExited)) {
      cleanup = await child.dispose('subagent-finished', SUBAGENT_CLEANUP_RETRY_BUDGET)
    }
    shellIds = cleanup.results.filter((result) => !result.treeConfirmedExited).map((result) => result.shellId)
  } catch (error) {
    cleanupError = error
    shellIds = child
      .list()
      .filter((session) => !session.treeConfirmedExited)
      .map((session) => session.shellId)
  }

  if (shellIds.length === 0 && cleanupError === undefined) return undefined
  const adopted = parent.adoptResidualManager(child, shellIds)
  const visibleIds = adopted.length > 0 ? adopted : shellIds
  const detail = cleanupError instanceof Error ? ` Cleanup error: ${cleanupError.message}` : ''
  const idText = visibleIds.length > 0 ? visibleIds.join(', ') : '(unknown)'
  const message = `managed shell cleanup could not be confirmed. Residual shell IDs: ${idText}. Use /ps to inspect and /stop to retry.${detail}`
  debugLog('sub-agent.shell-cleanup-failed', `${agentName}: ${message}`)
  return { shellIds: visibleIds, message }
}

/** 从消息数组中提取最后一段 assistant 文本（跳过 tool-call 部分）。 */
function extractFinalText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const textParts = (content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      const joined = textParts.join('').trim()
      if (joined) return joined
    }
  }
  return ''
}

function resolveSubModel(
  agentDef: SubAgentDefinition,
  parentOptions: AgentOptions,
  parentModel: LanguageModel,
): LanguageModel {
  if (!agentDef.model) return parentModel
  if (!parentOptions.modelRegistry) return parentModel

  const resolvedId = resolveModelId(agentDef.model)
  if (!resolvedId) return parentModel

  try {
    return parentOptions.modelRegistry.languageModel(resolvedId as `${string}:${string}`)
  } catch {
    debugLog('sub-agent.model', `Failed to resolve model "${agentDef.model}", falling back to parent model`)
    return parentModel
  }
}

export function buildSubAgentToolFilter(agentDef: SubAgentDefinition, parentPermissionMode: string) {
  const deny = [...(agentDef.disallowedTools ?? []), 'task']

  // 在 plan 模式下，对全部子代理——而不只是 general-purpose——拒绝写工具。plan 模式的
  // 只读不变量无论运行哪个代理都必须成立；shell 也包含在内，因为它能写文件或执行
  // 破坏性命令。
  if (parentPermissionMode === 'plan') {
    for (const t of ['writeFile', 'edit', 'shell']) {
      if (!deny.includes(t)) deny.push(t)
    }
  }

  // `'*'` 是表示“所有工具”的通配符——与 Claude Code 对内置/general-purpose 代理的
  // `tools: ['*']` 语义一致。传入 `undefined`，让 `buildTools` 跳过 allowlist 过滤、
  // 只应用显式 deny 列表。否则 `['*']` 会被当成字面工具名，所有真实工具都会被过滤掉。
  const allow = agentDef.tools?.includes('*') ? undefined : agentDef.tools

  return {
    allow,
    deny,
  }
}

/** 解析子代理要用的模型。需要父级实际的 LanguageModel 实例，因为要把它传给 agentLoop。 */
export async function runSubAgent(
  args: RunSubAgentArgs,
  parentModel: LanguageModel,
  runLoop?: SubAgentLoopRunner,
): Promise<RunSubAgentResult> {
  const authority = args.authority ?? args.parentState.executionAuthority
  if ((authority.peerTainted || authority.source === 'peer') && !args.parentOptions?.trustMode) {
    return {
      resultText: '[Sub-agent dispatch denied for peer-influenced context]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }
  if (args.agentName !== 'browser') return runSubAgentUnlocked(args, parentModel, runLoop)

  const startTime = Date.now()
  try {
    // Playwright MCP 只有一个可变的当前 Page。为整个浏览器代理运行持有事务锁，
    // 而不只是单次 MCP 调用，这样视觉检查或第二个浏览器任务就无法悄无声息地切换其标签页。
    return await withBrowserOperation(args.parentOptions.abortSignal, () =>
      runSubAgentUnlocked(args, parentModel, runLoop),
    )
  } catch (err) {
    if (!isAbortError(err, args.parentOptions.abortSignal)) throw err
    return {
      resultText: '[Browser agent interrupted before startup]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: Date.now() - startTime,
      aborted: true,
    }
  }
}

async function runSubAgentUnlocked(
  args: RunSubAgentArgs,
  parentModel: LanguageModel,
  runLoop: SubAgentLoopRunner | undefined,
): Promise<RunSubAgentResult> {
  const {
    parentState,
    parentOptions,
    callbacks,
    toolCallId,
    agentName,
    description,
    prompt,
    knowledgeContext,
    isGitRepo,
  } = args
  const startTime = Date.now()
  const authority = args.authority ?? parentState.executionAuthority

  const registry = parentOptions.subAgentRegistry as SubAgentRegistry | undefined
  if (!registry) {
    return {
      resultText: '[Sub-agent system not initialized]',
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }

  const agentDef = registry.get(agentName)
  if (!agentDef) {
    const available = registry.names().join(', ')
    return {
      resultText: `[Sub-agent '${agentName}' not found. Available: ${available}]`,
      tokenUsage: zeroUsage(),
      turnCount: 0,
      toolCallCount: 0,
      durationMs: 0,
      aborted: false,
    }
  }
  if (!runLoop) throw new Error('Sub-agent loop runner not configured')

  const subModel = resolveSubModel(agentDef, parentOptions, parentModel)
  const subModelId = agentDef.model ? (resolveModelId(agentDef.model) ?? parentOptions.modelId) : parentOptions.modelId

  // `browser` 代理拿到的是一份私有 mcp registry（@playwright/mcp server），替代父级的
  // registry，这样它的浏览器工具就永远不会进入主循环的工具面或任何其他代理。惰性连接；
  // 如果浏览器起不来，就在宣布启动之前用一个有用提示退出，而不是运行一个没有浏览器的
  // "browser" 代理。
  //
  // server 启动的是稳定的能力超集，而该代理只有在自身模型能看图、或配置了 caption 模型
  // 能解读截图时，才收到视觉指导/工具。这样既避免了切换模型时重启 Chrome，又不会让纯树形
  // 代理依赖一个不可用的视觉 provider。
  let browserMcp: BrowserMcp | undefined
  let browserVision = false
  if (agentDef.name === 'browser') {
    try {
      browserMcp = await getBrowserMcp(parentOptions.abortSignal)
    } catch (err) {
      if (isAbortError(err, parentOptions.abortSignal)) {
        return {
          resultText: '[Browser agent interrupted before startup]',
          tokenUsage: zeroUsage(),
          turnCount: 0,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
          aborted: true,
        }
      }
      throw err
    }
    if (!browserMcp.ok) {
      return {
        resultText: browserUnavailableMessage(browserMcp.error),
        tokenUsage: zeroUsage(),
        turnCount: 0,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
        aborted: false,
      }
    }
    const configAllowsVision = loadUserConfig().browser?.vision !== false
    const canInterpretScreenshot = modelSupportsVision(subModelId) || pickVisionProvider() !== null
    browserVision = configAllowsVision && browserMcp.vision && canInterpretScreenshot
    debugLog('browser.vision', browserVision ? `enabled for ${subModelId}` : 'tree-only')
  }

  callbacks.onSubAgentEvent?.({
    kind: 'start',
    toolCallId,
    agentName,
    description,
    prompt,
  })

  // 插件 hook：SubagentStart——在代理定义解析之后、嵌套 agentLoop 运行之前触发。尽力而为。
  emitSubAgentHook(
    parentOptions.hookBus,
    {
      name: 'SubagentStart',
      session: { cwd: parentState.projectCwd, modelId: parentOptions.modelId },
      agent: { name: agentName, description, prompt },
    },
    parentOptions.abortSignal,
  )

  // 浏览器提示词与模型相关。纯文本模型根本不能截图（有显式的“不要截图”说明）。
  // 视觉模型会拿到截图指导。原生 tool-result provider，以及把媒体作为后续用户消息
  // 重新附上的 Chat Completions provider，都能暴露原始图像；只有不支持的传输方式才需要
  // caption 模式的追加文案。
  const browserPromptSuffix =
    agentDef.name !== 'browser'
      ? ''
      : !browserVision
        ? BROWSER_TREE_ONLY_NOTE
        : capabilitiesOf(subModelId).toolImageTransport !== 'unsupported'
          ? BROWSER_VISION_ADDENDUM
          : BROWSER_VISION_CAPTION_ADDENDUM
  const taskTokens = new Set(tokenizeMemoryText(prompt))
  const recalledMemory = activeMemoryRecallAttachments(parentState)
    .flatMap((attachment) => attachment.topics)
    .filter((topic) => tokenizeMemoryText(topic.renderedContent).some((token) => taskTokens.has(token)))
    .map((topic) => topic.renderedContent)
    .join('\n\n')
  const subSystemPrompt = buildSubAgentSystemPrompt({
    agentPrompt: agentDef.prompt + browserPromptSuffix,
    knowledgeContext: recalledMemory
      ? `${knowledgeContext}\n\n### Recalled user memory (low-authority historical data)\n${recalledMemory}`
      : knowledgeContext,
    isGitRepo,
  })

  const subState = createLoopState('default', {
    projectCwd: parentState.projectCwd,
    agentRole: 'sub-agent',
  })
  subState.executionAuthority = structuredClone(authority)
  subState.systemPromptCache = subSystemPrompt

  const toolFilter = buildSubAgentToolFilter(agentDef, parentState.permissionMode)
  if (browserMcp && !browserVision) {
    for (const entry of browserMcp.registry.list()) {
      if (entry.rawName === 'browser_take_screenshot' || entry.rawName.startsWith('browser_mouse_')) {
        toolFilter.deny.push(entry.callableName)
      }
    }
  }

  const subOptions: AgentOptions = {
    ...parentOptions,
    executionAuthority: structuredClone(authority),
    modelId: subModelId,
    maxTurns: agentDef.maxTurns,
    toolFilter,
    shellRestrictions: agentDef.shellRestrictions,
    shellReadOnlyOnly: agentDef.shellReadOnlyOnly,
    abortSignal: parentOptions.abortSignal,
    permissionMode: 'default',
    printMode: false,
    // 子代理不再拥有自己的子代理注册表——禁止递归
    subAgentRegistry: undefined,
    memoryService: undefined,
    // 浏览器代理会跨多轮反复快照/截图；上下文中只保留各自最新的一份，
    // 让被取代的旧结果停止重复计费。
    collapseStaleToolResults: agentDef.name === 'browser' ? ['browser_snapshot', 'browser_take_screenshot'] : undefined,
    // 浏览器代理换入其私有 registry（在上面已连接）；其他代理都通过展开继承父级的 MCP 面。
    ...(browserMcp ? { mcpRegistry: browserMcp.registry, mcpPermissionStore: browserMcp.permissions } : {}),
  }

  // 构造子代理回调：通过 onSubAgentEvent 把事件转发到父级 UI，
  // 但不直接把子状态混入父状态。
  const subCallbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      callbacks.onSubAgentEvent?.({ kind: 'text-delta', toolCallId, delta })
    },
    onToolCall: (_subToolCallId, subToolName, subInput) => {
      callbacks.onSubAgentEvent?.({
        kind: 'tool-call',
        toolCallId,
        subToolName,
        subInput,
      })
      // 同时转发到父级的 onToolProgress，好让实时指示器更新
      callbacks.onToolProgress(toolCallId, `${subToolName}: ${previewInput(subInput)}`)
    },
    onToolProgress: (_subToolCallId, message) => {
      callbacks.onToolProgress(toolCallId, message)
    },
    onToolResult: (subToolCallId, result, isError) => {
      const preview = result.length > 200 ? result.slice(0, 197) + '...' : result
      callbacks.onSubAgentEvent?.({
        kind: 'tool-result',
        toolCallId,
        subToolName: subToolCallId,
        resultPreview: preview,
        durationMs: 0,
        isError: isError ?? false,
      })
    },
    onFileEdit: callbacks.onFileEdit,
    onAskPermission: callbacks.onAskPermission,
    onAskUser: callbacks.onAskUser,
    onPlanApprovalRequest: callbacks.onPlanApprovalRequest,
    onPlanModeChange: () => {},
    onTodosUpdate: () => {},
    onShellOutput: callbacks.onShellOutput,
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onStreamRetry: callbacks.onStreamRetry,
    onError: (error) => {
      debugLog('sub-agent.error', `${agentName}: ${error.message}`)
    },
  }

  let completedResult: RunSubAgentResult | undefined
  let completionFinalText: string | undefined
  let completionOutcome: 'completed' | 'aborted' | 'failed' = 'failed'
  try {
    const { state: finalSubState, turnCount } = await runLoop(prompt, subModel, subOptions, subCallbacks, subState)

    const finalText = extractFinalText(finalSubState.messages)
    const toolUseCount = countToolCalls(finalSubState.messages)

    accumulateChildUsage(parentState, finalSubState, subModelId)
    callbacks.onUsageUpdate(parentState.tokenUsage)
    void appendUsage(parentState, parentOptions.modelId)

    const durationMs = Date.now() - startTime
    const resultText = finalText || '[Sub-agent completed without producing a final response]'

    completionFinalText = resultText
    completionOutcome = 'completed'

    if (turnCount >= agentDef.maxTurns && !finalText) {
      // 这里 finalText 必定为空（!finalText 分支），且自 line 246 的调用以来 messages 数组
      // 未被改动，因此这条路径上的 partial-output 值只可能是 'none'。
      return (completedResult = {
        resultText: `[Sub-agent reached max turns (${agentDef.maxTurns}) without finishing. Partial output: none]`,
        tokenUsage: finalSubState.tokenUsage,
        turnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: false,
      })
    }

    return (completedResult = {
      resultText: `<task_result>\n${resultText}\n</task_result>`,
      tokenUsage: finalSubState.tokenUsage,
      turnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    })
  } catch (err) {
    const durationMs = Date.now() - startTime

    // agentLoop 会在内部捕获 abort/error 并带 outcome 标记正常返回，因此这个 catch 只在
    // 有东西越过那些守卫抛出时触发（通常是 setup 阶段代码：知识加载、slug 生成等）。
    // 到那时子代理还没真正执行过任何轮次，所以报 0 是诚实的。
    const fallbackTurnCount = 0

    if (isAbortError(err, parentOptions.abortSignal)) {
      const partial = extractFinalText(subState.messages)
      const text = partial
        ? `[Sub-agent interrupted by user]\n\nPartial output:\n${partial}`
        : '[Sub-agent interrupted by user]'
      const toolUseCount = countToolCalls(subState.messages)

      completionFinalText = text
      completionOutcome = 'aborted'

      return (completedResult = {
        resultText: text,
        tokenUsage: subState.tokenUsage,
        turnCount: fallbackTurnCount,
        toolCallCount: toolUseCount,
        durationMs,
        aborted: true,
      })
    }

    const message = errorMessage(err)
    debugLog('sub-agent.crash', `${agentName}: ${message}`)
    const toolUseCount = countToolCalls(subState.messages)

    completionFinalText = `[Sub-agent failed: ${message}]`
    completionOutcome = 'failed'

    return (completedResult = {
      resultText: `[Sub-agent failed: ${message}]`,
      tokenUsage: subState.tokenUsage,
      turnCount: fallbackTurnCount,
      toolCallCount: toolUseCount,
      durationMs,
      aborted: false,
    })
  } finally {
    const cleanupFailure = await cleanupSubAgentShellSessions(
      parentState.shellSessions,
      subState.shellSessions,
      agentName,
    )
    if (cleanupFailure) {
      if (!completedResult) throw new Error(cleanupFailure.message)
      completedResult.cleanupFailed = true
      completedResult.resultText = `[Sub-agent failed: ${cleanupFailure.message}]\n\nPartial sub-agent outcome:\n${completedResult.resultText}`
      completionFinalText = completedResult.resultText
      completionOutcome = 'failed'
    }
    if (completedResult) {
      callbacks.onSubAgentEvent?.({
        kind: 'end',
        toolCallId,
        finalText: completionFinalText ?? completedResult.resultText,
        tokenUsage: completedResult.tokenUsage,
        turnCount: completedResult.turnCount,
        durationMs: completedResult.durationMs,
        aborted: completedResult.aborted,
      })
      const stopEvent = {
        name: 'SubagentStop' as const,
        session: { cwd: parentState.projectCwd, modelId: parentOptions.modelId },
        agent: { name: agentName, description },
        durationMs: completedResult.durationMs,
        outcome: completionOutcome,
        ...(completionOutcome === 'completed'
          ? {
              tokenUsage: {
                inputTokens: completedResult.tokenUsage.inputTokens,
                outputTokens: completedResult.tokenUsage.outputTokens,
                totalTokens: completedResult.tokenUsage.totalTokens,
              },
            }
          : {}),
      }
      emitSubAgentHook(parentOptions.hookBus, stopEvent, parentOptions.abortSignal)
    }
  }
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    currentContextTokens: 0,
  }
}

function countToolCalls(messages: LoopState['messages']): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part?.type === 'tool-call') count++
    }
  }
  return count
}

function previewInput(input: Record<string, unknown>): string {
  const val =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.query as string) ??
    (input.dirPath as string) ??
    ''
  return val.length > 80 ? val.slice(0, 77) + '...' : val
}

function browserUnavailableMessage(error: string | undefined): string {
  return (
    `[browser agent unavailable: ${error ?? 'could not start the browser'}.\n` +
    'Set "browser": { "enabled": true } in ~/.x-code/config.json, ensure Node can run ' +
    `\`npx -y ${PLAYWRIGHT_MCP_PACKAGE}\`, and that Google Chrome (or the configured browser) is installed.]`
  )
}
