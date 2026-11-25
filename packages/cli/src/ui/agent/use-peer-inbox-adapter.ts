import { useCallback, useEffect, useRef, useState } from 'react'

import { errorMessage } from '@x-code-cli/core'
import type { HeldPeerMessage, PeerInboxSnapshot, PeerService, PublicPeer } from '@x-code-cli/core'

import type { TurnOwner } from './turn-coordinator.js'

export interface PeerInboxAdapterOptions {
  service?: PeerService
  activeOwner: () => TurnOwner | null
  dialogsBlocked: boolean
  enqueuePeerInput(input: { content: string; peer: PublicPeer; messageId: string; inboxKey: string }): boolean
  addPeerStatus(content: string, peer?: PublicPeer): void
  addHeldPeerPreview(content: string, peer: PublicPeer, summary?: string): void
  askQuestion(
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean; layout?: 'compact' | 'compact-vertical' },
  ): Promise<string>
}

const EMPTY_SNAPSHOT: PeerInboxSnapshot = {
  accepted: 0,
  held: 0,
  deliveryUpdates: 0,
  pendingFinalUpdates: 0,
  droppedDeliveryNotifications: 0,
  droppedFinalUpdates: 0,
  inboundLedger: 0,
  outboundLedger: 0,
  activeOutbound: 0,
  revision: 0,
}

export function blocksPeerClaim(owner: TurnOwner | null): boolean {
  return owner === 'goal' || owner === 'compact' || owner === 'resume' || owner === 'rewind' || owner === 'clear'
}

export function formatDeliveryUpdateStatus(update: {
  messageId: string
  status: 'delivered' | 'denied' | 'expired' | 'final-status-unknown'
  peer: PublicPeer
}): string {
  if (update.status === 'final-status-unknown') {
    return `Message ${update.messageId.slice(0, 8)}: PEER_FINAL_STATUS_UNKNOWN for ${update.peer.name}; it was held, but the final accept/refuse result is unknown.`
  }
  const label = update.status === 'delivered' ? 'accepted' : update.status
  return `Message ${update.messageId.slice(0, 8)}: ${label} by ${update.peer.name}.`
}

export function transferAcceptedToAgentQueue(
  service: PeerService,
  enqueuePeerInput: PeerInboxAdapterOptions['enqueuePeerInput'],
  limit = 50,
): number {
  let transferred = 0
  while (transferred < limit) {
    const claim = service.claimAccepted(1)
    if (!claim) break
    const message = claim.messages[0]
    const key = claim.keys[0]
    let accepted = false
    if (message && key) {
      // `enqueuePeerInput` 是调用方注入的回调，可能抛异常而不是返回 false。不兜住
      // 的话 `claimAccepted` 取到的 claim 既走不到 commit 也走不到 release，这条
      // 已接受的消息会被困在 claim 里直到 `expiresAt` 过期，异常还会冒泡打断本轮
      // 后续（held 弹窗都不再出现）。
      try {
        accepted = enqueuePeerInput({
          content: message.text,
          peer: message.from,
          messageId: message.id,
          inboxKey: key,
        })
      } catch {
        accepted = false
      }
    }
    if (!accepted) {
      service.releaseAcceptedClaim(claim.claimId)
      break
    }
    service.commitAcceptedClaim(claim.claimId)
    transferred++
  }
  return transferred
}

function heldPrompt(entry: HeldPeerMessage): string {
  const summary = entry.message.summary ? ` Summary: ${entry.message.summary}` : ''
  return `Accept held message from ${entry.message.from.name} (${entry.message.from.address})?${summary}`
}

