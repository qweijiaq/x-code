// @x-code-cli/cli — Agent 状态管理 hook
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  accumulateUsage,
  agentLoop,
  appendInterrupted,
  appendUsage,
  attributedModelId,
  buildContextBreakdownInput,
  buildUserContent,
  capabilitiesOf,
  captureSessionForkSnapshot,
  classifyApiError,
  clearPeerContext as clearCorePeerContext,
  cloneUsageBreakdown,
  compressTrackedMessagesWithUsage,
  createLoopState,
  createUsageBreakdown,
  debugLog,
  errorMessage,
  estimateContextBreakdown,
  extractFileReferences,
  flushPendingMessages,
  formatQueuedAgentInput,
  hydrateLoopState,
  loadPersistedRules,
  markBoundaryAndReflush,
  markExpectedCacheMiss,
  modelSupportsVision,
  normalizeLanguageModelUsage,
  scanCacheMisses,
  summarizePeerOrigins,
} from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentLoopResult,
  AgentOptions,
  AuthorityApproval,
  ContextBreakdown,
  DisplayMessage,
  ExecutionAuthority,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionDecision,
  PermissionMode,
  PublicPeer,
  SessionForkSnapshot,
  ShellSessionEvent,
  ShellSessionSummary,
  StreamRetryEvent,
  TerminateAllResult,
  TerminationBudget,
  TerminationReason,
} from '@x-code-cli/core'

import { cloneCacheMissSummary, initialAgentState } from './agent-state.js'
import { createGoalToolLifecycleCallbacks, createToolLifecycleCallbacks } from './agent-tool-lifecycle.js'
import { authorityApproval } from './authority-approval.js'
import { invalidateModelDependentState, invalidateToolSurfaceState } from './model-switch-state.js'
import { OTHER_OPTION } from './question-options.js'
import { ownerMayDrainQueuedInputs } from './queued-agent-inputs.js'
import {
  type ShellUiRuntime,
  createShellUiRuntime,
  flushCompletedShellWait,
  reduceShellSessionEvent,
} from './shell-session-ui.js'
import { createTurnCoordinator } from './turn-coordinator.js'
import type {
  AgentState,
  PendingAuthority,
  PendingPermission,
  PendingQuestion,
  SubmitAgentInput,
  SubmitOptions,
} from './types.js'
import { useAgentDisplayHelpers } from './use-agent-display-helpers.js'
import { modelMessagesToDisplay } from './use-agent-display.js'
import { useGoalController } from './use-goal-controller.js'
import { useInputQueue } from './use-input-queue.js'
import { useSessionController } from './use-session-controller.js'
import { extractLastAssistantText, useStreamBuffer } from './use-stream-buffer.js'

export type { ActiveToolCall, AgentState, QueuedMessage, RunGoalCommand } from './types.js'

function peerExecutionAuthority(peer: PublicPeer, messageId: string): ExecutionAuthority {
  return {
    source: 'peer',
    peerTainted: true,
    peerOrigins: summarizePeerOrigins([
      {
        instanceId: peer.address.slice('peer:'.length),
        nameAtReceipt: peer.name,
        messageId,
      },
    ]),
  }
}

