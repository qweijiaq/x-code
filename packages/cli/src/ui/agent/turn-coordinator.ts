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
      // 把新租约存进局部变量再返回，而不是 `return active.lease`：`notify` 会同步
      // 调用监听器，监听器完全可以在其中 `release()` 或 `releaseAndTryAcquire()`
      // 改写 `active`。此时读的就不再是本次获取的租约——`active` 被释放则抛
      // TypeError（该异常不受 notify 内部 try/catch 保护，直接打崩调用方），被
      // 替换则调用方拿到一个并非自己获取成功的 lease，后续 `release()` 语义错乱。
      const next = createLease(owner, authority)
      active = next
      notify(next.lease)
      // 监听器可能在 notify 里同步 `release()`/抢占：此时本次获取已不成立，
      // 必须返回 null，否则调用方会以为自己持锁并同时跑两个轮次。
      return active?.token === next.token ? next.lease : null
    },

    releaseAndTryAcquire(lease, nextOwner, nextAuthority) {
      const token = tokens.get(lease)
      if (!token || active?.token !== token) return null
      const next = createLease(nextOwner, nextAuthority)
      active = next
      notify(next.lease)
      // 同上：notify 期间被释放/替换时不能返回已失效的租约，否则破坏本方法的
      // “原子切换”契约。
      return active?.token === next.token ? next.lease : null
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
