export interface GoalRunCoordinator {
  activeGoalId(): string | null
  run<T>(goalId: string, runner: (signal: AbortSignal) => Promise<T>): Promise<T>
  wake(goalId: string, runner: (signal: AbortSignal) => Promise<unknown>): void
  interrupt(goalId?: string): Promise<void>
}

/** 最多保留的待唤醒数。goal 循环本身是串行的，正常情况下队列里最多只有一个
 *  （“刚才被中断的那次唤醒”）。上限只是防止异常路径下无限堆积。 */
const MAX_PENDING_WAKES = 16

export function createGoalRunCoordinator(): GoalRunCoordinator {
  let active: { goalId: string; controller: AbortController; promise: Promise<unknown> } | null = null
  // 队列而不是单个槽位：同时挂起两个 goal 的唤醒时，覆盖式的单槽位会让前一个
  // runner 被静默丢弃（永远不执行，也拿不到 AbortSignal）。
  const pendingWakes: Array<{ goalId: string; runner: (signal: AbortSignal) => Promise<unknown> }> = []

  const drainWake = () => {
    if (active) return
    const next = pendingWakes.shift()
    if (!next) return
    void coordinator.run(next.goalId, next.runner).catch(() => {})
  }

  const coordinator: GoalRunCoordinator = {
    activeGoalId() {
      return active?.goalId ?? null
    },

    async run<T>(goalId: string, runner: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (active) {
        // 同一个 goal 复用同一次运行（单飞语义）；不同 goal 不能 join——那会把
        // 另一个 goal 的 Promise<unknown> 断言成本 goal 的结果，并且新 runner
        // 永远不会执行。
        if (active.goalId !== goalId) {
          throw new Error(`Goal "${goalId}" cannot start while goal "${active.goalId}" is running`)
        }
        return active.promise as Promise<T>
      }
      const controller = new AbortController()
      const promise = runner(controller.signal)
      active = { goalId, controller, promise }
      try {
        return await promise
      } finally {
        if (active?.promise === promise) active = null
        drainWake()
      }
    },

    wake(goalId: string, runner: (signal: AbortSignal) => Promise<unknown>): void {
      if (pendingWakes.length >= MAX_PENDING_WAKES) {
        // 丢最旧的一条，保留最近的意图（目标是“尽快再跑一次”，不是重放历史）。
        pendingWakes.shift()
      }
      pendingWakes.push({ goalId, runner })
      drainWake()
    },

    async interrupt(goalId?: string): Promise<void> {
      if (!active) return
      if (goalId && active.goalId !== goalId) return
      active.controller.abort()
      try {
        await active.promise
      } catch {
        // 面向用户的错误上报由活跃的 runner 负责。
      }
    },
  }

  return coordinator
}
