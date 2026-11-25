import { createHash, randomUUID } from 'node:crypto'

import type { ModelMessage } from 'ai'

import type {
  ContextSecurityState,
  ExecutionAuthority,
  MessageProvenance,
  PeerOrigin,
  PeerOriginSummary,
  TrackedModelMessage,
} from '../types/index.js'

export const MAX_PEER_ORIGIN_ITEMS = 16

const CLEAN_PROVENANCE: MessageProvenance = {
  authority: 'internal',
  derivedFromPeer: false,
}

function originKey(origin: PeerOrigin): string {
  return `${origin.instanceId}\u0000${origin.messageId}\u0000${origin.nameAtReceipt}`
}

/** 对“排序后的 origin 键集合 + 总数”做一次域分隔的 SHA-256。
 *
 *  不能用逐个 hash 再 XOR 累加：XOR 是线性的，攻击者（`messageId` /
 *  `nameAtReceipt` 完全由对端控制）只要提供 ≥257 条 origin 就能用高斯消元找到
 *  异或为任意目标值的子集，从而伪造摘要；合并两个有交集的集合时共有元素还会被
 *  抵消，让合并结果承诺一个“对称差”而不是并集。 */
function hashOriginKeys(keys: readonly string[], totalCount: number): string {
  const hash = createHash('sha256')
  hash.update('peer-origins\u0000')
  for (const key of keys) hash.update(`${key.length}\u0000${key}\u0000`)
  hash.update(`count\u0000${totalCount}`)
  return hash.digest('hex')
}

export function canonicalSecurityJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Non-finite transcript number')
      return item
    }
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) {
      throw new Error('Unsupported transcript value')
    }
    // 数组同样要登记：自引用数组此前会一路递归到 RangeError
    // （"Maximum call stack size exceeded"），而不是预期的 Cyclic 错误。
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new Error('Cyclic transcript value')
      seen.add(item)
      const normalizedArray = item.map(normalize)
      seen.delete(item)
      return normalizedArray
    }
    if (typeof item !== 'object') throw new Error('Unsupported transcript value')
    if (seen.has(item)) throw new Error('Cyclic transcript value')
    seen.add(item)
    const record = item as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      // 模型 SDK 对象常把可选的自身属性保留为 undefined。
      // JSONL 持久化会省略它们，因此按同样的形状计算摘要。
      if (record[key] !== undefined) normalized[key] = normalize(record[key])
    }
    seen.delete(item)
    return normalized
  }
  return JSON.stringify(normalize(value))
}

export function summarizePeerOrigins(origins: readonly PeerOrigin[]): PeerOriginSummary | undefined {
  if (origins.length === 0) return undefined
  const unique = new Map<string, PeerOrigin>()
  for (const origin of origins) {
    const normalized = {
      instanceId: origin.instanceId.slice(0, 128),
      nameAtReceipt: origin.nameAtReceipt.slice(0, 64),
      messageId: origin.messageId.slice(0, 128),
    }
    unique.set(originKey(normalized), normalized)
  }
  const entries = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    items: entries.slice(0, MAX_PEER_ORIGIN_ITEMS).map(([, origin]) => origin),
    totalCount: entries.length,
    digest: hashOriginKeys(
      entries.map(([key]) => key),
      entries.length,
    ),
    truncated: entries.length > MAX_PEER_ORIGIN_ITEMS,
  }
}

export function mergePeerOriginSummaries(
  summaries: readonly (PeerOriginSummary | undefined)[],
): PeerOriginSummary | undefined {
  const distinct = new Map<string, PeerOriginSummary>()
  for (const summary of summaries) {
    if (summary) distinct.set(`${summary.digest}:${summary.totalCount}`, summary)
  }
  const values = [...distinct.values()]
  if (values.length === 0) return undefined
  if (values.length === 1) return structuredClone(values[0]!)
  const visible = values.flatMap((summary) => summary.items)

  const unique = new Map<string, PeerOrigin>()
  for (const origin of visible) unique.set(originKey(origin), origin)
  const sorted = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b))
  const duplicateVisibleCount = visible.length - unique.size
  const totalCount = Math.max(
    unique.size,
    values.reduce((sum, summary) => sum + summary.totalCount, 0) - duplicateVisibleCount,
  )
  const digest = hashOriginKeys(
    sorted.map(([key]) => key),
    totalCount,
  )
  return {
    items: sorted.slice(0, MAX_PEER_ORIGIN_ITEMS).map(([, origin]) => origin),
    totalCount,
    digest,
    truncated: totalCount > MAX_PEER_ORIGIN_ITEMS || values.some((summary) => summary.truncated),
  }
}

