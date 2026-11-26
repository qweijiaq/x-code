// @x-code-cli/core — Plan 模式与 todoWrite 工具处理器。
//
// 从 tool-execution.ts 抽出，以免 handleToolCall 体积失控。每个处理器遵循同一契约：
// 修改 state + 通过 pushToolResult 推送结果，并返回 void。
import type { ModelMessage } from 'ai'

import type { AgentCallbacks, AgentOptions, TodoItem } from '../types/index.js'
import { extractText } from '../utils/message-helpers.js'
import { markExpectedCacheMiss } from './cache-stats.js'
import type { LoopState } from './loop-state.js'
import { toolErrorString } from './messages.js'
import { generateTaskSlug, makePlanFilePath, readPlan, writePlan } from './plan-storage.js'

type PushToolResult = (
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
) => void

function lastUserMessageText(messages: LoopState['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      return extractText(m.content)
    }
  }
  return ''
}

const VALID_TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed']

export async function handleTodoWrite(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  type RawTodo = { content?: unknown; activeForm?: unknown; status?: unknown }
  // 模型可以给出任何 JSON：非数组、null 元素或非字符串字段都会让朴素的
  // `for (const t of raw)` / `t.content.trim()` 抛 TypeError，异常会冒泡出处理器，
  // 模型连一个可自我修正的工具错误都拿不到。
  const raw: RawTodo[] = Array.isArray(input.todos) ? (input.todos as RawTodo[]) : []
  const normalized: TodoItem[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const record = t as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    const activeForm = typeof record.activeForm === 'string' ? record.activeForm.trim() : ''
    if (!content && !activeForm) continue
    // 非法状态过去会原样写进 state：`acc[t.status]++` 得到 NaN 并污染统计，
    // 该项既不算 completed 也不算 in_progress，清单永远清不掉，UI 面板还会渲染
    // 出未知状态。回落成 pending（下面的回显让模型看到修正后的状态）。
    const status = VALID_TODO_STATUSES.includes(record.status as TodoItem['status'])
      ? (record.status as TodoItem['status'])
      : 'pending'
    normalized.push({
      content: content || activeForm,
      activeForm: activeForm || content,
      status,
    })
  }
  const allDone = normalized.length > 0 && normalized.every((t) => t.status === 'completed')
  const activeCount = normalized.filter((t) => t.status === 'in_progress').length
  if (normalized.length === 0 || (!allDone && activeCount !== 1)) {
    const reason =
      normalized.length === 0
        ? 'the checklist must contain at least one item'
        : `an active checklist must contain exactly one in_progress item; received ${activeCount}`
    pushToolResult(state, callbacks, toolCallId, 'todoWrite', toolErrorString(reason), true)
    return
  }
  state.todos = allDone ? [] : normalized
  callbacks.onTodosUpdate(state.todos)
  const dropped = raw.length - normalized.length
  const droppedNote =
    dropped > 0
      ? ` ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} dropped because they had neither content nor activeForm — please include both fields next time so the user sees clean labels.`
      : ''
  // 把结果清单状态回显给模型（Claude Code 出于同样原因返回 old/new todos）：
  // 一份可见的状态摘要让这次调用从“发完即忘的记账”变成反馈回路，
  // 模型可以据此核对它心中的清单。
  const counts = normalized.reduce(
    (acc, t) => {
      acc[t.status]++
      return acc
    },
    { pending: 0, in_progress: 0, completed: 0 },
  )
  const VERIFY_RE = /\b(verif|test|check|lint|build|typecheck|tsc)\b/i
  const needsVerifyNudge =
    allDone &&
    normalized.length >= 3 &&
    !normalized.some((t) => VERIFY_RE.test(t.content) || VERIFY_RE.test(t.activeForm))
  const verifyNote = needsVerifyNudge
    ? ' Before wrapping up, verify your work — run tests, lint, or type-check as appropriate for this project.'
    : ''
  const explanation = typeof input.explanation === 'string' ? input.explanation.trim() : ''
  const explanationNote = explanation ? ` Note: ${explanation}` : ''
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'todoWrite',
    allDone
      ? `All todos completed (${normalized.length} items). Checklist cleared.${explanationNote}${verifyNote}${droppedNote}`
      : `Todo list updated (${counts.in_progress} in_progress, ${counts.pending} pending, ${counts.completed} completed).${explanationNote} Mark each item completed IMMEDIATELY when its work finishes — do not batch updates.${droppedNote}`,
  )
}

