import { truncateToolResult } from '../tools/index.js'
import { reportProgress } from '../tools/progress.js'
import type { BackgroundInfoItem } from '../types/index.js'
import { debugLog, isAbortError } from '../utils.js'
import { markExpectedCacheMiss } from './cache-stats.js'
import { toolErrorFromUnknown, toolErrorString } from './messages.js'
import { runSubAgent } from './sub-agents/runner.js'
import type { PushToolResult, ToolHandler, ToolHandlerContext } from './tool-handler-context.js'
import { runToolSearch } from './tool-search/resolve.js'

/** 构建绕过标准写入/shell 管线的自包含处理器。 */
function backgroundElapsed(ms: number | undefined): string {
  if (ms === undefined) return ''
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function isActiveBackgroundStatus(status: string): boolean {
  return ['starting', 'running', 'terminating', 'finalizing'].includes(status)
}

/** 合并本 runtime 的 shell、子代理任务和（桌面端提供的）其他窗口快照。 */
async function collectBackgroundInfo(context: ToolHandlerContext): Promise<BackgroundInfoItem[]> {
  const items: BackgroundInfoItem[] = []
  const now = Date.now()
  for (const session of context.state.shellSessions.list()) {
    items.push({
      id: session.shellId,
      kind: 'shell',
      status: session.status,
      description: session.command,
      ...(session.startedAt !== undefined
        ? { elapsedMs: Math.max(0, (session.exitedAt ?? now) - session.startedAt) }
        : {}),
      outputTail: session.recentOutput,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.failure ? { resultText: session.failure.message } : {}),
    })
  }
  for (const task of context.options.backgroundTaskRegistry?.list() ?? []) {
    items.push({
      id: task.id,
      kind: 'agent',
      status: task.status,
      description: `${task.agentName}: ${task.description}`,
      elapsedMs: Math.max(0, (task.endedAt ?? now) - task.startedAt),
      ...(task.turnCount !== undefined ? { turnCount: task.turnCount } : {}),
      ...(task.toolCallCount !== undefined ? { toolCallCount: task.toolCallCount } : {}),
      ...(task.resultText ? { resultText: task.resultText } : {}),
      ...(task.error ? { resultText: task.error } : {}),
    })
  }
  try {
    const shared = (await context.options.backgroundInfoProvider?.list()) ?? []
    for (const item of shared) {
      if (!items.some((local) => local.id === item.id)) items.push({ ...item, shared: true })
    }
  } catch (error) {
    debugLog('background-info-provider-failed', String(error))
  }
  return items
}

function formatBackgroundItem(item: BackgroundInfoItem): string {
  const elapsed = backgroundElapsed(item.elapsedMs)
  const counts = [
    item.turnCount !== undefined ? `${item.turnCount} turns` : '',
    item.toolCallCount !== undefined ? `${item.toolCallCount} tools` : '',
  ]
    .filter(Boolean)
    .join(', ')
  return `- ${item.id} [${item.kind}] ${item.status} · ${item.description}${elapsed ? ` · ${elapsed}` : ''}${
    counts ? ` · ${counts}` : ''
  }${item.shared ? ' · from another window' : ''}`
}

function formatBackgroundGet(item: BackgroundInfoItem): string {
  const lines = [
    `id: ${item.id}`,
    `kind: ${item.kind}`,
    `status: ${item.status}`,
    `description: ${item.description}`,
    ...(item.elapsedMs !== undefined ? [`elapsed: ${backgroundElapsed(item.elapsedMs)}`] : []),
    ...(item.exitCode !== undefined ? [`exitCode: ${item.exitCode}`] : []),
    ...(item.turnCount !== undefined ? [`turns: ${item.turnCount}`] : []),
    ...(item.toolCallCount !== undefined ? [`tools: ${item.toolCallCount}`] : []),
    ...(item.shared ? ['source: another window (snapshot)'] : []),
  ]
  const tail = item.resultText ?? item.outputTail
  if (tail) lines.push(`output tail:\n${tail.slice(-2_000)}`)
  return lines.join('\n')
}

function outputTail(item: BackgroundInfoItem, maxChars: number): string {
  const text = item.resultText ?? item.outputTail ?? ''
  if (!text) {
    return item.status === 'running' ? '(no output yet; task is still running)' : '(no output)'
  }
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询 shell 会话状态；不消费输出，也不影响 shellOutput 的读取游标。 */
async function waitForShell(
  context: ToolHandlerContext,
  shellId: string,
  timeoutMs: number,
): Promise<BackgroundInfoItem | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const session = context.state.shellSessions.list().find((entry) => entry.shellId === shellId)
    if (!session) return null
    if (!isActiveBackgroundStatus(session.status)) {
      return {
        id: session.shellId,
        kind: 'shell',
        status: session.status,
        description: session.command,
        ...(session.startedAt !== undefined
          ? { elapsedMs: Math.max(0, (session.exitedAt ?? Date.now()) - session.startedAt) }
          : {}),
        outputTail: session.recentOutput,
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      }
    }
    if (Date.now() >= deadline || context.options.abortSignal?.aborted) break
    await sleep(250)
  }
  const session = context.state.shellSessions.list().find((entry) => entry.shellId === shellId)
  if (!session) return null
  return {
    id: session.shellId,
    kind: 'shell',
    status: session.status,
    description: session.command,
    ...(session.startedAt !== undefined
      ? { elapsedMs: Math.max(0, (session.exitedAt ?? Date.now()) - session.startedAt) }
      : {}),
    outputTail: session.recentOutput,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
  }
}

