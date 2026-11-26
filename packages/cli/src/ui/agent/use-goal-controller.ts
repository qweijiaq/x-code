import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import {
  admitGoalInput,
  appendGoalInput,
  appendGoalState,
  appendGoalVerification,
  appendHeader,
  buildVerifierFailurePrompt,
  cancelGoal as cancelCoreGoal,
  clearGoal as clearCoreGoal,
  clearPendingTransition,
  createGoal as createCoreGoal,
  createGoalRunCoordinator,
  createLoopState,
  errorMessage,
  generateTaskSlug,
  markExpectedCacheMiss,
  pauseGoal as pauseCoreGoal,
  recordVerificationFailure,
  resetVerificationFailures,
  resumeGoal as resumeCoreGoal,
  runGoalLoop,
  runVerifierLadder,
  updateGoalStatus,
} from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  AuthorityApproval,
  DisplayMessage,
  ExecutionAuthority,
  GoalState,
  LanguageModel,
  LoopState,
  PermissionDecision,
  PermissionMode,
  StreamRetryEvent,
} from '@x-code-cli/core'

import { appendShellOutput } from './agent-tool-lifecycle.js'
import type { GoalToolLifecycleCallbacks } from './agent-tool-lifecycle.js'
import { authorityApproval } from './authority-approval.js'
import { OTHER_OPTION } from './question-options.js'
import type { AuthoritySnapshot, TurnCoordinator, TurnLease } from './turn-coordinator.js'
import type { AgentState, PendingAuthority, PendingQuestion, RunGoalCommand, SubmitAgentInput } from './types.js'
import { extractLastAssistantText } from './use-stream-buffer.js'

interface MutableRef<T> {
  current: T
}

/** `resumeGoalRun` 的结果：`busy` 表示目标运行器已持有租约（输入会被消费），
 *  `failed` 才是真的没恢复成功。 */
interface ResumeGoalOutcome {
  status: 'resumed' | 'busy' | 'failed'
  goal: GoalState | null
  reason?: string
}

/** 租约里的 authority 是深冻结的只读快照（见 turn-coordinator 的
 *  `AuthoritySnapshot`）。下游把它当可变对象用（例如写 `peerTainted`）时，
 *  严格模式下就地写入会抛 TypeError，而 `as ExecutionAuthority` 恰恰让编译器
 *  发现不了这种结构不匹配——所以这里做一次显式的可写副本。 */
function toExecutionAuthority(authority: AuthoritySnapshot): ExecutionAuthority {
  const peerOrigins = authority.peerOrigins
  return {
    source: authority.source,
    peerTainted: authority.peerTainted,
    ...(peerOrigins
      ? {
          peerOrigins: {
            items: peerOrigins.items.map((item) => ({
              instanceId: item.instanceId,
              nameAtReceipt: item.nameAtReceipt,
              messageId: item.messageId,
            })),
            totalCount: peerOrigins.totalCount,
            digest: peerOrigins.digest,
            truncated: peerOrigins.truncated,
          },
        }
      : {}),
  }
}

interface UseGoalControllerOptions {
  agentOptions: AgentOptions
  setState: Dispatch<SetStateAction<AgentState>>
  modelRef: MutableRef<LanguageModel>
  modelIdRef: MutableRef<string>
  thinkingRef: MutableRef<boolean>
  permissionModeRef: MutableRef<PermissionMode>
  loopStateRef: MutableRef<LoopState | null>
  abortControllerRef: MutableRef<AbortController | null>
  pendingQuestionRef: MutableRef<PendingQuestion | null>
  pendingAuthorityRef: MutableRef<PendingAuthority | null>
  authorityRequestSequenceRef: MutableRef<number>
  permissionResolversRef: MutableRef<Array<(decision: PermissionDecision) => void>>
  turnCoordinatorRef: MutableRef<TurnCoordinator>
  appendMessage: (message: DisplayMessage) => void
  appendTextDelta: AgentCallbacks['onTextDelta']
  goalToolLifecycleCallbacks: GoalToolLifecycleCallbacks
  handleStreamRetry: (event: StreamRetryEvent | null) => void
  bindShellSessionEvents: (state: LoopState) => void
  currentAuthority: (source?: 'user' | 'peer') => ExecutionAuthority
  submit: SubmitAgentInput
}

