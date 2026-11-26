import { TOOL_SEARCH_TOOL_NAME } from '@x-code-cli/core'
import type { AgentCallbacks, DisplayMessage, DisplayToolCall, EditDiffPayload } from '@x-code-cli/core'

import { isCollapsibleReadOnlyTool } from '../utils.js'
import type { AgentState } from './types.js'
import { isPassiveShellWait, previewSubInput } from './use-agent-display.js'

interface MutableRef<T> {
  current: T
}

type PendingTool = { toolName: string; input: Record<string, unknown>; startedAt: number }
type StateUpdate = AgentState | ((previous: AgentState) => AgentState)

export interface ToolLifecycleDependencies {
  setState: (update: StateUpdate) => void
  flushBuffer: () => void
  pendingToolsRef: MutableRef<Map<string, PendingTool>>
  pendingEditDiffsRef: MutableRef<Map<string, EditDiffPayload>>
  now?: () => number
}

export type ToolLifecycleCallbacks = Pick<
  AgentCallbacks,
  'onToolCall' | 'onToolProgress' | 'onFileEdit' | 'onToolResult' | 'onSubAgentEvent' | 'onShellOutput'
>

export type GoalToolLifecycleCallbacks = Pick<AgentCallbacks, 'onToolCall' | 'onToolProgress' | 'onToolResult'>

/** 子代理的收尾状态标签。core 在崩溃路径（`completionOutcome = 'failed'`）仍然
 *  以 `aborted: false` 上报 `kind: 'end'`，只在 `finalText` 前面加标记，所以
 *  失败的子代理不能只看 `aborted`——否则界面会显示成 “Done”。 */
function subAgentStatusLabel(event: { aborted: boolean; finalText: string }): string {
  if (event.aborted) return 'Aborted'
  if (event.finalText.startsWith('[Sub-agent failed: ')) return 'Failed'
  return 'Done'
}

/** shell 输出面板只在屏幕上显示尾部，但事件按字节预算分片、每秒可能来几十个
 *  chunk；不设上限就是 O(n²) 的字符串拷贝 + 无界内存增长。 */
export const SHELL_OUTPUT_MAX_CHARS = 100_000

export function appendShellOutput(previous: string, chunk: string): string {
  const next = previous + chunk
  return next.length > SHELL_OUTPUT_MAX_CHARS ? next.slice(next.length - SHELL_OUTPUT_MAX_CHARS) : next
}

function createToolProgressCallback(setState: ToolLifecycleDependencies['setState']): AgentCallbacks['onToolProgress'] {
  return (toolCallId, message) => {
    setState((previous) => {
      const index = previous.activeToolCalls.findIndex((tool) => tool.id === toolCallId)
      if (index < 0) return previous
      const activeToolCalls = previous.activeToolCalls.slice()
      activeToolCalls[index] = { ...activeToolCalls[index], progress: message }
      return { ...previous, activeToolCalls }
    })
  }
}

/** 模块级自增序号：与毫秒时间戳叠加，保证同一毫秒内完成的多个工具消息
 *  （并行工具调用、或时钟回拨）仍有唯一的消息/工具 id。列表渲染与滚动缓冲
 *  依赖这个 id 作为身份，重复会让两条消息被当成同一条。 */
let toolMessageSeq = 0

function nextToolMessageUid(completedAt: number): string {
  toolMessageSeq += 1
  return `${completedAt}-${toolMessageSeq}`
}

function createCompletedToolMessage(
  pending: PendingTool,
  result: string,
  isError: boolean | undefined,
  durationMs: number,
  completedAt: number,
  editPayload?: EditDiffPayload,
): DisplayMessage {
  // 一次取时间戳 + 自增序号：id 与 timestamp 必须描述同一条完成记录。
  const uid = nextToolMessageUid(completedAt)
  const toolCall: DisplayToolCall = {
    id: `tc-${uid}`,
    toolName: pending.toolName,
    input: pending.input,
    output: result,
    status: isError ? 'error' : 'completed',
    durationMs,
    ...(editPayload ? { editPayload } : {}),
  }
  return {
    id: `tool-${uid}`,
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
    timestamp: completedAt,
  }
}

/** 只在没有其它活跃工具时清空 shell 输出面板：并行工具里先返回的那个
 *  不能把另一个仍在跑（且正在往里写）的 shell 输出抹掉。 */
function shellOutputAfterRemoval(previous: AgentState, toolCallId: string): string {
  const remaining = previous.activeToolCalls.filter((tool) => tool.id !== toolCallId)
  return remaining.length === 0 ? '' : previous.shellOutput
}