export function usePeerInboxAdapter(options: PeerInboxAdapterOptions): PeerInboxSnapshot {
  const { service, activeOwner, dialogsBlocked, enqueuePeerInput, addPeerStatus, addHeldPeerPreview, askQuestion } =
    options
  const [snapshot, setSnapshot] = useState(() => service?.inbox.getSnapshot() ?? EMPTY_SNAPSHOT)
  const [pumpTick, setPumpTick] = useState(0)
  const heldDialogKeyRef = useRef<string | null>(null)

  const pump = useCallback(() => {
    if (!service || !service.isAvailable()) return

    const updateClaim = service.claimDeliveryUpdates(32)
    if (updateClaim) {
      try {
        for (const update of updateClaim.updates) {
          addPeerStatus(formatDeliveryUpdateStatus(update), update.peer)
        }
        service.commitDeliveryUpdateClaim(updateClaim.claimId)
      } catch {
        service.releaseDeliveryUpdateClaim(updateClaim.claimId)
      }
    }

    // UI 被阻塞（或当前 turn 属于不该被 peer 消息打断的 owner）时只刷新状态、
    // 不向 agent 投递：accepted 消息留在服务端队列里，等 UI 空闲后下一轮 pump 再取。
    if (dialogsBlocked || blocksPeerClaim(activeOwner())) return

    let held: HeldPeerMessage | undefined
    try {
      transferAcceptedToAgentQueue(service, enqueuePeerInput)
      held = service.listHeld()[0]
    } catch {
      // 投递 / 读取 held 队列失败：本轮什么都不做，等下一次 inbox 变更重试。
      // 这里不向用户抛错——这是后台泵，不该打断对话。
      return
    }
    if (!held || heldDialogKeyRef.current) return
    heldDialogKeyRef.current = held.key
    // `queue-full` 时消息仍留在 held 队列（没有被消费也没有终态），此时若照旧在
    // finally 里触发下一轮 pump，`listHeld()[0]` 又是同一条消息 → 再弹一次窗，
    // 形成「接受 → queue-full → 立刻重新询问」的死循环（队列不空就无法退出）。
    let repump = true
    addHeldPeerPreview(held.message.text, held.message.from, held.message.summary)
    void askQuestion(
      heldPrompt(held),
      [
        { label: 'Accept', description: 'Queue this plain-text message for the agent.' },
        { label: 'Refuse', description: 'Reject it and notify the sender.' },
      ],
      { noOther: true, layout: 'compact-vertical' },
    )
      .then(async (answer) => {
        // 只认显式选项。Esc / 关闭对话框可能返回空串或任意值，把它当成「拒绝」会
        // 向对端发出不可逆的 denied 终态——未知答案一律视为取消并保留 held 消息。
        if (answer !== 'Accept' && answer !== 'Refuse') return
        const result = await service.decideHeld(held.key, answer === 'Accept' ? 'accept' : 'reject')
        if (result.status === 'accepted') {
          addPeerStatus(`Accepted held message from ${held.message.from.name}.`, held.message.from)
        } else if (result.status === 'rejected') {
          addPeerStatus(`Refused held message from ${held.message.from.name}.`, held.message.from)
        } else if (result.status === 'queue-full') {
          // 消息仍处于 held 状态（见 core/peers/inbox.ts 的 `decideHeld`）：如实
          // 告知用户「稍后重试」，并跳过本轮的立即重泵。
          repump = false
          addPeerStatus(
            `Accepted queue is full; held message from ${held.message.from.name} stays pending.`,
            held.message.from,
          )
        } else {
          // not-found / already-decided：已有终态或被别的路径处理掉，无需重问。
          addPeerStatus(`Held message already resolved (${result.status}).`, held.message.from)
        }
      })
      .catch((error: unknown) => {
        // 决策链上的异常（decideHeld 抛错等）不能变成 unhandled rejection，也不能
        // 让用户什么都看不到。
        addPeerStatus(`Held message decision failed: ${errorMessage(error)}`, held.message.from)
      })
      .finally(() => {
        heldDialogKeyRef.current = null
        // `queue-full` 时不要立刻重问（会死循环）；其它情况照旧推进一轮，
        // 让下一条 held 消息（若有）也能被处理。
        if (repump) setPumpTick((value) => value + 1)
      })
  }, [activeOwner, addHeldPeerPreview, addPeerStatus, askQuestion, dialogsBlocked, enqueuePeerInput, service])

  useEffect(() => {
    if (!service) return
    const unsubscribe = service.onInboxChanged((next) => {
      setSnapshot(next)
      pump()
    })
    pump()
    return unsubscribe
  }, [service, pump])

  useEffect(() => {
    pump()
  }, [dialogsBlocked, pump, pumpTick, snapshot.revision])

  return snapshot
}
