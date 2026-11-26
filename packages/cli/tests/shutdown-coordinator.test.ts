import { runShutdownPhases } from '../src/shutdown-coordinator.js'

const timing = {
  shellBudget: { gracefulMs: 1, forceMs: 1, confirmMs: 1 },
  ordinaryDrainMs: 10,
  hardCapMs: 40,
  emergencyReserveMs: 10,
}

describe('CLI shutdown coordinator', () => {
  it('runs shell cleanup before ordinary drains and shares one absolute deadline with emergency cleanup', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      let emergencyDeadline = 0
      const startedAt = performance.now()
      const result = await runShutdownPhases({
        controller: {
          quiesce: async () => {
            order.push('quiesce')
          },
          terminateShells: async () => {
            order.push('shell')
            return null
          },
          drain: async () => {
            order.push('drain')
          },
        },
        reason: 'cli-shutdown',
        ordinaryFinalizers: [
          async () => {
            order.push('ordinary')
          },
        ],
        timing,
        startedAt,
        forceSync: (reason, deadline) => {
          order.push('emergency')
          emergencyDeadline = deadline
          return { reason, requested: 0, results: [] }
        },
      })

      expect(order.slice(0, 2)).toEqual(['quiesce', 'shell'])
      expect(order.at(-1)).toBe('emergency')
      expect(emergencyDeadline).toBe(result.absoluteDeadline)
      expect(result.absoluteDeadline).toBe(startedAt + timing.hardCapMs)
      expect(result.shellPhaseTimedOut).toBe(false)
      expect(result.ordinaryPhaseTimedOut).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('enters emergency reserve without waiting forever for a stuck shell provider', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = performance.now()
      const resultPromise = runShutdownPhases({
        controller: {
          terminateShells: () => new Promise(() => {}),
          drain: async () => {},
        },
        reason: 'sighup',
        ordinaryFinalizers: [],
        timing,
        startedAt,
        forceSync: (reason, deadline) => ({
          reason,
          requested: 1,
          results: [
            {
              managerInstanceId: 'manager',
              shellId: 'bg_1',
              disposition: deadline > 0 ? 'force-sent-unconfirmed' : 'failed',
            },
          ],
        }),
      })

      await vi.advanceTimersByTimeAsync(timing.hardCapMs - timing.emergencyReserveMs)
      const result = await resultPromise
      expect(result.shellPhaseTimedOut).toBe(true)
      expect(result.emergency.requested).toBe(1)
      expect(performance.now()).toBeLessThanOrEqual(result.absoluteDeadline)
    } finally {
      vi.useRealTimers()
    }
  })

  it('claims failed cleanup promises even when the budget is already exhausted', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      // 预算已耗尽：settleUntil 会立刻返回 false，此时若 promise 没被挂上
      // rejection handler，`quiesce`/`terminateShells` 的失败就会变成
      // unhandled rejection——Node ≥15 默认把它升级成 uncaughtException，
      // process.exit()/resetTerminal()/trace 冲刷全部跳过。
      const result = await runShutdownPhases({
        controller: {
          quiesce: async () => {
            throw new Error('quiesce failed')
          },
          terminateShells: async () => {
            throw new Error('terminate failed')
          },
          drain: async () => {},
        },
        reason: 'cli-shutdown',
        ordinaryFinalizers: [],
        timing,
        startedAt: performance.now() - timing.hardCapMs - 1_000,
        forceSync: (reason) => ({ reason, requested: 0, results: [] }),
      })

      expect(result.shellPhaseTimedOut).toBe(true)
      // unhandledRejection 在 microtask 队列排空之后才触发。
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections).toEqual([])
  })
})