export function createToolLifecycleCallbacks({
  setState,
  flushBuffer,
  pendingToolsRef,
  pendingEditDiffsRef,
  now = Date.now,
}: ToolLifecycleDependencies): ToolLifecycleCallbacks {
  const onToolProgress = createToolProgressCallback(setState)

  return {
    onToolCall: (toolCallId, toolName, input) => {
      flushBuffer()
      pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: now() })

      // toolSearch 是一个内部的延迟工具加载器。把它同时排除在实时工具列表和
      // scrollback 之外，同时保留其待处理记录，让 onToolResult 能识别并丢弃
      // 匹配的结果。
      if (toolName === TOOL_SEARCH_TOOL_NAME || isPassiveShellWait({ toolName, input })) return

      const isReadOnly = isCollapsibleReadOnlyTool(toolName)
      setState((previous) => ({
        ...previous,
        activeToolCalls: [...previous.activeToolCalls, { id: toolCallId, toolName, input }],
        bufferingReads: isReadOnly,
      }))
    },
    onToolProgress,
    onFileEdit: (toolCallId, payload) => {
      pendingEditDiffsRef.current.set(toolCallId, payload)
    },
    onToolResult: (toolCallId, result, isError) => {
      const pending = pendingToolsRef.current.get(toolCallId)
      pendingToolsRef.current.delete(toolCallId)
      const editPayload = pendingEditDiffsRef.current.get(toolCallId)
      pendingEditDiffsRef.current.delete(toolCallId)

      if (pending?.toolName === TOOL_SEARCH_TOOL_NAME) return

      if (!pending) {
        // 没有待处理记录说明这条调用的 UI 记录已被中断/新回合清理掉了。
        // 不要伪造一条 `unknown` / `durationMs: 0` 的“已完成”工具消息。
        setState((previous) =>
          previous.activeToolCalls.some((tool) => tool.id === toolCallId)
            ? { ...previous, activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId) }
            : previous,
        )
        return
      }

      if (isPassiveShellWait(pending)) {
        setState((previous) => ({
          ...previous,
          activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId),
          shellOutput: shellOutputAfterRemoval(previous, toolCallId),
        }))
        return
      }

      const completedAt = now()
      const durationMs = completedAt - pending.startedAt
      const message = createCompletedToolMessage(pending, result, isError, durationMs, completedAt, editPayload)
      setState((previous) => ({
        ...previous,
        activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId),
        shellOutput: shellOutputAfterRemoval(previous, toolCallId),
        messages: [...previous.messages, message],
      }))
    },
    onSubAgentEvent: (event) => {
      if (event.kind === 'tool-call') {
        setState((previous) => {
          const index = previous.activeToolCalls.findIndex((tool) => tool.id === event.toolCallId)
          if (index < 0) return previous
          const tool = previous.activeToolCalls[index]!
          const label = `${event.subToolName}: ${previewSubInput((event.subInput as Record<string, unknown>) ?? {})}`
          const history = [...(tool.subToolHistory ?? []), label]
          const activeToolCalls = previous.activeToolCalls.slice()
          activeToolCalls[index] = { ...tool, progress: label, subToolHistory: history }
          return { ...previous, activeToolCalls }
        })
      }
      if (event.kind === 'end') {
        const turnInfo = `${event.turnCount}t`
        const tokenInfo =
          event.tokenUsage.totalTokens > 1000
            ? `${(event.tokenUsage.totalTokens / 1000).toFixed(1)}k tok`
            : `${event.tokenUsage.totalTokens} tok`
        const durationInfo =
          event.durationMs > 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`
        // 中断/失败的子代理不能显示成 “Done”。
        const statusLabel = subAgentStatusLabel(event)
        onToolProgress(event.toolCallId, `${statusLabel} (${turnInfo}, ${tokenInfo}, ${durationInfo})`)
      }
    },
    onShellOutput: (chunk) => {
      setState((previous) => ({ ...previous, shellOutput: appendShellOutput(previous.shellOutput, chunk) }))
    },
  }
}

export function createGoalToolLifecycleCallbacks({
  setState,
  flushBuffer,
  pendingToolsRef,
  now = Date.now,
}: Omit<ToolLifecycleDependencies, 'pendingEditDiffsRef'>): GoalToolLifecycleCallbacks {
  const onToolProgress = createToolProgressCallback(setState)

  return {
    onToolCall: (toolCallId, toolName, input) => {
      flushBuffer()
      pendingToolsRef.current.set(toolCallId, { toolName, input, startedAt: now() })
      setState((previous) => ({
        ...previous,
        activeToolCalls: [...previous.activeToolCalls, { id: toolCallId, toolName, input }],
      }))
    },
    onToolProgress,
    onToolResult: (toolCallId, result, isError) => {
      const pending = pendingToolsRef.current.get(toolCallId)
      pendingToolsRef.current.delete(toolCallId)
      if (!pending) {
        setState((previous) =>
          previous.activeToolCalls.some((tool) => tool.id === toolCallId)
            ? { ...previous, activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId) }
            : previous,
        )
        return
      }

      const completedAt = now()
      const durationMs = completedAt - pending.startedAt
      const message = createCompletedToolMessage(pending, result, isError, durationMs, completedAt)
      setState((previous) => ({
        ...previous,
        activeToolCalls: previous.activeToolCalls.filter((tool) => tool.id !== toolCallId),
        messages: [...previous.messages, message],
      }))
    },
  }
}