export function provenanceForAuthority(
  authority: ExecutionAuthority,
  messageRole: ModelMessage['role'],
): MessageProvenance {
  const peerOrigins = authority.peerOrigins
  // fail-closed：`source: 'peer'` 本身就是污点，即使 peerTainted 为 false。调用方
  // 可以直接构造这种组合（不经过 effectiveExecutionAuthority），此时对端消息会被
  // 记为 authority:'user' 并把来源摘要丢掉——对端来源被洗白。
  const tainted = authority.peerTainted || authority.source === 'peer'
  if (messageRole === 'user') {
    return tainted
      ? { authority: authority.source, derivedFromPeer: true, ...(peerOrigins ? { peerOrigins } : {}) }
      : { authority: 'user', derivedFromPeer: false }
  }
  return tainted
    ? { authority: 'internal', derivedFromPeer: true, ...(peerOrigins ? { peerOrigins } : {}) }
    : { ...CLEAN_PROVENANCE }
}

export function createTrackedMessage(
  message: ModelMessage,
  provenance: MessageProvenance,
  entryId: string = randomUUID(),
): TrackedModelMessage {
  return {
    entryId,
    message,
    provenance: structuredClone(provenance),
  }
}

export function mergeProvenance(entries: readonly TrackedModelMessage[]): MessageProvenance {
  const derivedFromPeer = entries.some((entry) => entry.provenance.derivedFromPeer)
  const peerOrigins = derivedFromPeer
    ? mergePeerOriginSummaries(entries.map((entry) => entry.provenance.peerOrigins))
    : undefined
  return {
    authority: 'internal',
    derivedFromPeer,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function deriveContextSecurity(entries: readonly TrackedModelMessage[]): ContextSecurityState {
  const tainted = entries.filter((entry) => entry.provenance.derivedFromPeer)
  if (tainted.length === 0) return { peerInfluenceActive: false }
  const peerOrigins = mergePeerOriginSummaries(tainted.map((entry) => entry.provenance.peerOrigins))
  return {
    peerInfluenceActive: true,
    firstTaintedEntryId: tainted[0]!.entryId,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function effectiveExecutionAuthority(
  requested: ExecutionAuthority | undefined,
  context: ContextSecurityState,
): ExecutionAuthority {
  const base = requested ?? { source: 'user', peerTainted: false }
  const peerTainted = base.peerTainted || context.peerInfluenceActive || context.integrityFailure === true
  const peerOrigins = peerTainted ? mergePeerOriginSummaries([base.peerOrigins, context.peerOrigins]) : undefined
  return {
    source: base.source,
    peerTainted,
    ...(peerOrigins ? { peerOrigins } : {}),
  }
}

export function canonicalTranscriptDigest(entries: readonly TrackedModelMessage[]): string {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(
      canonicalSecurityJson({
        entryId: entry.entryId,
        message: entry.message,
        provenance: entry.provenance,
      }),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function isValidPeerOriginSummary(value: unknown): value is PeerOriginSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<PeerOriginSummary>
  if (
    !Array.isArray(summary.items) ||
    summary.items.length > MAX_PEER_ORIGIN_ITEMS ||
    !Number.isSafeInteger(summary.totalCount) ||
    (summary.totalCount ?? -1) < summary.items.length ||
    typeof summary.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(summary.digest) ||
    typeof summary.truncated !== 'boolean'
  ) {
    return false
  }
  return summary.items.every(
    (origin) =>
      origin &&
      typeof origin === 'object' &&
      typeof origin.instanceId === 'string' &&
      origin.instanceId.length <= 128 &&
      typeof origin.nameAtReceipt === 'string' &&
      origin.nameAtReceipt.length <= 64 &&
      typeof origin.messageId === 'string' &&
      origin.messageId.length <= 128,
  )
}

export function isValidProvenance(value: unknown): value is MessageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const provenance = value as Partial<MessageProvenance>
  if (!['user', 'peer', 'internal'].includes(provenance.authority ?? '')) return false
  if (typeof provenance.derivedFromPeer !== 'boolean') return false
  if (provenance.peerOrigins !== undefined && !isValidPeerOriginSummary(provenance.peerOrigins)) return false
  if (!provenance.derivedFromPeer && provenance.peerOrigins !== undefined) return false
  return true
}

export function isValidContextSecurity(
  value: unknown,
  entries: readonly TrackedModelMessage[],
): value is ContextSecurityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<ContextSecurityState>
  if (typeof state.peerInfluenceActive !== 'boolean') return false
  if (state.firstTaintedEntryId !== undefined && typeof state.firstTaintedEntryId !== 'string') return false
  if (state.peerOrigins !== undefined && !isValidPeerOriginSummary(state.peerOrigins)) return false
  const derived = deriveContextSecurity(entries)
  // 只比对 digest 会漏掉 `items` / `totalCount` / `truncated` 的篡改——而 `items`
  // 正是 UI/审计展示“本次执行受哪些 peer 影响”的依据。整体按规范化形式比较。
  // （`integrityFailure` 不参与：它由调用方单独判定，且无法从 entries 推导。）
  return (
    state.peerInfluenceActive === derived.peerInfluenceActive &&
    state.firstTaintedEntryId === derived.firstTaintedEntryId &&
    canonicalSecurityJson(state.peerOrigins ?? null) === canonicalSecurityJson(derived.peerOrigins ?? null)
  )
}
