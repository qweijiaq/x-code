export interface PeerRateLimiter {
  admit(senderInstanceId: string): boolean
  senderCount(): number
}

export interface PeerRateLimiterOptions {
  perSender?: number
  global?: number
  windowMs?: number
  maxSenders?: number
  now?: () => number
}

export function createPeerRateLimiter(options: PeerRateLimiterOptions = {}): PeerRateLimiter {
  const perSender = options.perSender ?? 30
  const globalLimit = options.global ?? 120
  const windowMs = options.windowMs ?? 60_000
  const maxSenders = options.maxSenders ?? 2_048
  const wallNow = options.now ?? Date.now
  // 单调时钟保护：`trim()` 用「从头部扫到第一个比 cutoff 新的元素」的方式清理，
  // 前提是数组里的时间戳递增。系统校时 / 手工改钟导致时间回拨时，新 push 的
  // 时间戳会小于已有值，头扫就会提前停止，过期记录永远清不掉——该 sender 被
  // 永久判超限、`global` 永久占满，所有对等端被持续拒绝（fail-closed 的自伤型
  // DoS），数组还会无界增长。这里把返回值钳制为不小于上一次观测值。
  let lastSeen = 0
  const now = (): number => {
    lastSeen = Math.max(wallNow(), lastSeen)
    return lastSeen
  }
  const global: number[] = []
  const senders = new Map<string, number[]>()

  // 注意 `<= cutoff` 表示恰好落在窗口边界上的记录会被丢弃，因此实际窗口是
  // 「严格小于 windowMs」的滑动窗口（与含边界语义差 1ms，可忽略）。
  const trim = (values: number[], cutoff: number): void => {
    let count = 0
    while (count < values.length && values[count]! <= cutoff) count++
    if (count > 0) values.splice(0, count)
  }

  return {
    admit(senderInstanceId) {
      const timestamp = now()
      const cutoff = timestamp - windowMs
      trim(global, cutoff)
      for (const [sender, values] of senders) {
        trim(values, cutoff)
        if (values.length === 0) senders.delete(sender)
      }
      let sender = senders.get(senderInstanceId)
      if (!sender) {
        if (senders.size >= maxSenders) return false
        sender = []
        senders.set(senderInstanceId, sender)
      }
      if (sender.length >= perSender || global.length >= globalLimit) return false
      sender.push(timestamp)
      global.push(timestamp)
      return true
    },
    senderCount() {
      return senders.size
    },
  }
}