export function useAgent(initialModel: LanguageModel, options: AgentOptions, initialSession?: LoadedSession | null) {
  // 如果我们以预加载会话（--continue）启动，就用它来播种初始 UI 状态，让消息在
  // 用户提交任何内容之前就出现在 scrollback 中。token 用量也会恢复，这样
  // /usage 能立即显示正确的总数。loopStateRef 在下方匹配的 useEffect 里
  // 水合——ref 不能在 useState 初始化器里设置，因为 useState 先于任何其他
  // hook 运行。
  const [state, setState] = useState<AgentState>({
    ...initialAgentState,
    modelId: options.modelId,
    permissionMode: options.permissionMode ?? 'default',
    messages: initialSession ? modelMessagesToDisplay(initialSession.messages) : initialAgentState.messages,
    usage: initialSession ? { ...initialSession.tokenUsage } : initialAgentState.usage,
    usageBreakdown: initialSession?.usageBreakdown
      ? cloneUsageBreakdown(initialSession.usageBreakdown)
      : createUsageBreakdown(),
    cacheMissSummary: cloneCacheMissSummary(
      initialSession?.cacheMissSummary ?? scanCacheMisses(initialSession?.providerTurns ?? []),
    ),
    stepStats: initialSession ? initialSession.stepStats.slice() : initialAgentState.stepStats,
    goalStatus: initialSession?.goal ? { ...initialSession.goal } : null,
    peerInfluenced: initialSession?.contextSecurity.peerInfluenceActive ?? false,
  })

  const modelRef = useRef<LanguageModel>(initialModel)
  const modelIdRef = useRef<string>(options.modelId)
  /** 为每次 submit 的 agentLoop 选项镜像 state.permissionMode。循环在开始时通过
   *  options.permissionMode 读取它；进入循环后，agent 的工具分派直接变更
   *  LoopState，我们再通过 onPlanModeChange 回调把它镜像回这里。 */
  const permissionModeRef = useRef<PermissionMode>(options.permissionMode ?? 'default')
  /** 为 abort() 回调镜像 `state.activeToolCalls.length`，它需要同步读取这个值，
   *  而不能依赖 React state 闭包（每次 state 变更都重新绑定回调会迫使
   *  ChatInput 在每次渲染时重新挂载它的按键处理器）。 */
  const activeToolCallsLenRef = useRef(0)
  // 镜像 /thinking 开关，这样 agent 循环读到的总是最新值——即便它在会话中途被
  // 修改，与 modelIdRef 是同一模式。初始值来自 CLI options（在启动时从
  // ~/.x-code/config.json 读取）。
  const thinkingRef = useRef<boolean>(options.thinking ?? false)
  const loopStateRef = useRef<LoopState | null>(null)
  const shellUiRuntimeRef = useRef<ShellUiRuntime | null>(null)
  const shellEventSubscriptionRef = useRef<{
    ownerSessionId: string
    managerInstanceId: string
    unsubscribe: () => void
  } | null>(null)
  /** `/fork` 在 agentLoop 活动期间使用的分离时间点状态。外层对象也是首个
   *  请求（还没有已完成上下文，`snapshot` 为 null）的哨兵。 */
  const activeForkBoundaryRef = useRef<{ snapshot: SessionForkSnapshot | null; error?: string } | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  /** 标识 `/compact` 所拥有的 controller。手动压缩复用共享的 loading/abort UI，
   *  但取消它时绝不能追加一条普通的中断对话消息，也不能变更 model-message
   *  历史。 */
  const manualCompressionControllerRef = useRef<AbortController | null>(null)
  /** 延迟的中断通知文本。由 abort() 设置，在 processToolCalls 完全排空后由
   *  submit() 的 post-agentLoop 路径消费。这避免了在 tool_results 仍在追加时
   *  把一条 user-role 消息推入 state.messages（那会破坏 assistant→tool 顺序）。 */
  const pendingAbortNoticeRef = useRef<string | null>(null)
  const turnCoordinatorRef = useRef(createTurnCoordinator())
  const initializedRef = useRef(false)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)
  const fileIngestSequenceRef = useRef(0)
  const planApprovalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAuthorityRef = useRef<PendingAuthority | null>(null)
  const authorityRequestSequenceRef = useRef(0)
  /** 以 toolCallId 为键的待处理工具调用。单个槽位无法在一个回合里并存多个
   *  并行工具调用——SDK 发出 tool-call A、tool-call B、tool-result A、
   *  tool-result B，所以共享槽位会被覆盖，后面的结果会落到 'unknown' 标签。 */
  const pendingToolsRef = useRef<Map<string, { toolName: string; input: Record<string, unknown>; startedAt: number }>>(
    new Map(),
  )
  /** 以 toolCallId 为键的编辑工具 diff 载荷。由 `onFileEdit` 填充（它在
   *  `onToolResult` 之前的工具执行阶段触发），并由 `onToolResult` 排空，把
   *  diff 附加到新的 DisplayToolCall 上。与 pendingToolsRef 分开键控，因为不是
   *  每个工具都产生 diff，我们也不想让一个默认空字段撑大待处理记录。 */
  const pendingEditDiffsRef = useRef<Map<string, import('@x-code-cli/core').EditDiffPayload>>(new Map())
  /** 与 `permissionQueue` 平行：`onAskPermission` promise 的 resolver。放在
   *  ref 里，这样 `abort()` 可以在 `controller.abort()` 之前同步拒绝每个排队的
   *  门控——否则核心循环会一直阻塞在第一个 shell 上，而 UI 仍显示过期的
   *  Yes/No。 */
  const permissionResolversRef = useRef<Array<(decision: PermissionDecision) => void>>([])
  const submitRef = useRef<SubmitAgentInput | null>(null)

  // 中途回合输入队列（用户 + peer 条目）——提取出的状态机。
  const {
    queuedMessagesRef,
    consumedPeerInboxKeysRef,
    queueSeqRef,
    queueMessage,
    popQueuedMessage,
    consumeQueuedInputs,
    dequeueFreshInput,
    restoreQueueToDraft,
  } = useInputQueue(setState)

  const scheduleIdleDrain = useCallback(() => {
    queueMicrotask(() => {
      if (turnCoordinatorRef.current.isOwned()) return
      const next = dequeueFreshInput()
      if (!next) return
      if (next.source === 'user') {
        void submitRef.current?.(next.content, { silent: true })
        return
      }
      const authority = peerExecutionAuthority(next.peer, next.messageId)
      void submitRef.current?.(formatQueuedAgentInput(next), {
        silent: true,
        owner: 'peer',
        authority,
        rawContent: true,
        ...(next.inboxKey ? { peerInboxKeys: [next.inboxKey] } : {}),
      })
    })
  }, [dequeueFreshInput])

  const dispatchShellSessionEvent = useCallback((event: ShellSessionEvent) => {
    const binding = shellEventSubscriptionRef.current
    if (
      !binding ||
      event.ownerSessionId !== binding.ownerSessionId ||
      event.managerInstanceId !== binding.managerInstanceId
    ) {
      return
    }
    const runtime = shellUiRuntimeRef.current
    if (!runtime) return
    const reduced = reduceShellSessionEvent(runtime, event)
    if (reduced.runtime === runtime && reduced.notices.length === 0) return
    shellUiRuntimeRef.current = reduced.runtime
    setState((previous) => ({
      ...previous,
      backgroundTerminals: reduced.runtime.backgroundTerminals,
      shellWaitStreak: reduced.runtime.shellWaitStreak,
      messages: reduced.notices.length > 0 ? [...previous.messages, ...reduced.notices] : previous.messages,
    }))
  }, [])

  const bindShellSessionEvents = useCallback(
    (loopState: LoopState) => {
      const managerInstanceId = loopState.shellSessions.managerInstanceId
      if (shellEventSubscriptionRef.current?.managerInstanceId === managerInstanceId) return
      shellEventSubscriptionRef.current?.unsubscribe()
      shellUiRuntimeRef.current = createShellUiRuntime(managerInstanceId)
      const unsubscribe = loopState.shellSessions.subscribe(dispatchShellSessionEvent, { replayCurrent: true })
      shellEventSubscriptionRef.current = {
        ownerSessionId: loopState.sessionId,
        managerInstanceId,
        unsubscribe,
      }
      setState((previous) => ({ ...previous, backgroundTerminals: [], shellWaitStreak: null }))
    },
    [dispatchShellSessionEvent],
  )

  const flushShellWaitUi = useCallback(() => {
    const runtime = shellUiRuntimeRef.current
    if (!runtime) return
    const reduced = flushCompletedShellWait(runtime)
    if (reduced.notices.length === 0) return
    shellUiRuntimeRef.current = reduced.runtime
    setState((previous) => ({
      ...previous,
      shellWaitStreak: reduced.runtime.shellWaitStreak,
      messages: [...previous.messages, ...reduced.notices],
    }))
  }, [])

  useEffect(() => {
    return () => {
      shellEventSubscriptionRef.current?.unsubscribe()
      shellEventSubscriptionRef.current = null
    }
  }, [])

  useEffect(() => {
    const service = options.peerService
    if (!service) return
    return turnCoordinatorRef.current.onChange((lease) => {
      const busyKind =
        lease?.owner === 'goal'
          ? 'goal'
          : lease && ['compact', 'resume', 'rewind', 'clear'].includes(lease.owner)
            ? 'maintenance'
            : 'interactive-turn'
      void service
        .updateLocalState(lease ? { status: 'busy', busyKind } : { status: 'idle' })
        .catch((error) => debugLog('peer.registration-state', String(error)))
    })
  }, [options.peerService])

  /** 向 `messages` 追加一条消息（由流缓冲使用）。 */
  const appendMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, msg] }))
  }, [])

  const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage)

  const consumeQueuedInputsInDisplayOrder = useCallback(() => {
    // 核心在 agentLoop 返回前排水排队输入。先提交前面的 assistant 尾部，
    // 这样 React 就不会把排队的用户行追加到它之前。
    flushBuffer()
    return consumeQueuedInputs()
  }, [consumeQueuedInputs, flushBuffer])

  const toolLifecycleCallbacks = useMemo(
    () =>
      createToolLifecycleCallbacks({
        setState,
        flushBuffer,
        pendingToolsRef,
        pendingEditDiffsRef,
      }),
    [flushBuffer],
  )

  const goalToolLifecycleCallbacks = useMemo(
    () =>
      createGoalToolLifecycleCallbacks({
        setState,
        flushBuffer,
        pendingToolsRef,
      }),
    [flushBuffer],
  )

  const handleTextDelta = useCallback(
    (delta: string) => {
      if (delta) {
        flushShellWaitUi()
        // 文本生成会结束任何进行中的读取链。第一条块已把状态恢复成 "Working"
        // 之后，避免为后续块再做状态更新。
        setState((previous) => (previous.bufferingReads ? { ...previous, bufferingReads: false } : previous))
      }
      appendTextDelta(delta)
    },
    [appendTextDelta, flushShellWaitUi],
  )

  const handleStreamRetry = useCallback((event: StreamRetryEvent | null) => {
    setState((previous) => ({
      ...previous,
      reconnectLabel: event ? `Reconnecting... ${event.attempt}/${event.maxAttempts}` : null,
    }))
  }, [])

  // 保持 ref 与 state 同步，这样 abort() 可以在不引入 state 依赖（那会每次
  // 渲染都重新绑定 prop）的情况下，在 `[Request interrupted by user]` 和
  // `... for tool use` 之间做出选择。
  useEffect(() => {
    activeToolCallsLenRef.current = state.activeToolCalls.length
  }, [state.activeToolCalls.length])

  // 在首次渲染时从预加载会话水合 LoopState ref。ref 不能在 useState（它先运行）
  // 里初始化，所以我们在这里做。仅一次——由下游的 initializedRef 守护。
  // useEffect 顺序：这在挂载之后、但在 App 中 initialPrompt submit effect 之前
  // 运行，所以当用户在恢复的会话里发送第一条消息时，agentLoop 已经看到
  // `existingState` 并继续同一段对话。
  useEffect(() => {
    if (initialSession && !loopStateRef.current) {
      loopStateRef.current = hydrateLoopState(initialSession, options.permissionMode ?? 'default', process.cwd())
      bindShellSessionEvents(loopStateRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 接好异步 MCP 启动回调：当后台连接完成时，使系统提示词缓存失效，这样下一个
  // 回合就能用新可用的 MCP 条目重建工具。
  useEffect(() => {
    options.onMcpReady = () => {
      invalidateToolSurfaceState(loopStateRef.current)
    }
    return () => {
      options.onMcpReady = undefined
    }
  }, [options])

  /** 初始化进程级服务（仅一次）。 */
  const initialize = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true
    await options.memoryService?.initialize(process.cwd())
    loadPersistedRules(process.cwd())
  }, [options.memoryService])

  const currentAuthority = useCallback((source: 'user' | 'peer' = 'user'): ExecutionAuthority => {
    const security = loopStateRef.current?.contextSecurity
    const peerTainted =
      source === 'peer' || security?.peerInfluenceActive === true || security?.integrityFailure === true
    return {
      source,
      peerTainted,
      ...(peerTainted && security?.peerOrigins ? { peerOrigins: security.peerOrigins } : {}),
    }
  }, [])

  const applyModelRequestPreflight = useCallback(
    async (currentModelId: string): Promise<LanguageModel> => {
      const preflight = await options.beforeModelRequest?.(currentModelId)
      if (preflight?.model || preflight?.modelId) {
        if (!preflight.model || !preflight.modelId)
          throw new Error('Model request preflight returned an incomplete model switch.')
        if (!preflight.onApplied) {
          modelRef.current = preflight.model
          modelIdRef.current = preflight.modelId
          options.modelId = preflight.modelId
          invalidateModelDependentState(loopStateRef.current)
          options.memoryService?.setActiveModelId(preflight.modelId)
          setState((prev) => ({ ...prev, modelId: preflight.modelId! }))
        }
      }
      preflight?.onApplied?.()
      if (preflight?.notice) {
        appendMessage({
          id: `auth-change-${Date.now()}`,
          role: 'assistant',
          content: preflight.notice,
          timestamp: Date.now(),
          kind: 'command-result',
        })
      }
      if (preflight?.blockedMessage) throw new Error(preflight.blockedMessage)
      return preflight?.model ?? modelRef.current
    },
    [appendMessage, options],
  )

  /** 提交一条用户消息。
   *
   *  `silent: true` 会跳过把文本追加到 UI scrollback，但仍把它喂给模型
   *  （agentLoop 会自己把用户回合推入 loopState.messages）。用于 `/init` 这类
   *  注入长篇作者侧提示词的斜杠命令——用户已经从 echoCommand 看到 `/init`，
   *  再把完整提示词正文倒进 scrollback 就是噪音。spinner / abort 信号 /
   *  会话保存仍照常触发。 */
  const submit = useCallback(
    async (text: string, submitOptions?: SubmitOptions): Promise<AgentLoopResult | null> => {
      const authority = submitOptions?.authority ?? currentAuthority()
      const existingLease = submitOptions?.lease
      const lease = existingLease ?? turnCoordinatorRef.current.tryAcquire(submitOptions?.owner ?? 'user', authority)
      if (!lease) {
        if ((submitOptions?.owner ?? 'user') === 'user') queueMessage(text)
        return null
      }
      const ownsLease = existingLease === undefined
      consumedPeerInboxKeysRef.current.clear()
      const boundaryState = loopStateRef.current
      try {
        activeForkBoundaryRef.current = {
          snapshot: boundaryState ? captureSessionForkSnapshot(boundaryState) : null,
        }
      } catch (error) {
        activeForkBoundaryRef.current = {
          snapshot: null,
          error: errorMessage(error),
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: true,
        shellOutput: '',
        error: null,
        reconnectLabel: null,
        messages: submitOptions?.silent
          ? prev.messages
          : [...prev.messages, { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }],
      }))

      const controller = new AbortController()
      abortControllerRef.current = controller
      const externalSignal = submitOptions?.signal
      const abortFromExternal = () => controller.abort()
      if (externalSignal?.aborted) controller.abort()
      else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })

      // 追踪这次 submit 的流是否产生过任何文本，这样下面的安全网提取就不会重复
      // 已经冲刷过的文本。
      let sawTextDelta = false

      const callbacks: AgentCallbacks = {
        onTextDelta: (delta) => {
          if (delta) sawTextDelta = true
          handleTextDelta(delta)
        },
        ...toolLifecycleCallbacks,
        onAskPermission: (toolCall) => {
          return new Promise<PermissionDecision>((resolve) => {
            permissionResolversRef.current.push(resolve)
            // MCP 查找：registry 保存着我们用于对话框标题和 always-allow 标签的
            // 去混淆后的 server + 原始工具名对。内置工具不在 registry 里，
            // 会让 `mcp` 保持 undefined——ChatInput 为它们回退到现有的逐工具渲染。
            const mcpEntry = options.mcpRegistry?.get(toolCall.toolName)
            const entry: PendingPermission = {
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
              mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
            }
            setState((prev) => ({ ...prev, permissionQueue: [...prev.permissionQueue, entry] }))
          })
        },
        onAskAuthority: (request) => {
          return new Promise<AuthorityApproval>((resolve) => {
            const pending: PendingAuthority = { ...request, requestId: authorityRequestSequenceRef.current++, resolve }
            pendingAuthorityRef.current = pending
            void options.peerService?.updateLocalState({ status: 'waiting' }).catch(() => {})
            setState((prev) => ({ ...prev, authorityRequest: pending }))
          })
        },
        onAskUser: (question, opts) => {
          return new Promise<string>((resolve) => {
            // 在 plan 模式下，追加两个模型在其工具输入里看不到的 UI 侧元选项。
            // 镜像 Claude Code 的 QuestionView footer（`Chat about this` /
            // `Skip interview and plan immediately`）——模型通过系统提示词覆盖层
            // 了解到它们，并在它们作为答案返回时按字面标签识别它们。
            //
            // 尾部的 OTHER_OPTION 最后追加，这样无论 plan 模式 footer 是否存在，
            // 它都始终是最后一行。
            const planMeta =
              permissionModeRef.current === 'plan'
                ? [
                    {
                      label: 'Chat about this',
                      description: 'Reply in conversation without picking an option above.',
                    },
                    {
                      label: 'Skip interview and plan immediately',
                      description: 'Stop the questions — produce the final plan now with everything gathered so far.',
                    },
                  ]
                : []
            const augmented = [...opts, ...planMeta, OTHER_OPTION]
            const pendingQuestion: PendingQuestion = {
              question,
              options: augmented,
              resolve,
              abortAnswer: '[Request interrupted by user]',
              layout: 'compact-vertical',
            }
            pendingQuestionRef.current = pendingQuestion
            setState((prev) => ({ ...prev, pendingQuestion }))
          })
        },
        onPlanApprovalRequest: (planText) => {
          // 两步 UX：把计划正文作为一条普通 assistant 消息提交到 scrollback
          // （完整的 markdown 渲染——标题、列表项、代码块都正确呈现），然后弹出
          // 一个紧凑的 Yes/No 对话框。把 50 行计划正文塞进 SelectOptions 的
          // `question` 字段则会撑爆框架、把 Yes/No 挤出屏幕，并产生一墙带 `?`
          // 前缀、用户无法导航的原始 markdown。磁盘上的计划文件仍是权威副本——
          // 这份 scrollback 渲染只用于行内审阅。
          appendMessage({
            id: `plan-approval-${Date.now()}`,
            role: 'assistant',
            content: planText,
            timestamp: Date.now(),
          })
          return new Promise<boolean>((resolve) => {
            const finish = (approved: boolean) => {
              if (planApprovalTimerRef.current) {
                clearTimeout(planApprovalTimerRef.current)
                planApprovalTimerRef.current = null
              }
              resolve(approved)
            }
            const pendingQuestion: PendingQuestion = {
              question: 'Approve the plan above?',
              options: [
                { label: 'Yes', description: 'Exit plan mode and start implementing (writes auto-approved).' },
                { label: 'No', description: 'Stay in plan mode and let the model revise.' },
              ],
              resolve: (answer) => finish(answer === 'Yes'),
              abortAnswer: 'No',
            }
            pendingQuestionRef.current = pendingQuestion
            // 延迟打开对话框，让计划文本提交先绘制出来——避免同时 commit+grow
            // 而让几何引擎困惑。
            planApprovalTimerRef.current = setTimeout(() => {
              planApprovalTimerRef.current = null
              if (pendingQuestionRef.current !== pendingQuestion) return
              setState((prev) => ({ ...prev, pendingQuestion }))
            }, 0)
          })
        },
        onPlanModeChange: (mode) => {
          permissionModeRef.current = mode
          setState((prev) => ({ ...prev, permissionMode: mode }))
          // 模式是会话级作用域（与 Claude Code 一致）——不持久化到用户配置。
          // 每个新会话都以 'default' 开始，除非传入了 `--plan`。
        },
        onTodosUpdate: (todos) => {
          // 直接镜像——核心 agent 已验证形状并应用了自动清除语义；我们只是存储
          // 它给我们的内容，好让 ChatInput 重新渲染 todo 面板。
          setState((prev) => ({ ...prev, todos }))
        },
        onUsageUpdate: (usage) => {
          setState((prev) => ({
            ...prev,
            usage,
            usageBreakdown: loopStateRef.current
              ? cloneUsageBreakdown(loopStateRef.current.usageBreakdown)
              : prev.usageBreakdown,
            cacheMissSummary: loopStateRef.current
              ? cloneCacheMissSummary(loopStateRef.current.cacheMissSummary)
              : prev.cacheMissSummary,
          }))
        },
        onCompressionProgress: (description) => {
          setState((prev) => ({ ...prev, compressionLabel: description }))
        },
        onContextCompressed: (summary) => {
          setState((prev) => ({ ...prev, compressionLabel: null }))
          appendMessage({
            id: `compress-${Date.now()}`,
            role: 'assistant',
            content: summary,
            timestamp: Date.now(),
            kind: 'command-result',
          })
        },
        onStreamRetry: handleStreamRetry,
        onError: (error) => {
          setState((prev) => ({ ...prev, error: error.message }))
        },
      }

      try {
        await initialize()
        await applyModelRequestPreflight(modelIdRef.current)
        // 把输入中任何 @path / 裸路径引用解析成正确的 content 部件（多模态
        // provider 得到图像，PDF/Office/非视觉 provider 得到提取文本）。当没有
        // 检测到可附加内容时，回落到纯字符串快路径。
        //
        // Ingest 通知更新实时 spinner，让较长的本地处理和首次模型下载保持可见，
        // 而不会淹没历史。
        const modelId = modelIdRef.current
        const providerCaps = capabilitiesOf(modelId)
        const activeLoopState =
          loopStateRef.current ?? createLoopState(permissionModeRef.current, { projectCwd: process.cwd() })
        loopStateRef.current = activeLoopState
        bindShellSessionEvents(activeLoopState)
        const prepareUserContent = async (input: string) => {
          const refs = extractFileReferences(input)
          if (refs.length === 0) return input

          const toolCalls = refs.map((ref) => ({
            id: `file-ingest-${fileIngestSequenceRef.current++}`,
            filePath: ref.absolutePath,
          }))
          for (const toolCall of toolCalls) {
            toolLifecycleCallbacks.onToolCall(toolCall.id, 'fileIngest', { filePath: toolCall.filePath })
          }
          const finishFileIngestTools = (result: string, isError?: boolean) => {
            for (const toolCall of toolCalls) toolLifecycleCallbacks.onToolResult(toolCall.id, result, isError)
            // fileIngest 参与现有的只读分组。一个不可见的不可折叠哨兵会在
            // provider 开始响应之前立即冲刷已完成的批次，这样用户看到的是
            // `Read N files (...)` 而不是一个光秃秃的 Working spinner。
            appendMessage({
              id: `file-ingest-flush-${fileIngestSequenceRef.current++}`,
              role: 'assistant',
              content: '',
              kind: 'command-result',
              timestamp: Date.now(),
            })
            setState((prev) => ({ ...prev, bufferingReads: false }))
          }
          try {
            const content = await buildUserContent(
              input,
              modelSupportsVision(modelId) ? providerCaps : { ...providerCaps, image: false },
              (notice) => {
                const label = notice.split(/\r?\n/, 1)[0] ?? notice
                setState((prev) => ({ ...prev, ingestLabel: label }))
                for (const toolCall of toolCalls) toolLifecycleCallbacks.onToolProgress(toolCall.id, label)
              },
              controller.signal,
              undefined,
              modelId,
              activeLoopState.readFileCache,
            )
            controller.signal.throwIfAborted()
            finishFileIngestTools('Prepared for analysis.')
            return content
          } catch (error) {
            finishFileIngestTools(`Error: ${errorMessage(error)}`, true)
            throw error
          } finally {
            setState((prev) => ({ ...prev, ingestLabel: null }))
          }
        }
        const content = submitOptions?.rawContent ? text : await prepareUserContent(text)
        // agentLoop 返回 { state, turnCount }——我们只保留 state（长生命周期的
        // 会话）。turnCount 是每次调用级的，主交互循环用不到它（上限机制是
        // sub-agent 和 --print 模式用的）。
        if (submitOptions?.toolFilter && loopStateRef.current) {
          loopStateRef.current.systemPromptCache = null
          markExpectedCacheMiss(loopStateRef.current, 'tool-surface-change')
        }

        const agentResult = await agentLoop(
          content,
          modelRef.current,
          {
            ...options,
            modelId: modelIdRef.current,
            thinking: thinkingRef.current,
            toolFilter: submitOptions?.toolFilter ?? options.toolFilter,
            maxTurns: submitOptions?.maxTurns ?? options.maxTurns,
            // permissionMode 只在第一次 submit 时起作用（此时 createLoopState
            // 在 agentLoop 内被调用）。对于后续 submit，已有的 LoopState 承载着
            // 实时模式，所以这次读取只是一个 no-op 透传。
            permissionMode: permissionModeRef.current,
            abortSignal: controller.signal,
            executionAuthority: lease.authority as ExecutionAuthority,
            // 中途回合转向：用户在本回合运行期间排队的消息在工具边界 / stop 时
            // 注入。稳定回调——原子地读取并清空 queuedMessagesRef。
            consumeQueuedInputs: ownerMayDrainQueuedInputs(lease.owner) ? consumeQueuedInputsInDisplayOrder : undefined,
            prepareQueuedUserInput: ownerMayDrainQueuedInputs(lease.owner) ? prepareUserContent : undefined,
          },
          callbacks,
          activeLoopState,
        )
        loopStateRef.current = agentResult.state
        const injectedPeerKeys = new Set([...(submitOptions?.peerInboxKeys ?? []), ...consumedPeerInboxKeysRef.current])
        if (injectedPeerKeys.size > 0) options.peerService?.markAgentInputsInjected([...injectedPeerKeys])
        consumedPeerInboxKeysRef.current.clear()
        if (submitOptions?.toolFilter) {
          loopStateRef.current.systemPromptCache = null
          markExpectedCacheMiss(loopStateRef.current, 'tool-surface-change')
        }
        const finalGoal = agentResult.state.goal ? { ...agentResult.state.goal } : null

        // 收尾：把流缓冲里剩下的内容排空到 messages，然后清除 loading 标志。
        // 作为安全网，如果流没有产生文本（例如 provider 在最终文本落到
        // `response.messages` 之前只发出了 reasoning 块），就从 loopState 提取
        // 最后一段 assistant 文本，让用户总能看到回复。
        flushBuffer()
        flushShellWaitUi()
        if (!sawTextDelta && loopStateRef.current) {
          const fallback = extractLastAssistantText(loopStateRef.current.messages)
          if (fallback) {
            appendMessage({
              id: `text-${Date.now()}`,
              role: 'assistant',
              content: fallback,
              timestamp: Date.now(),
            })
          }
        }
        pendingToolsRef.current.clear()
        externalSignal?.removeEventListener('abort', abortFromExternal)
        if (controller.signal.aborted) {
          // 现在可以安全地把中断通知推入 state.messages 了：agentLoop 已返回，
          // 意味着 processToolCalls 已完全排空，所有 tool_results 都已就位。更早
          // 推入（在 abort() 里）会把一条用户消息插到 assistant 的 tool_calls 和
          // 它们的结果之间，破坏 provider。
          const noticeText = pendingAbortNoticeRef.current
          if (noticeText && loopStateRef.current) {
            loopStateRef.current.messages.push({ role: 'user', content: noticeText })
            await appendInterrupted(loopStateRef.current)
            await flushPendingMessages(loopStateRef.current)
          }
          pendingAbortNoticeRef.current = null

          // Esc 路径：在 abort() 自己的队列恢复之后排队的任何内容（用户几乎同时
          // 按下 Esc 和 Enter）会留下一个没有 spinner 也没有消费者的 "queued:" 行。
          // 把它也折回恢复的草稿里——像 abort() 本身一样零丢失。
          restoreQueueToDraft()
        }
        // 保持 busy UI 可见，直到 abort 持久化和队列恢复完成。更早清除它会在
        // 回合租约仍被持有时暴露一个看似空闲的提示符，于是新的 submit 被排队，
        // 然后折回草稿，而不是启动恢复回合。
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          reconnectLabel: null,
          goalStatus: finalGoal,
          peerInfluenced: agentResult.state.contextSecurity.peerInfluenceActive,
          stepStats: loopStateRef.current?.stepStats.slice() ?? prev.stepStats,
        }))
        return agentResult
      } catch (err) {
        const droppedPeerKeys = new Set([...(submitOptions?.peerInboxKeys ?? []), ...consumedPeerInboxKeysRef.current])
        if (droppedPeerKeys.size > 0) {
          options.peerService?.markAgentInputsDropped([...droppedPeerKeys], 'agent-turn-failed-before-commit')
        }
        consumedPeerInboxKeysRef.current.clear()
        pendingToolsRef.current.clear()
        externalSignal?.removeEventListener('abort', abortFromExternal)
        // 用户取消路径：agentLoop 把 AbortError 吞成一个干净的 'aborted' 结果并
        // 正常返回，所以对于 Esc/Ctrl+C 中止我们不应该走到这里。但如果某个
        // 没有 abort 感知的辅助函数（如 memory 加载）在 controller 也已中止时
        // 中途抛出，就抑制错误横幅——abort() 已经写进 messages 的
        // `[Request interrupted by user]` 通知才是我们想要的用户可见信号。
        const wasAborted = controller.signal.aborted
        if (wasAborted) {
          const noticeText = pendingAbortNoticeRef.current
          if (noticeText && loopStateRef.current) {
            loopStateRef.current.messages.push({ role: 'user', content: noticeText })
            await appendInterrupted(loopStateRef.current)
            await flushPendingMessages(loopStateRef.current)
          }
          pendingAbortNoticeRef.current = null
        }
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolCalls: [],
          bufferingReads: false,
          compressionLabel: null,
          reconnectLabel: null,
          error: wasAborted ? null : classifyApiError(err).message,
        }))
        return null
      } finally {
        activeForkBoundaryRef.current = null
        if (ownsLease) {
          lease.release()
          if (!submitOptions?.skipIdleDrain) {
            scheduleIdleDrain()
          }
        }
      }
    },
    [
      options,
      initialize,
      flushBuffer,
      appendMessage,
      handleTextDelta,
      handleStreamRetry,
      toolLifecycleCallbacks,
      consumeQueuedInputsInDisplayOrder,
      consumedPeerInboxKeysRef,
      restoreQueueToDraft,
      currentAuthority,
      queueMessage,
      scheduleIdleDrain,
      bindShellSessionEvents,
      flushShellWaitUi,
      applyModelRequestPreflight,
    ],
  )

  const submitRawPeerContent = useCallback(
    async (input: {
      content: string
      peer: PublicPeer
      messageId: string
      inboxKey?: string
    }): Promise<AgentLoopResult | null> => {
      const authority = peerExecutionAuthority(input.peer, input.messageId)
      const lease = turnCoordinatorRef.current.tryAcquire('peer', authority)
      if (!lease) {
        queuedMessagesRef.current = [
          ...queuedMessagesRef.current,
          {
            id: `queued-${queueSeqRef.current++}`,
            source: 'peer',
            display: input.content,
            content: input.content,
            peer: input.peer,
            messageId: input.messageId,
            ...(input.inboxKey ? { inboxKey: input.inboxKey } : {}),
          },
        ]
        return null
      }
      try {
        appendMessage({
          id: `peer-${input.messageId}`,
          role: 'user',
          content: input.content,
          timestamp: Date.now(),
          kind: 'peer-message',
          peer: input.peer,
        })
        return await submit(
          formatQueuedAgentInput({
            id: `peer-${input.messageId}`,
            source: 'peer',
            display: input.content,
            content: input.content,
            peer: input.peer,
            messageId: input.messageId,
            ...(input.inboxKey ? { inboxKey: input.inboxKey } : {}),
          }),
          {
            silent: true,
            owner: 'peer',
            lease,
            authority,
            rawContent: true,
            ...(input.inboxKey ? { peerInboxKeys: [input.inboxKey] } : {}),
          },
        )
      } finally {
        lease.release()
        scheduleIdleDrain()
      }
    },
    [appendMessage, queueSeqRef, queuedMessagesRef, scheduleIdleDrain, submit],
  )

  /** 在提交 PeerInbox 认领之前，同步预留有界的、按来源区分的队列容量。返回的
   *  布尔值是 App 适配器使用的所有权交接点。 */
  const enqueuePeerInput = useCallback(
    (input: { content: string; peer: PublicPeer; messageId: string; inboxKey: string }): boolean => {
      if (queuedMessagesRef.current.filter((entry) => entry.source === 'peer').length >= 50) return false
      void submitRawPeerContent(input)
      return true
    },
    [submitRawPeerContent, queuedMessagesRef],
  )

  /** 供 submit() 成功路径内部触发的 idle-drain 后续使用的自引用——直接递归调用
   *  会让 useCallback 依赖它自己。每次渲染都同步；末尾的排水总能触达最新的
   *  submit 闭包。 */
  useEffect(() => {
    submitRef.current = submit
  })

  /** 解析第一个待处理的权限请求，并把它从队列中弹出 */
  const resolvePermission = useCallback((decision: PermissionDecision) => {
    setState((prev) => {
      const [head, ...tail] = prev.permissionQueue
      if (head) {
        const r = permissionResolversRef.current[0]
        queueMicrotask(() => {
          if (r !== undefined && permissionResolversRef.current[0] === r) {
            permissionResolversRef.current.shift()
            r(decision)
          }
        })
      }
      return { ...prev, permissionQueue: tail }
    })
  }, [])

  const resolveAuthority = useCallback(
    (allow: boolean) => {
      const pending = pendingAuthorityRef.current
      pendingAuthorityRef.current = null
      setState((prev) => ({ ...prev, authorityRequest: null }))
      const owner = turnCoordinatorRef.current.current()?.owner
      if (owner && options.peerService) {
        const busyKind = owner === 'goal' ? 'goal' : 'interactive-turn'
        void options.peerService.updateLocalState({ status: 'busy', busyKind }).catch(() => {})
      }
      if (pending) {
        queueMicrotask(() => pending.resolve(authorityApproval(pending.preview, allow ? 'allow-once' : 'deny')))
      }
    },
    [options.peerService],
  )

  /** 解析一个待处理的问题 */
  const resolveQuestion = useCallback((answer: string) => {
    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    if (pendingQuestion) queueMicrotask(() => pendingQuestion.resolve(answer))
    setState((prev) => ({ ...prev, pendingQuestion: null }))
  }, [])

  /** 为用户弹出一个多选问题。与 `askUser` 使用同一个 SelectOptions 对话框，
   *  为 /model 这类需要交互式选择器的斜杠命令而暴露。返回一个 promise，解析为
   *  用户选择的标签（或自由形式的 "Other" 文本）。 */
  const askQuestion = useCallback(
    (
      question: string,
      options: { label: string; description: string; preview?: string[] }[],
      opts?: { layout?: 'compact' | 'compact-vertical'; noOther?: boolean },
    ) => {
      return new Promise<string>((resolve) => {
        const augmented = opts?.noOther ? options : [...options, OTHER_OPTION]
        const pendingQuestion: PendingQuestion = {
          question,
          options: augmented,
          resolve,
          abortAnswer: '',
          dismissible: true,
          layout: opts?.layout,
        }
        pendingQuestionRef.current = pendingQuestion
        setState((prev) => ({ ...prev, pendingQuestion }))
      })
    },
    [],
  )

  const hasPendingPeerInput = useCallback((): boolean => {
    if (queuedMessagesRef.current.some((input) => input.source === 'peer')) return true
    const snapshot = options.peerService?.inbox.getSnapshot()
    return Boolean(snapshot && snapshot.accepted + snapshot.held > 0)
  }, [options.peerService, queuedMessagesRef])

  const clearPeerContext = useCallback(async (): Promise<{ ok: boolean; removed: number; reason?: string }> => {
    const ls = loopStateRef.current
    if (!ls?.contextSecurity.peerInfluenceActive) return { ok: true, removed: 0 }
    const lease = turnCoordinatorRef.current.tryAcquire('clear', currentAuthority())
    if (!lease) return { ok: false, removed: 0, reason: 'Another turn or maintenance operation is in progress.' }
    try {
      if (hasPendingPeerInput()) {
        return { ok: false, removed: 0, reason: 'Peer messages are still queued; process or reject them first.' }
      }
      const answer = await askQuestion(
        'Remove the peer-influenced conversation suffix and restore normal permission automation?',
        [
          { label: 'Remove suffix', description: 'Delete the peer message and every response derived from it.' },
          { label: 'Cancel', description: 'Keep the transcript and reduced authority unchanged.' },
        ],
        { noOther: true },
      )
      if (answer !== 'Remove suffix') return { ok: false, removed: 0, reason: 'Cancelled.' }
      if (hasPendingPeerInput()) {
        return { ok: false, removed: 0, reason: 'A peer message arrived while confirmation was open.' }
      }
      const removed = await clearCorePeerContext(ls)
      setState((prev) => ({
        ...prev,
        messages: modelMessagesToDisplay(ls.messages),
        activeToolCalls: [],
        permissionQueue: [],
        pendingQuestion: null,
        peerInfluenced: false,
      }))
      return { ok: true, removed }
    } catch (error) {
      return { ok: false, removed: 0, reason: errorMessage(error) }
    } finally {
      lease.release()
    }
  }, [askQuestion, currentAuthority, hasPendingPeerInput])

  const {
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    drainPendingInteractions,
    pauseActiveGoalOnAbort,
  } = useGoalController({
    agentOptions: options,
    setState,
    modelRef,
    modelIdRef,
    thinkingRef,
    permissionModeRef,
    loopStateRef,
    abortControllerRef,
    pendingQuestionRef,
    pendingAuthorityRef,
    authorityRequestSequenceRef,
    permissionResolversRef,
    turnCoordinatorRef,
    appendMessage,
    appendTextDelta,
    goalToolLifecycleCallbacks,
    handleStreamRetry,
    bindShellSessionEvents,
    currentAuthority,
    submit,
  })

  /** 中止进行中的回合。镜像 Claude Code 的 onCancel：
   *
   *    1. 把任何缓冲的流式文本冲刷进 messages，让用户看到模型在按下 Esc 之前
   *       生成的内容。
   *    2. 追加一条 `[Request interrupted by user]`（或 `for tool use`）通知，
   *       让 UI 和下一回合的模型上下文都能显示响应为何停止。
   *    3. 触发 AbortController，让 streamText / shell execa 展开。
   *
   *  当没有进行中的内容（没有 controller 或已中止）时为 no-op。
   *  React state 清理（isLoading=false, activeToolCalls=[]）发生在 submit()
   *  的成功路径里，一旦 agentLoop 返回 'aborted' 结果就执行。
   *
   *  排队的权限提示和待处理的 SelectOptions 对话框被同步解析，这样在用户取消后，
   *  `processToolCalls` 就不会一直阻塞在 `await onAskPermission` / `onAskUser` 上。 */
  const abort = useCallback(() => {
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    if (manualCompressionControllerRef.current === controller) {
      controller.abort()
      return
    }

    // 先排空流缓冲——appendMessage 通过 setState 同步运行，这样部分的 assistant
    // 回复会在 scrollback 顺序里落到中断通知之前。
    flushBuffer()
    flushShellWaitUi()

    const forToolUse = activeToolCallsLenRef.current > 0
    const noticeText = forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'

    appendMessage({
      id: `interrupt-${Date.now()}`,
      role: 'assistant',
      content: noticeText,
      timestamp: Date.now(),
      kind: 'command-result',
    })

    // 把 state.messages 的变更推迟到 agentLoop 返回。现在就推入 user-role 通知，
    // 会把它插到 assistant tool_calls 和它们的 tool_results 之间（processToolCalls
    // 仍在运行，并会在 abort 信号触发后推送合成结果）。那会破坏 provider 要求的
    // 严格 assistant→tool 顺序，并在下一次请求时导致
    // "Tool result is missing for tool call ..."。
    //
    // 存储通知文本；submit() 的 post-loop abort 路径会在 processToolCalls 完全
    // 排空后推送并持久化它。
    pendingAbortNoticeRef.current = noticeText

    pauseActiveGoalOnAbort()

    // 解阻核心循环里任何 `await onAskPermission`（并行工具调用会排队额外的 UI
    // 行，但执行是顺序的——第一个 shell 常常卡在这里，而用户以为 UI "冻结"了）。
    drainPendingInteractions()

    // 零丢失队列恢复（Codex 的 input_restore 语义）：中途排队但从未注入的消息
    // 回到输入框，成为一个可编辑的草稿，而不是被静默丢弃或在中断后自动运行。
    // ChatInput 在 nonce 变化时应用 `restoredDraft`。
    restoreQueueToDraft()

    controller.abort()
  }, [
    appendMessage,
    drainPendingInteractions,
    flushBuffer,
    flushShellWaitUi,
    pauseActiveGoalOnAbort,
    restoreQueueToDraft,
  ])

  const quiesce = useCallback(async () => {
    if (planApprovalTimerRef.current) {
      clearTimeout(planApprovalTimerRef.current)
      planApprovalTimerRef.current = null
    }
    drainPendingInteractions()
    abort()
    if (!turnCoordinatorRef.current.isOwned()) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve()
      }, 1_000)
      const unsubscribe = turnCoordinatorRef.current.onChange((lease) => {
        if (lease) return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
  }, [abort, drainPendingInteractions])

  const cleanupShells = useCallback(
    async (
      reason: TerminationReason = 'cli-shutdown',
      budget?: TerminationBudget,
    ): Promise<TerminateAllResult | null> => {
      const manager = loopStateRef.current?.shellSessions
      return manager ? manager.dispose(reason, budget) : null
    },
    [],
  )

  const listShellSessions = useCallback((): ShellSessionSummary[] => {
    return loopStateRef.current?.shellSessions.list() ?? []
  }, [])

  const stopShellSessions = useCallback(async (shellId?: string): Promise<TerminateAllResult | null> => {
    const manager = loopStateRef.current?.shellSessions
    if (!manager) return null
    if (!shellId) return manager.terminateAll('stop-command')
    const result = await manager.terminate(shellId, 'stop-command')
    return {
      managerInstanceId: manager.managerInstanceId,
      reason: 'stop-command',
      requested: 1,
      confirmed: result.disposition === 'terminated' && result.terminationConfirmed ? 1 : 0,
      alreadyExited: result.disposition === 'already-exited' ? 1 : 0,
      results: [result],
    }
  }, [])

  const {
    cleanup,
    reloadMemory,
    getSessionInfo,
    fork,
    clear,
    resume,
    getCheckpoints,
    rewind,
    getDiffStats,
    activeTurnOwner,
    hasActiveForkBoundary,
  } = useSessionController({
    agentOptions: options,
    setState,
    loopStateRef,
    modelRef,
    modelIdRef,
    permissionModeRef,
    activeForkBoundaryRef,
    turnCoordinatorRef,
    pendingToolsRef,
    permissionResolversRef,
    pendingQuestionRef,
    queuedMessagesRef,
    bindShellSessionEvents,
    resetBuffer,
    currentAuthority,
    hasPendingPeerInput,
  })

  /** 手动上下文压缩 */
  const compact = useCallback(async () => {
    const ls = loopStateRef.current
    if (!ls) return { status: 'nothing' as const, reason: 'no-conversation' as const }
    const lease = turnCoordinatorRef.current.tryAcquire('compact', currentAuthority())
    if (!lease) return { status: 'failed' as const, message: 'Another turn or maintenance operation is in progress.' }
    let compressionApi: typeof import('@x-code-cli/core')
    try {
      compressionApi = await import('@x-code-cli/core')
    } catch (error) {
      lease.release()
      throw error
    }
    const { estimateTokenCount, KEEP_RECENT, KEEP_RECENT_TOKENS } = compressionApi

    const before = estimateTokenCount(ls.messages)
    if (ls.messages.length <= KEEP_RECENT) {
      lease.release()
      return {
        status: 'nothing' as const,
        reason: 'too-few-messages' as const,
        estimatedTokens: before,
        messageCount: ls.messages.length,
        minimumMessages: KEEP_RECENT + 1,
      }
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    manualCompressionControllerRef.current = controller
    setState((prev) => ({
      ...prev,
      isLoading: true,
      compressionLabel: 'Summarizing conversation',
      reconnectLabel: null,
      error: null,
    }))
    debugLog('compression.manual.start', `messages=${ls.messages.length} tokens=${before}`)

    try {
      const compressionModel = await applyModelRequestPreflight(modelIdRef.current)
      // 提取之前的摘要，用于增量更新 + 文件追踪
      const firstMsg = ls.messages[0]
      const prefix = '[Previous conversation summary]\n'
      const previousSummary =
        firstMsg?.role === 'user' && typeof firstMsg.content === 'string' && firstMsg.content.startsWith(prefix)
          ? firstMsg.content.slice(prefix.length)
          : undefined
      const modified = [...ls.filesModified]
      const read = [...ls.readFileCache.keys()].filter((p) => !ls.filesModified.has(p))
      const filesTracked = { modified, read }

      const originalTrackedMessages = ls.trackedMessages
      const compressed = await compressTrackedMessagesWithUsage(
        originalTrackedMessages,
        compressionModel,
        previousSummary,
        filesTracked,
        controller.signal,
      )
      if (controller.signal.aborted) {
        debugLog('compression.manual.cancelled', `tokens=${before}`)
        return { status: 'cancelled' as const }
      }
      if (
        compressed.trackedMessages.length === originalTrackedMessages.length &&
        compressed.trackedMessages.every((entry, index) => entry.entryId === originalTrackedMessages[index]?.entryId)
      ) {
        debugLog('compression.manual.skipped', `messages=${ls.messages.length} tokens=${before}`)
        return {
          status: 'nothing' as const,
          reason: 'within-retention-window' as const,
          estimatedTokens: before,
          retentionTokens: KEEP_RECENT_TOKENS,
        }
      }
      await markBoundaryAndReflush(ls, compressed.summary, compressed.trackedMessages)
      if (compressed.usage) {
        const usageModelId = attributedModelId(modelIdRef.current, compressed.modelId)
        accumulateUsage(ls, {
          source: 'compaction',
          modelId: usageModelId,
          usage: normalizeLanguageModelUsage(compressed.usage),
        })
        setState((prev) => ({
          ...prev,
          usage: { ...ls.tokenUsage },
          usageBreakdown: cloneUsageBreakdown(ls.usageBreakdown),
        }))
        await appendUsage(ls, usageModelId)
      }
      // 消息已变更——镜像自动压缩路径：重置 cache-hit 信号，让下一回合不会错误地
      // 假定前缀匹配；重置 lastInputTokens，让 checkAndCompressContext 不会在
      // 过期的较高值上再次触发。同时向 jsonl 写入一个 compact 边界，让加载器能
      // 拾取压缩后的状态。
      ls.lastInputTokens = 0
      markExpectedCacheMiss(ls, 'compaction')
      const after = estimateTokenCount(ls.messages)
      // 计入系统提示词开销，让报告的数字与 footer 的 "N / M · X%" 指示器一致
      // （它显示的是 API 实际收到的完整上下文，而不仅是消息正文）。
      const sysCost = ls.systemPromptCache ? Math.ceil(Buffer.byteLength(ls.systemPromptCache, 'utf8') / 3) : 0
      debugLog('compression.manual.complete', `before=${before} after=${after} sysCost=${sysCost}`)
      return {
        status: 'compressed' as const,
        estimatedTokensBefore: before + sysCost,
        estimatedTokensAfter: after + sysCost,
      }
    } catch (err) {
      if (controller.signal.aborted) {
        debugLog('compression.manual.cancelled', `tokens=${before}`)
        return { status: 'cancelled' as const }
      }
      const message = classifyApiError(err).message
      debugLog('compression.manual.error', message)
      return { status: 'failed' as const, message }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      if (manualCompressionControllerRef.current === controller) manualCompressionControllerRef.current = null
      setState((prev) => ({ ...prev, isLoading: false, compressionLabel: null, reconnectLabel: null }))
      // spinner 可见期间提交的纯文本会进入中途队列。`/compact` 没有 agent 循环
      // 来消费它，所以把它放回可编辑输入，而不是留下一个滞留的队列行。
      restoreQueueToDraft()
      lease.release()
    }
  }, [applyModelRequestPreflight, currentAuthority, restoreQueueToDraft])

  /** 运行时切换模型 */
  const switchModel = useCallback(
    (newModelId: string, newModel: LanguageModel) => {
      modelRef.current = newModel
      modelIdRef.current = newModelId
      invalidateModelDependentState(loopStateRef.current)
      options.memoryService?.setActiveModelId(newModelId)
      setState((prev) => ({ ...prev, modelId: newModelId }))
    },
    [options.memoryService],
  )

  /** 在运行时开关扩展思考。下一个 agent 回合通过 thinkingRef.current 拾取。
   *  持久化（saveUserConfig）发生在 App.tsx 的命令处理器里，不在这里——让这个
   *  hook 无磁盘副作用，与现有的模型切换分离一致。 */
  const setThinking = useCallback((enabled: boolean) => {
    if (thinkingRef.current === enabled) return
    thinkingRef.current = enabled
    if (loopStateRef.current) markExpectedCacheMiss(loopStateRef.current, 'reasoning-change')
  }, [])

  /** 读取当前的 /thinking 开关（用于状态显示）。 */
  const getThinking = useCallback(() => thinkingRef.current, [])

  /** 丢弃缓存的系统提示词，让下一个 agent 回合按当前工具面重新构建它。
   *
   *  该缓存是 agent 循环在每个会话开始时构建、并跨回合复用的工具列表 +
   *  plan 覆盖层快照，用于保留 OpenAI 兼容 provider 的前缀缓存。任何改变可见工具
   *  的事情——`/mcp refresh` 增删 server、`/mcp auth <name>` 让一个此前需要 auth
   *  的 server 上线——都必须使缓存失效，这样下一次 streamText 调用才会发送一个
   *  与实际工具列表匹配的提示词。否则模型会看到不存在的工具（或漏掉新工具），
   *  并触发循环里 `MCP tool not found: …` 的错误路径。 */
  const invalidateSystemPromptCache = useCallback(() => {
    invalidateToolSurfaceState(loopStateRef.current)
  }, [])

  /** 直接设置权限模式。用于 /plan 风格的直接设置器，此时用户明确要求一个特定
   *  目标。实时更新 LoopState（让下一个 agent 回合拾取新模式）、使系统提示词缓存
   *  失效（让下一回合用正确的覆盖层重建提示词）、预留 / 清除计划文件路径，并把
   *  变更镜像进 React state 以触发 UI 重渲染。 */
  const setPermissionMode = useCallback((next: PermissionMode) => {
    if (permissionModeRef.current === next) return
    permissionModeRef.current = next
    if (loopStateRef.current) {
      loopStateRef.current.permissionMode = next
      loopStateRef.current.systemPromptCache = null
      markExpectedCacheMiss(loopStateRef.current, 'permission-mode-change')
      // 离开计划模式时清空路径，这样下次重新进入时会根据用户接下来的
      // 问题生成新的 slug；路径会在 agentLoop / enterPlanMode 处理器中
      // 根据下一条用户消息按需重新推导。
      if (next !== 'plan') loopStateRef.current.currentPlanPath = null
    }
    setState((prev) => ({ ...prev, permissionMode: next }))
  }, [])

  /** 估算当前上下文按类别的 token 分布（系统提示词 / 工具 / 规则 / 技能 / MCP /
   *  sub-agent / 摘要 / 对话），镜像下一次请求实际会发送的内容。在第一个回合构建
   *  系统提示词之前返回 null。由 /usage 用于展示 Cursor 风格的上下文构成——
   *  原始估算；与真实上报的输入计数的校准发生在渲染时。 */
  const getContextBreakdown = useCallback((): ContextBreakdown | null => {
    const ls = loopStateRef.current
    if (!ls) return null
    const input = buildContextBreakdownInput(options, ls)
    return input ? estimateContextBreakdown(input) : null
  }, [options])

  const addPeerStatus = useCallback(
    (content: string, peer?: PublicPeer) => {
      appendMessage({
        id: `peer-status-${Date.now()}-${queueSeqRef.current++}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        kind: 'peer-status',
        ...(peer ? { peer } : {}),
      })
    },
    [appendMessage, queueSeqRef],
  )

  const addHeldPeerPreview = useCallback(
    (content: string, peer: PublicPeer, summary?: string) => {
      appendMessage({
        id: `peer-held-${Date.now()}-${queueSeqRef.current++}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        kind: 'peer-message',
        peer: { ...peer, ...(summary ? { summary } : {}) },
      })
    },
    [appendMessage, queueSeqRef],
  )

  const { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult } =
    useAgentDisplayHelpers(appendMessage)

  return {
    state,
    activeTurnOwner,
    hasActiveForkBoundary,
    submit,
    submitRawPeerContent,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
    queueMessage,
    popQueuedMessage,
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    resolvePermission,
    resolveAuthority,
    resolveQuestion,
    abort,
    quiesce,
    cleanup,
    cleanupShells,
    listShellSessions,
    stopShellSessions,
    fork,
    clear,
    clearPeerContext,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getDiffStats,
    getContextBreakdown,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    reloadMemory,
    invalidateSystemPromptCache,
    setPermissionMode,
    addInfoMessage,
    addUserMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
  }
}