export async function handleEnterPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
): Promise<void> {
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      'Already in plan mode. Continue the conversation; call exitPlanMode when the user has asked for an implementation and you have a plan ready.',
    )
    return
  }
  const decision = await callbacks.onAskPermission({ toolCallId, toolName: 'enterPlanMode', input })
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, 'enterPlanMode', '[Tool execution interrupted by user]', true)
    return
  }
  if (decision === 'no' || typeof decision === 'object') {
    const feedback = typeof decision === 'object' ? decision.feedback.trim() : ''
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'enterPlanMode',
      `User declined to enter plan mode.${feedback ? ` User feedback: ${feedback}.` : ''} Continue with the user's request in default mode — make whatever edits or shell calls the task requires (subject to per-tool permission).`,
      true,
    )
    return
  }
  state.permissionMode = 'plan'
  state.systemPromptCache = null
  markExpectedCacheMiss(state, 'permission-mode-change')
  if (!state.currentPlanPath) {
    const topic = (input.topic as string | undefined)?.trim()
    const fallbackText = lastUserMessageText(state.messages)
    // `topic` 是模型可控的工具入参，直接当 slug 用会让 `../../../../.ssh/authorized_keys`
    // 之类的值把计划文件写到项目之外——而 plan 模式下被放行的写入目标正是这个路径。
    // state.taskSlug 走的已经是 generateTaskSlug，这里与之对齐。
    const topicSlug = topic && topic.length > 0 ? generateTaskSlug(topic) : ''
    const explicitSlug = topicSlug || state.taskSlug || undefined
    state.currentPlanPath = makePlanFilePath(fallbackText, { slug: explicitSlug, projectCwd: state.projectCwd })
  }
  callbacks.onPlanModeChange('plan')
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'enterPlanMode',
    [
      'Entered plan mode (user approved).',
      '',
      'Read-only tools are unrestricted (readFile, glob, grep, listDir, webSearch, webFetch).',
      `Plan file path for this session: ${state.currentPlanPath}`,
      'Use writeFile/edit on the plan file to build your plan; do NOT edit any other files',
      'or run state-changing shell commands until the user approves your plan via exitPlanMode.',
      '',
      'Workflow: explore → update plan file → askUser → repeat.',
      '',
      'CRITICAL: when the plan is ready, call **exitPlanMode** to request approval — NOT',
      'askUser. askUser cannot leave plan mode no matter how the user answers; only',
      'exitPlanMode flips the mode and unblocks your writeFile/edit/shell calls.',
    ].join('\n'),
  )
}

export async function handleExitPlanMode(
  input: Record<string, unknown>,
  toolCallId: string,
  state: LoopState,
  callbacks: AgentCallbacks,
  pushToolResult: PushToolResult,
  /** 本轮迭代的延迟消息队列。批准后注入的那条 user 消息必须走它：exitPlanMode
   *  可能与同批次其他 tool_call 一起分发（`processToolCalls` 按批次处理），就地
   *  推 `state.messages` 会形成 `assistant → tool result → user → tool result`，
   *  DeepSeek 等严格顺序提供方会以 400 拒绝。缺失时退回就地推入（直接调用
   *  处理器、没有迭代队列的场景）。 */
  deferred?: ModelMessage[],
): Promise<void> {
  if (state.permissionMode !== 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString('not in plan mode. exitPlanMode is only valid when the session is in plan mode.'),
      true,
    )
    return
  }
  const planPath =
    state.currentPlanPath ??
    makePlanFilePath(lastUserMessageText(state.messages), {
      slug: state.taskSlug || undefined,
      projectCwd: state.projectCwd,
    })
  state.currentPlanPath = planPath
  const planOverride = (input.plan as string | undefined)?.trim()
  let planBody = planOverride ?? ''
  if (!planBody) {
    planBody = (await readPlan(planPath)).trim()
  }
  if (!planBody) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      toolErrorString(
        `the plan file at ${planPath} is empty. Write your plan to that file using writeFile or edit, then call exitPlanMode again.`,
      ),
      true,
    )
    return
  }

  let savedPath: string | null = planPath
  if (planOverride) {
    try {
      savedPath = await writePlan(planPath, planBody, state.projectCwd)
      state.currentPlanPath = savedPath
    } catch {
      // 非致命——批准对话框使用内存中的正文。但必须让下游知道磁盘上没有副本：
      // 否则批准成功后还会告诉模型“计划已保存在 <path>”，它会去读一个不存在
      // 或陈旧的文件。
      savedPath = null
    }
  }

  const approved = await callbacks.onPlanApprovalRequest(planBody)
  if (approved) {
    state.permissionMode = 'acceptEdits'
    state.systemPromptCache = null
    markExpectedCacheMiss(state, 'permission-mode-change')
    // 右操作数 `state.currentPlanPath` 是死代码：没有 override 时 savedPath 已经是
    // planPath，有 override 时失败必须表现为“未落盘”（见上面的 catch）。
    const persisted = savedPath
    state.currentPlanPath = null
    callbacks.onPlanModeChange('acceptEdits')
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      'exitPlanMode',
      [
        'Plan approved by user. Plan mode has been exited.',
        persisted
          ? `The approved plan is saved at: ${persisted}`
          : 'The approved plan could not be written to disk — work from the plan text the user approved, do not try to read a plan file.',
        'You can now edit files and run shell commands. Start implementing the plan.',
        '',
        'For multi-step plans, call **todoWrite** first to break the plan into a',
        'tracked checklist — the user sees a live panel of your progress and you',
        'avoid losing track of remaining steps mid-implementation.',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    const exitedPlanModeMessage: ModelMessage = {
      role: 'user',
      content: [
        '## Exited Plan Mode',
        '',
        'You have exited plan mode. You can now make edits, run tools, and take actions.',
        'Write tools (writeFile, edit) are now auto-approved (acceptEdits mode); shell commands',
        'still go through normal permission classification.',
        persisted
          ? `The plan file is located at ${persisted} if you need to reference it.`
          : 'The plan file could not be written to disk; do not rely on reading it.',
      ]
        .filter(Boolean)
        .join('\n'),
    }
    if (deferred) deferred.push(exitedPlanModeMessage)
    else state.messages.push(exitedPlanModeMessage)
    return
  }
  pushToolResult(
    state,
    callbacks,
    toolCallId,
    'exitPlanMode',
    [
      'Plan rejected by user. You are still in plan mode.',
      "Read the user's next message for feedback, revise the plan accordingly,",
      'and call exitPlanMode again with the revised body. Consider asking the user',
      'a clarifying question via askUser if you are unsure what to change.',
    ].join('\n'),
    true,
  )
}
