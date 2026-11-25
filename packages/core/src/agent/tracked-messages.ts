import type { ModelMessage } from 'ai'

import type { ExecutionAuthority, MessageProvenance, TrackedModelMessage } from '../types/index.js'
import type { LoopState } from './loop-state.js'
import {
  createTrackedMessage,
  deriveContextSecurity,
  effectiveExecutionAuthority,
  provenanceForAuthority,
} from './provenance.js'

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

function isArrayIndex(property: PropertyKey): property is string {
  return typeof property === 'string' && ARRAY_INDEX.test(property)
}

/** 派生 provenance 之前必须先把已派生的 `contextSecurity` 合进 authority——与
 *  `tool-execution.ts`（253/354/404）和 `session-store.ts`（1296/1874）保持一致。
 *  只读 `state.executionAuthority` 会在「新污染 entry 已追加、但下一次外部刷新还没
 *  发生」的窗口里继续用过期的 clean authority，把受 peer 影响的内容标成
 *  `{ authority: 'user', derivedFromPeer: false }`，形成污点传播漏报。 */
function currentAuthority(state: LoopState): ExecutionAuthority {
  return effectiveExecutionAuthority(state.executionAuthority, state.contextSecurity)
}

function recalculate(state: LoopState): void {
  const derived = deriveContextSecurity(state.trackedMessages)
  state.contextSecurity = state.contextSecurity.integrityFailure
    ? { ...derived, peerInfluenceActive: true, integrityFailure: true }
    : derived
}

export function appendTrackedMessage(
  state: LoopState,
  message: ModelMessage,
  provenance = provenanceForAuthority(currentAuthority(state), message.role),
): TrackedModelMessage {
  const entry = createTrackedMessage(message, provenance)
  state.trackedMessages.push(entry)
  recalculate(state)
  return entry
}

export function replaceTrackedMessages(
  state: LoopState,
  messages: readonly ModelMessage[],
  fallbackProvenance?: MessageProvenance,
): void {
  const byIdentity = new Map<ModelMessage, TrackedModelMessage[]>()
  for (const entry of state.trackedMessages) {
    const matches = byIdentity.get(entry.message) ?? []
    matches.push(entry)
    byIdentity.set(entry.message, matches)
  }
  state.trackedMessages = messages.map((message) => {
    const matches = byIdentity.get(message)
    const retained = matches?.shift()
    return (
      retained ??
      createTrackedMessage(message, fallbackProvenance ?? provenanceForAuthority(currentAuthority(state), message.role))
    )
  })
  recalculate(state)
}

/** 供现有 provider/message 辅助函数使用的兼容视图。它自己不存任何消息数据：
 *  每次下标与长度操作都投影到跟踪转录上。结构性变换应直接使用跟踪条目，
 *  使搬移能保持 entryId/provenance 在一起。 */
export function createModelMessageView(state: LoopState): ModelMessage[] {
  const target: ModelMessage[] = []
  const syncTargetLength = (): void => {
    if (target.length !== state.trackedMessages.length) target.length = state.trackedMessages.length
  }
  return new Proxy(target, {
    get(_target, property, receiver) {
      if (property === 'length') return state.trackedMessages.length
      if (isArrayIndex(property)) return state.trackedMessages[Number(property)]?.message
      syncTargetLength()
      return Reflect.get(receiver === target ? target : target, property, receiver)
    },
    set(_target, property, value) {
      if (property === 'length') {
        const length = Number(value)
        if (!Number.isSafeInteger(length) || length < 0) return false
        state.trackedMessages.length = length
        recalculate(state)
        return true
      }
      if (isArrayIndex(property)) {
        const index = Number(property)
        const message = value as ModelMessage
        const existing = state.trackedMessages[index]
        // 只有「原样重写同一条消息对象」才保留原 entry 的 entryId 与 provenance。
        // Array 原型的 unshift/splice 靠逐个下标 `set(i + 1, get(i))` 搬移消息：
        // 若这里无条件沿用 existing，那么每个下标保留的都是【原下标】的 provenance，
        // 而内容已经换成别处搬来的消息——一条本应 derivedFromPeer 的 peer 污染消息
        // 会落到持有 clean provenance 的下标上，recalculate() 因此漏报 peer 影响，
        // firstTaintedEntryId / canonicalTranscriptDigest 的审计语义也随之失效。
        state.trackedMessages[index] =
          existing?.message === message
            ? existing
            : createTrackedMessage(message, provenanceForAuthority(currentAuthority(state), message.role))
        recalculate(state)
        return true
      }
      return Reflect.set(target, property, value)
    },
    deleteProperty(_target, property) {
      if (!isArrayIndex(property)) return Reflect.deleteProperty(target, property)
      state.trackedMessages.splice(Number(property), 1)
      recalculate(state)
      return true
    },
    has(_target, property) {
      if (property === 'length') return true
      if (isArrayIndex(property)) return Number(property) < state.trackedMessages.length
      return Reflect.has(target, property)
    },
    ownKeys() {
      syncTargetLength()
      return [...state.trackedMessages.map((_, index) => String(index)), 'length']
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === 'length') {
        syncTargetLength()
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
      if (isArrayIndex(property) && Number(property) < state.trackedMessages.length) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: state.trackedMessages[Number(property)]?.message,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
  })
}

export function setTrackedTranscript(state: LoopState, entries: readonly TrackedModelMessage[]): void {
  state.trackedMessages = entries.map((entry) => structuredClone(entry))
  recalculate(state)
}

export function recalculateContextSecurity(state: LoopState): void {
  recalculate(state)
}
