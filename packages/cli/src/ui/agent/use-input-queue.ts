// @x-code-cli/cli — useAgent 的中途回合输入队列。
//
// 在回合进行中到达的纯文本提交（以及 peer 消息）住在这里，直到 agent 循环在
// 下一个工具边界把它们排水（转向）。ref 是事实来源：`consumeQueuedInputs` 由
// agent 循环在 await 之间同步调用，此时读取 React state 会看到过期的闭包——
// 每次变更都在同一个 tick 里镜像进 `state.queuedMessages`。
import { useCallback, useRef } from 'react'

import type { QueuedAgentInput } from '@x-code-cli/core'

import { partitionQueuedInputsForDraft, takeFreshQueuedInput } from './queued-agent-inputs.js'
import type { AgentState, QueuedMessage } from './types.js'

type SetState = (update: AgentState | ((previous: AgentState) => AgentState)) => void

/** 把内部混合队列（用户 + peer 条目）投影到显示侧的待处理列表——只显示用户
 *  条目。 */
function toQueuedUserMessages(queued: readonly QueuedAgentInput[]): QueuedMessage[] {
  return queued
    .filter((message): message is Extract<QueuedAgentInput, { source: 'user' }> => message.source === 'user')
    .map((message) => ({ id: message.id, text: message.display, inject: message.content }))
}

export function useInputQueue(setState: SetState) {
  /** 中途回合消息队列的事实来源。React state 镜像（`state.queuedMessages`）
   *  驱动 ChatInput 的待处理列表。 */
  const queuedMessagesRef = useRef<QueuedAgentInput[]>([])
  const consumedPeerInboxKeysRef = useRef<Set<string>>(new Set())
  /** 排队消息 / 草稿恢复的单调 id 来源。Date.now() 在同一毫秒内会碰撞（而且
   *  `length` 在 pop 之后会重复），这会破坏 React key、按 id 弹出以及 nonce
   *  比较。 */
  const queueSeqRef = useRef(0)

  /** 把一条在回合进行中到达的纯文本提交排队。agent 循环在下一个工具边界
   *  （或 `stop` 时）把它排水。`inject` 覆盖模型看到的内容（显示文本保持干净）。 */
  const queueMessage = useCallback(
    (text: string, inject?: string) => {
      const entry: QueuedAgentInput = {
        id: `queued-${queueSeqRef.current++}`,
        source: 'user',
        display: text,
        content: inject ?? text,
      }
      queuedMessagesRef.current = [...queuedMessagesRef.current, entry]
      setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
    },
    [setState],
  )

  /** 按 id 移除一条排队消息（ChatInput 的 ↑-回弹编辑）。 */
  const popQueuedMessage = useCallback(
    (id: string) => {
      queuedMessagesRef.current = queuedMessagesRef.current.filter(
        (message) => message.source === 'peer' || message.id !== id,
      )
      setState((prev) => ({ ...prev, queuedMessages: toQueuedUserMessages(queuedMessagesRef.current) }))
    },
    [setState],
  )

  /** 排空队列：把每条排队消息作为普通用户消息移到 scrollback，并返回要注入到
   *  `state.messages` 的文本。作为 `consumeQueuedInputs` 传给 agentLoop——必须
   *  保持原子（在一个同步步骤里读 + 清空），这样一条消息绝不会被注入两次。 */
  const consumeQueuedInputs = useCallback((): QueuedAgentInput[] | undefined => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return undefined
    queuedMessagesRef.current = []
    for (const message of queued) {
      if (message.source === 'peer' && message.inboxKey) consumedPeerInboxKeysRef.current.add(message.inboxKey)
    }
    const now = Date.now()
    setState((prev) => ({
      ...prev,
      queuedMessages: [],
      messages: [
        ...prev.messages,
        ...queued.map((message) => ({
          id: message.id,
          role: 'user' as const,
          content: message.display,
          timestamp: now,
          ...(message.source === 'peer'
            ? { kind: 'peer-message' as const, peer: message.peer, peerMessageId: message.messageId }
            : {}),
        })),
      ],
    }))
    return queued
  }, [setState])

  const dequeueFreshInput = useCallback((): QueuedAgentInput | undefined => {
    if (queuedMessagesRef.current.length === 0) return undefined
    const taken = takeFreshQueuedInput(queuedMessagesRef.current)
    const next = taken.next
    if (!next) return undefined
    queuedMessagesRef.current = taken.remaining
    setState((prev) => ({
      ...prev,
      queuedMessages: toQueuedUserMessages(queuedMessagesRef.current),
      messages: [
        ...prev.messages,
        {
          id: next.id,
          role: 'user',
          content: next.display,
          timestamp: Date.now(),
          ...(next.source === 'peer'
            ? { kind: 'peer-message' as const, peer: next.peer, peerMessageId: next.messageId }
            : {}),
        },
      ],
    }))
    return next
  }, [setState])

  /** 把所有仍排队的消息作为单个合并草稿移回输入框（Codex 的 input_restore
   *  语义——Esc 时零丢失）。由 abort() 以及 submit 的中止完成路径使用，用于
   *  在 abort() 已经运行之后竞态进入的消息。 */
  const restoreQueueToDraft = useCallback(() => {
    const queued = queuedMessagesRef.current
    if (queued.length === 0) return
    const { draft, retained } = partitionQueuedInputsForDraft(queued)
    queuedMessagesRef.current = retained
    if (!draft) return
    setState((prev) => ({ ...prev, queuedMessages: [], restoredDraft: { text: draft, nonce: queueSeqRef.current++ } }))
  }, [setState])

  return {
    queuedMessagesRef,
    consumedPeerInboxKeysRef,
    queueSeqRef,
    queueMessage,
    popQueuedMessage,
    consumeQueuedInputs,
    dequeueFreshInput,
    restoreQueueToDraft,
  }
}