export function createBuiltInToolHandlers(pushToolResult: PushToolResult): Record<string, ToolHandler> {
  const handleAskUser = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, callbacks } = context
    const question = input.question as string
    const options = input.options as { label: string; description: string }[]
    const answer = await callbacks.onAskUser(question, options)
    pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
  }

  const handleTask = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks, parentModel } = context
    const agentName = input.subagent_type as string
    const description = input.description as string
    const taskPrompt = input.prompt as string

    reportProgress(toolCallId, `Task: ${description} (${agentName})`)
    const registry = options.backgroundTaskRegistry
    if (input.background === true && registry) {
      const { task, signal } = registry.start({
        toolCallId,
        agentName,
        description,
        parentSignal: options.abortSignal,
      })
      callbacks.onBackgroundTaskEvent?.({ kind: 'start', task })
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        `Background task started: ${task.id} (${agentName} — ${description}). It runs independently; progress appears in the background task panel. Do not wait for it.`,
      )
      const childOptions: typeof options = { ...options, abortSignal: signal }
      void runSubAgent(
        {
          parentState: state,
          parentOptions: childOptions,
          callbacks,
          toolCallId,
          agentName,
          description,
          prompt: taskPrompt,
          knowledgeContext: state.knowledgeContext ?? '',
          isGitRepo: state.isGitRepo ?? false,
        },
        parentModel,
        context.runSubAgentLoop,
      )
        .then((result) => {
          const finished = registry.complete(task.id, {
            status: result.aborted ? 'aborted' : 'completed',
            resultText: result.resultText,
            tokenUsage: result.tokenUsage,
            turnCount: result.turnCount,
            toolCallCount: result.toolCallCount,
          })
          if (finished) callbacks.onBackgroundTaskEvent?.({ kind: 'end', task: finished })
        })
        .catch((error: unknown) => {
          const finished = registry.complete(task.id, {
            status: signal.aborted ? 'aborted' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
          if (finished) callbacks.onBackgroundTaskEvent?.({ kind: 'end', task: finished })
        })
      return
    }
    const result = await runSubAgent(
      {
        parentState: state,
        parentOptions: options,
        callbacks,
        toolCallId,
        agentName,
        description,
        prompt: taskPrompt,
        knowledgeContext: state.knowledgeContext ?? '',
        isGitRepo: state.isGitRepo ?? false,
      },
      parentModel,
      context.runSubAgentLoop,
    )

    const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      `${result.resultText}\n${statsLine}`,
      result.cleanupFailed === true,
    )
  }

  const handleBackgroundList = async (context: ToolHandlerContext): Promise<void> => {
    const { toolCallId, toolName, state, callbacks } = context
    const items = await collectBackgroundInfo(context)
    const text =
      items.length === 0
        ? 'No background shells or background sub-agent tasks.'
        : [
            `Background tasks (${items.length}):`,
            ...items.map(formatBackgroundItem),
            '',
            'Use backgroundGet or backgroundOutput with an id for details.',
          ].join('\n')
    pushToolResult(state, callbacks, toolCallId, toolName, text)
  }

  const handleBackgroundGet = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, callbacks } = context
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
    const items = await collectBackgroundInfo(context)
    const item = items.find((entry) => entry.id === taskId)
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      item ? formatBackgroundGet(item) : `No background task with id "${taskId}".`,
      !item,
    )
  }

  const handleBackgroundOutput = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks } = context
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
    const block = input.block === true
    const timeoutMs = Math.min(300_000, Math.max(0, Number(input.timeoutMs ?? 30_000)))
    const maxChars = Math.min(20_000, Math.max(100, Number(input.maxChars ?? 4_000)))
    let items = await collectBackgroundInfo(context)
    let item = items.find((entry) => entry.id === taskId)
    if (!item) {
      pushToolResult(state, callbacks, toolCallId, toolName, `No background task with id "${taskId}".`, true)
      return
    }
    if (block && isActiveBackgroundStatus(item.status)) {
      if (item.kind === 'shell' && !item.shared) {
        const waited = await waitForShell(context, taskId, timeoutMs)
        if (waited) item = waited
      } else if (item.kind === 'agent' && !item.shared) {
        await options.backgroundTaskRegistry?.waitFor(taskId, timeoutMs, options.abortSignal)
        items = await collectBackgroundInfo(context)
        item = items.find((entry) => entry.id === taskId) ?? item
      } else {
        return pushToolResult(
          state,
          callbacks,
          toolCallId,
          toolName,
          `${formatBackgroundGet(item)}\n\n(this task belongs to another window; only its latest published snapshot is available, so block:true cannot wait for live completion)`,
        )
      }
    }
    const statusLine = `${item.id} [${item.kind}] ${item.status} · ${item.description}${
      item.elapsedMs !== undefined ? ` · ${backgroundElapsed(item.elapsedMs)}` : ''
    }`
    const suffix =
      block && isActiveBackgroundStatus(item.status) ? `\n(task is still running after ${timeoutMs}ms)` : ''
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      `${statusLine}${item.shared ? ' · from another window (snapshot)' : ''}\n${outputTail(item, maxChars)}${suffix}`,
    )
  }

  const handleListMcpResources = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks } = context
    const registry = options.mcpRegistry
    if (!registry) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
      return
    }
    const filter = (input.server as string | undefined)?.trim() || undefined
    const items = registry.listResources().filter((resource) => !filter || resource.serverName === filter)
    if (items.length === 0) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
      )
      return
    }
    const lines = items.map((resource) => {
      const mime = resource.mimeType ? ` (${resource.mimeType})` : ''
      const description = resource.description ? `\n    ${resource.description}` : ''
      return `${resource.uri}\t[${resource.serverName}] ${resource.name}${mime}${description}`
    })
    pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
  }

  const handleReadMcpResource = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks } = context
    const registry = options.mcpRegistry
    if (!registry) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
      return
    }
    const uri = (input.uri as string | undefined) ?? ''
    if (!uri) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
      return
    }
    const client = registry.resourceServer(uri)
    if (!client) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
        true,
      )
      return
    }
    reportProgress(toolCallId, `Reading ${uri}`)
    try {
      const result = await client.readResource(uri, options.abortSignal)
      pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
    } catch (error) {
      if (isAbortError(error, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(error), true)
    }
  }

  const handleToolSearch = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, callbacks } = context
    const catalog = state.deferredCatalog ?? []
    const query = (input.query as string | undefined)?.trim() ?? ''
    if (!query) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString('toolSearch requires a non-empty query.'),
        true,
      )
      return
    }
    const requested = Number(input.max_results)
    const maxResults = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.floor(requested))) : 5
    const pendingServers = context.options.mcpRegistry
      ?.serverStatus()
      .filter((server) => server.status.kind === 'connecting')
      .map((server) => server.name)
    const result = runToolSearch(query, maxResults, catalog, pendingServers)
    debugLog(
      'tool-search',
      `queryBytes=${Buffer.byteLength(query, 'utf8')} max=${maxResults} catalog=${catalog.length} → [${result.activated.join(', ')}]`,
    )

    let added = false
    let anyAlreadyActive = false
    for (const name of result.activated) {
      if (state.activatedTools.has(name)) {
        anyAlreadyActive = true
      } else {
        state.activatedTools.add(name)
        added = true
      }
    }
    if (added) markExpectedCacheMiss(state, 'tool-activation')

    const text =
      !added && anyAlreadyActive
        ? `Already loaded — call ${result.activated.join(', ')} directly now. No need to search again.`
        : result.text
    pushToolResult(state, callbacks, toolCallId, toolName, text)
  }

  const handleListAgents = async (context: ToolHandlerContext): Promise<void> => {
    const { options, state, callbacks, toolCallId, toolName } = context
    if (!options.peerService?.enabled) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Peer messaging is disabled'), true)
      return
    }
    try {
      const peers = await options.peerService.listAgents(options.abortSignal)
      pushToolResult(state, callbacks, toolCallId, toolName, JSON.stringify({ agents: peers }))
    } catch (error) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(error), true)
    }
  }

  const handleSendMessage = async (context: ToolHandlerContext): Promise<void> => {
    const { options, state, callbacks, toolCallId, toolName } = context
    if (!options.peerService?.enabled || !context.preparedPeerSend) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString('Peer message was not safely prepared'),
        true,
      )
      return
    }
    const result = await options.peerService.sendPrepared(context.preparedPeerSend, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, JSON.stringify(result), !result.success)
  }

  return {
    askUser: handleAskUser,
    task: handleTask,
    backgroundList: handleBackgroundList,
    backgroundGet: handleBackgroundGet,
    backgroundOutput: handleBackgroundOutput,
    listMcpResources: handleListMcpResources,
    readMcpResource: handleReadMcpResource,
    toolSearch: handleToolSearch,
    listAgents: handleListAgents,
    sendMessage: handleSendMessage,
  }
}