export function useGoalController({
  agentOptions,
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
}: UseGoalControllerOptions) {
  const goalCoordinatorRef = useRef(createGoalRunCoordinator())

  const createGoalCallbacks = useCallback((): AgentCallbacks => {
    return {
      onTextDelta: appendTextDelta,
      ...goalToolLifecycleCallbacks,
      onAskPermission: (toolCall) => {
        return new Promise<PermissionDecision>((resolve) => {
          permissionResolversRef.current.push(resolve)
          const mcpEntry = agentOptions.mcpRegistry?.get(toolCall.toolName)
          setState((previous) => ({
            ...previous,
            permissionQueue: [
              ...previous.permissionQueue,
              {
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: toolCall.input,
                mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
              },
            ],
          }))
        })
      },
      onAskAuthority: (request) => {
        return new Promise<AuthorityApproval>((resolve) => {
          const pending: PendingAuthority = { ...request, requestId: authorityRequestSequenceRef.current++, resolve }
          // 单槽位覆盖前先应答上一个请求：丢弃它的 `resolve` 会让等待它的
          // 核心循环永远挂起（`drainPendingInteractions` 只在显式中断时才清理）。
          // 拒绝语义与那里保持一致。
          const previous = pendingAuthorityRef.current
          if (previous) previous.resolve(authorityApproval(previous.preview, 'deny'))
          pendingAuthorityRef.current = pending
          void agentOptions.peerService?.updateLocalState({ status: 'waiting' }).catch(() => {})
          setState((previous) => ({ ...previous, authorityRequest: pending }))
        })
      },
      onAskUser: (question, options) => {
        return new Promise<string>((resolve) => {
          const pendingQuestion: PendingQuestion = {
            question,
            options: [...options, OTHER_OPTION],
            resolve,
            abortAnswer: '',
            layout: 'compact-vertical',
          }
          // 与 onAskAuthority 同理：覆盖单槽位前先应答上一个请求，否则它的
          // promise 永远不会 settle。
          if (pendingQuestionRef.current) pendingQuestionRef.current.resolve(pendingQuestionRef.current.abortAnswer)
          pendingQuestionRef.current = pendingQuestion
          setState((previous) => ({ ...previous, pendingQuestion }))
        })
      },
      onPlanApprovalRequest: async () => false,
      onPlanModeChange: (mode) => {
        permissionModeRef.current = mode
        setState((previous) => ({ ...previous, permissionMode: mode }))
      },
      onTodosUpdate: (todos) => setState((previous) => ({ ...previous, todos })),
      onShellOutput: (chunk) =>
        setState((previous) => ({ ...previous, shellOutput: appendShellOutput(previous.shellOutput, chunk) })),
      onUsageUpdate: (usage) => setState((previous) => ({ ...previous, usage })),
      onContextCompressed: (summary) => {
        appendMessage({
          id: `compress-${Date.now()}`,
          role: 'assistant',
          content: summary,
          timestamp: Date.now(),
          kind: 'command-result',
        })
      },
      onStreamRetry: handleStreamRetry,
      onError: (error) => setState((previous) => ({ ...previous, error: error.message })),
    }
  }, [
    agentOptions.mcpRegistry,
    agentOptions.peerService,
    appendMessage,
    appendTextDelta,
    goalToolLifecycleCallbacks,
    handleStreamRetry,
    pendingAuthorityRef,
    authorityRequestSequenceRef,
    pendingQuestionRef,
    permissionModeRef,
    permissionResolversRef,
    setState,
  ])

  const ensureLoopState = useCallback((): LoopState => {
    if (!loopStateRef.current) {
      loopStateRef.current = createLoopState(permissionModeRef.current, {
        projectCwd: process.cwd(),
      })
      bindShellSessionEvents(loopStateRef.current)
    }
    return loopStateRef.current
  }, [bindShellSessionEvents, loopStateRef, permissionModeRef])

  const prepareGoalSession = useCallback(
    async (state: LoopState, firstPrompt: string) => {
      if (!state.taskSlug) {
        state.taskSlug = generateTaskSlug(firstPrompt)
      }
      await appendHeader(state, modelIdRef.current, firstPrompt)
    },
    [modelIdRef],
  )

  const executeGoalLoop = useCallback(
    async (state: LoopState, goalId: string, signal: AbortSignal, lease: TurnLease): Promise<void> => {
      await runGoalLoop({
        state,
        model: modelRef.current,
        options: {
          ...agentOptions,
          modelId: modelIdRef.current,
          thinking: thinkingRef.current,
          permissionMode: permissionModeRef.current,
          abortSignal: signal,
        },
        callbacks: createGoalCallbacks(),
        goalId,
        signal,
        runAgentTurn: async (content, turnOptions) => {
          const result = await submit(content, {
            silent: true,
            toolFilter: turnOptions?.finalSummary ? { allow: [] } : undefined,
            maxTurns: turnOptions?.finalSummary ? 1 : undefined,
            signal,
            skipIdleDrain: true,
            owner: 'goal',
            lease,
            authority: toExecutionAuthority(lease.authority),
          })
          if (!result) throw new Error('Goal agent turn did not complete')
          return {
            ...result,
            text: extractLastAssistantText(result.state.messages),
          }
        },
      })
    },
    [agentOptions, createGoalCallbacks, modelIdRef, modelRef, permissionModeRef, submit, thinkingRef],
  )

  const runGoal = useCallback(
    async (command: RunGoalCommand): Promise<void> => {
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return
      const state = ensureLoopState()
      try {
        const goal = createCoreGoal(state, {
          objective: command.objective,
          maxTurns: command.maxTurns,
          tokenBudget: command.tokenBudget,
          verifiers: command.verifiers ?? [],
          requiresUserConfirmation: command.requiresUserConfirmation,
        })
        setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: true }))
        await prepareGoalSession(state, command.objective)
        await appendGoalState(state)

        await goalCoordinatorRef.current.run(goal.id, async (signal) => {
          try {
            await executeGoalLoop(state, goal.id, signal, lease)
          } finally {
            // 这个 finally 里是 I/O（写会话日志、setState）：一旦抛错，runner 回调
            // 从未正常返回，`goalRunnerActive` 会永久停在 true（UI 一直显示“目标
            // 运行中”），异常还会一路抛给调用方形成 unhandled rejection。所以收尾
            // 本身必须自带兜底。
            try {
              if (loopStateRef.current) {
                await appendGoalState(loopStateRef.current)
                setState((previous) => ({
                  ...previous,
                  goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
                  goalRunnerActive: false,
                }))
              } else {
                setState((previous) => ({ ...previous, goalRunnerActive: false }))
              }
            } catch (error) {
              setState((previous) => ({
                ...previous,
                goalRunnerActive: false,
                error: `Goal run could not be finalized: ${errorMessage(error)}`,
              }))
            }
          }
        })
      } finally {
        lease.release()
      }
    },
    [
      currentAuthority,
      ensureLoopState,
      executeGoalLoop,
      loopStateRef,
      prepareGoalSession,
      setState,
      turnCoordinatorRef,
    ],
  )

  const drainPendingInteractions = useCallback(() => {
    const permissionResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const resolve of permissionResolvers) resolve('no')

    const pendingAuthority = pendingAuthorityRef.current
    pendingAuthorityRef.current = null
    if (pendingAuthority) pendingAuthority.resolve(authorityApproval(pendingAuthority.preview, 'deny'))

    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    setState((previous) => ({
      ...previous,
      permissionQueue: [],
      authorityRequest: null,
      pendingQuestion: null,
      bufferingReads: false,
    }))
    if (pendingQuestion) pendingQuestion.resolve(pendingQuestion.abortAnswer)
  }, [pendingAuthorityRef, pendingQuestionRef, permissionResolversRef, setState])

  const stopGoalRun = useCallback(
    async (state: LoopState, goal: GoalState): Promise<void> => {
      abortControllerRef.current?.abort()
      drainPendingInteractions()
      await goalCoordinatorRef.current.interrupt(goal.id)
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: false }))
    },
    [abortControllerRef, drainPendingInteractions, setState],
  )

  const pauseGoal = useCallback(async (): Promise<GoalState | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    if (state.goal.status !== 'active') return null
    const goal = pauseCoreGoal(state)
    await stopGoalRun(state, goal)
    return goal
  }, [loopStateRef, stopGoalRun])

  /** resume 的实现体。与 `resumeGoal` 相比，它区分「目标自己正跑着（busy）」
   *  和「真的没能恢复」——`steerGoal` 需要靠这个区别判断刚写入的 steering 输入
   *  到底会不会被消费。 */
  const resumeGoalRun = useCallback(async (): Promise<ResumeGoalOutcome> => {
    const state = loopStateRef.current
    if (!state?.goal) return { status: 'failed', goal: null, reason: 'No goal exists in this session' }
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    // 拿不到租约：目标运行器自己正持有它（正常，输入会在下一个工具边界被消费），
    // 或者是别的 turn 占着（只能等它结束）。
    if (!lease) return { status: 'busy', goal: state.goal }
    let goal: GoalState
    try {
      goal = state.goal.status === 'active' ? state.goal : resumeCoreGoal(state)
    } catch (error) {
      lease.release()
      return { status: 'failed', goal: null, reason: errorMessage(error) }
    }
    try {
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: true }))
      goalCoordinatorRef.current.wake(goal.id, async (signal) => {
        try {
          await executeGoalLoop(state, goal.id, signal, lease)
        } catch (error) {
          // 与 runGoal 不同，这个 runner 没有外层调用者能接住异常：不在这里上报，
          // 用户在目标失败后就什么提示都看不到。
          setState((previous) => ({ ...previous, error: `Goal run failed: ${errorMessage(error)}` }))
        } finally {
          // 收尾要写会话日志，否则 resume 后目标完成/再次暂停的最终状态在重启后
          // 与内存不一致。写盘失败也不能让 `goalRunnerActive` 卡在 true。
          try {
            if (loopStateRef.current) await appendGoalState(loopStateRef.current)
            setState((previous) => ({
              ...previous,
              goalStatus: state.goal ? { ...state.goal } : null,
              goalRunnerActive: false,
            }))
          } catch (error) {
            setState((previous) => ({
              ...previous,
              goalStatus: state.goal ? { ...state.goal } : null,
              goalRunnerActive: false,
              error: `Goal run could not be finalized: ${errorMessage(error)}`,
            }))
          } finally {
            lease.release()
          }
        }
      })
      return { status: 'resumed', goal }
    } catch (error) {
      lease.release()
      return { status: 'failed', goal: null, reason: errorMessage(error) }
    }
  }, [currentAuthority, executeGoalLoop, loopStateRef, setState, turnCoordinatorRef])

  /** 对外保持原有契约：只有真的唤醒了运行器才返回目标（拿不到租约、恢复失败
   *  都返回 null）。 */
  const resumeGoal = useCallback(async (): Promise<GoalState | null> => {
    const outcome = await resumeGoalRun()
    return outcome.status === 'resumed' ? outcome.goal : null
  }, [resumeGoalRun])

  const cancelGoal = useCallback(async (): Promise<GoalState | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    const goal = cancelCoreGoal(state)
    await stopGoalRun(state, goal)
    return goal
  }, [loopStateRef, stopGoalRun])

  const clearGoal = useCallback(async (): Promise<void> => {
    const state = loopStateRef.current
    if (!state) return
    // clear 是“中断并清除”，必须能在 goal 占用 turn 时执行；不抢 turn lease，
    // 否则 /goal clear 会在忙碌时静默 no-op（与文档承诺相反）。
    const goalId = state.goal?.id
    if (goalId) {
      abortControllerRef.current?.abort()
      drainPendingInteractions()
      await goalCoordinatorRef.current.interrupt(goalId)
    }
    clearCoreGoal(state)
    await appendGoalState(state)
    setState((previous) => ({ ...previous, goalStatus: null, goalRunnerActive: false }))
  }, [abortControllerRef, drainPendingInteractions, loopStateRef, setState])

  const steerGoal = useCallback(
    async (text: string): Promise<GoalState | null> => {
      const state = loopStateRef.current
      if (!state?.goal) return null
      const input = admitGoalInput(state, { goalId: state.goal.id, kind: 'user_steering', content: text })
      await appendGoalInput(state, input)
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: state.goal ? { ...state.goal } : null }))
      const outcome = await resumeGoalRun()
      if (outcome.status === 'failed') {
        // steering 已写进 goalInputs，但运行器没被唤醒，它就永远不会被消费。
        // 不提示的话调用方（和用户）会以为「已插入并继续运行」。
        setState((previous) => ({
          ...previous,
          error: `Goal steering is queued but the goal did not resume: ${outcome.reason ?? 'unknown reason'}`,
        }))
      }
      return state.goal
    },
    [loopStateRef, resumeGoalRun, setState],
  )

  const editGoal = useCallback(
    async (input: { objective?: string; maxTurns?: number }): Promise<GoalState | null> => {
      const state = loopStateRef.current
      if (!state?.goal) return null
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return null
      try {
        if (input.objective !== undefined) {
          const objective = input.objective.trim()
          if (objective) state.goal.objective = objective
        }
        if (input.maxTurns !== undefined && Number.isFinite(input.maxTurns) && input.maxTurns > 0) {
          state.goal.maxTurns = Math.floor(input.maxTurns)
        }
        state.goal.updatedAt = new Date().toISOString()
        state.systemPromptCache = null
        markExpectedCacheMiss(state, 'goal-change')
        await appendGoalState(state)
        setState((previous) => ({ ...previous, goalStatus: state.goal ? { ...state.goal } : null }))
        return state.goal
      } finally {
        lease.release()
      }
    },
    [currentAuthority, loopStateRef, setState, turnCoordinatorRef],
  )

  const verifyGoal = useCallback(async (): Promise<{ goal: GoalState; ok: boolean; summary: string } | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    if (!lease) return null
    const previousController = abortControllerRef.current
    const controller = new AbortController()
    abortControllerRef.current = controller
    setState((previous) => ({ ...previous, goalVerificationActive: true }))
    try {
      const goal = state.goal
      const verification = await runVerifierLadder({
        goal,
        state,
        options: {
          ...agentOptions,
          modelId: modelIdRef.current,
          thinking: thinkingRef.current,
          permissionMode: permissionModeRef.current,
          abortSignal: controller.signal,
        },
        callbacks: createGoalCallbacks(),
        model: modelRef.current,
      })
      for (const result of verification.results) {
        await appendGoalVerification(state, goal.id, result)
      }

      if (goal.status === 'active') {
        if (verification.ok) {
          resetVerificationFailures(goal)
          updateGoalStatus(goal, 'complete', verification.summary)
          clearPendingTransition(goal)
        } else {
          const repeatedFailureCount = recordVerificationFailure(goal, verification.results)
          clearPendingTransition(goal)
          if (!verification.retryable) {
            updateGoalStatus(goal, 'blocked', verification.summary)
          } else {
            const input = admitGoalInput(state, {
              goalId: goal.id,
              kind: 'verifier_failure',
              content: buildVerifierFailurePrompt(
                goal,
                verification.results,
                verification.summary,
                repeatedFailureCount,
              ),
            })
            await appendGoalInput(state, input)
            await goalCoordinatorRef.current.run(goal.id, (signal) => executeGoalLoop(state, goal.id, signal, lease))
          }
        }
      }

      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal } }))
      return { goal, ok: verification.ok, summary: verification.summary }
    } finally {
      // 校验结束后这个 controller 已经 settle：继续留在 ref 里，后续依赖它中止
      // 的路径（stopGoalRun / clearGoal / Esc）会 abort 一个失效对象，真正在跑的
      // 任务反而中止不了。恢复成进入前的值。
      if (abortControllerRef.current === controller) abortControllerRef.current = previousController
      setState((previous) => ({ ...previous, goalVerificationActive: false }))
      lease.release()
    }
  }, [
    abortControllerRef,
    agentOptions,
    createGoalCallbacks,
    currentAuthority,
    executeGoalLoop,
    loopStateRef,
    modelIdRef,
    modelRef,
    permissionModeRef,
    setState,
    thinkingRef,
    turnCoordinatorRef,
  ])

  const pauseActiveGoalOnAbort = useCallback(() => {
    if (loopStateRef.current?.goal?.status !== 'active') return
    try {
      pauseCoreGoal(loopStateRef.current)
      void goalCoordinatorRef.current.interrupt(loopStateRef.current.goal.id)
      setState((previous) => ({
        ...previous,
        goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
      }))
    } catch {
      // 一个非活跃的终止目标不需要中止时的状态变更。
    }
  }, [loopStateRef, setState])

  return {
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
  }
}
