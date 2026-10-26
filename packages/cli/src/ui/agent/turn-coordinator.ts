export type TurnOwner = 'user' | 'peer' | 'goal' | 'compact' | 'resume' | 'rewind' | 'clear'

export interface TurnPeerOrigin {
  instanceId: string
  nameAtReceipt: string
  messageId: string
}

export interface TurnPeerOriginSummary {
  items: TurnPeerOrigin[]
  totalCount: number
  digest: string
  truncated: boolean
}

/** core 执行权限的结构化对应物。把这个小型状态机保持独立于 core 导出，让它在
 *  启动期间也可用。 */
export interface TurnAuthority {
  source: 'user' | 'peer'
  peerTainted: boolean
  peerOrigins?: TurnPeerOriginSummary
}

export type AuthoritySnapshot = Readonly<{
  source: TurnAuthority['source']
  peerTainted: boolean
  peerOrigins?: Readonly<{
    items: readonly Readonly<TurnPeerOrigin>[]
    totalCount: number
    digest: string
    truncated: boolean
  }>
}>

export interface TurnLease {
  readonly id: string
  readonly owner: TurnOwner
  readonly authority: AuthoritySnapshot
  release(): boolean
}

export type TurnCoordinatorListener = (lease: TurnLease | null) => void

export interface TurnCoordinator {
  tryAcquire(owner: TurnOwner, authority: TurnAuthority): TurnLease | null
  /** 在不暴露可观察空闲状态的情况下替换当前租约。 */
  releaseAndTryAcquire(lease: TurnLease, nextOwner: TurnOwner, nextAuthority: TurnAuthority): TurnLease | null
  isOwned(): boolean
  current(): TurnLease | null
  onChange(listener: TurnCoordinatorListener): () => void
}

interface ActiveLease {
  token: symbol
  lease: TurnLease
}

function snapshotOrigins(origins: TurnPeerOriginSummary): NonNullable<AuthoritySnapshot['peerOrigins']> {
  const items = Object.freeze(
    origins.items.map((origin) =>
      Object.freeze({
        instanceId: origin.instanceId,
        nameAtReceipt: origin.nameAtReceipt,
        messageId: origin.messageId,
      }),
    ),
  )
  return Object.freeze({
    items,
    totalCount: origins.totalCount,
    digest: origins.digest,
    truncated: origins.truncated,
  })
}

function snapshotAuthority(authority: TurnAuthority): AuthoritySnapshot {
  return Object.freeze({
    source: authority.source,
    peerTainted: authority.peerTainted,
    ...(authority.peerOrigins ? { peerOrigins: snapshotOrigins(authority.peerOrigins) } : {}),
  })
}

export function createTurnCoordinator(): TurnCoordinator {
  let active: ActiveLease | null = null
  let sequence = 0
  const listeners = new Set<TurnCoordinatorListener>()
  const tokens = new WeakMap<TurnLease, symbol>()

  const notify = (lease: TurnLease | null): void => {
    for (const listener of [...listeners]) {
      try {
        listener(lease)
      } catch {
        // 一个 UI 观察者绝不能破坏所有权或压制其他观察者。
      }
    }
  }

  const releaseToken = (token: symbol): boolean => {
    if (active?.token !== token) return false
    active = null
    notify(null)
    return true
  }

  const createLease = (owner: TurnOwner, authority: TurnAuthority): ActiveLease => {
    const token = Symbol(`turn-${sequence + 1}`)
    const id = `turn-${++sequence}`
    const lease = Object.freeze({
      id,
      owner,
      authority: snapshotAuthority(authority),
      release: () => releaseToken(token),
    }) satisfies TurnLease
    tokens.set(lease, token)
    return { token, lease }
  }

  return {
    tryAcquire(owner, authority) {
      if (active) return null
      active = createLease(owner, authority)
      notify(active.lease)
      return active.lease
    },

    releaseAndTryAcquire(lease, nextOwner, nextAuthority) {
      const token = tokens.get(lease)
      if (!token || active?.token !== token) return null
      const next = createLease(nextOwner, nextAuthority)
      active = next
      notify(next.lease)
      return next.lease
    },

    isOwned() {
      return active !== null
    },

    current() {
      return active?.lease ?? null
    },

    onChange(listener) {
      listeners.add(listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
  }
}
