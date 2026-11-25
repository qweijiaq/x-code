export interface GoalRunCoordinator {
  activeGoalId(): string | null
  run<T>(goalId: string, runner: (signal: AbortSignal) => Promise<T>): Promise<T>
  wake(goalId: string, runner: (signal: AbortSignal) => Promise<unknown>): void
  interrupt(goalId?: string): Promise<void>
}

/** 最多保留的待唤醒数。goal 循环本身是串行的，正常情况下队列里最多只有一个
 *  （“刚才被中断的那次唤醒”）。上限只是防止异常路径下无限堆积。 */
const MAX_PENDING_WAKES = 16

/** `interrupt()` 等待活跃 runner 观察 abort 的上限。忽略 signal 的 runner
 *  （未接入 abort 的长循环）不能让调用方的 UI 永久挂住。 */
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000

export interface GoalRunCoordinatorOptions {
  /** 后台唤醒运行失败的上报钩子。由 `wake()` 触发的运行没有调用方可以接收
   *  rejection，默认只能丢弃；接入后线上才有排障线索。 */
  onError?: (error: unknown, goalId: string) => void
  /** 覆盖 interrupt 的等待上限（测试 / 自定义 UI 用）。 */
  interruptTimeoutMs?: number
}

type PendingWake = { goalId: string; runner: (signal: AbortSignal) => Promise<unknown> }

/** resolve（而非 reject）而不改变 settle 语义；给“等一个可能永不 settle 的
 *  Promise”加个上限，避免悬挂的 timer。 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

export function createGoalRunCoordinator(options: GoalRunCoordinatorOptions = {}): GoalRunCoordinator {
  const interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS
  let active: { goalId: string; controller: AbortController; promise: Promise<unknown> } | null = null
  // 队列而不是单个槽位：同时挂起两个 goal 的唤醒时，覆盖式的单槽位会让前一个
  // runner 被静默丢弃（永远不执行，也拿不到 AbortSignal）。
  const pendingWakes: PendingWake[] = []

  /** 中断即取消该 goal 尚未执行的唤醒：它们表达的是“当前这轮结束后再跑一次”，
   *  用户已经取消，继续跑会违背取消意图。 */
  const dropPendingWakes = (goalId?: string): void => {
    if (goalId === undefined) {
      pendingWakes.length = 0
      return
    }
    for (let index = pendingWakes.length - 1; index >= 0; index--) {
      if (pendingWakes[index]?.goalId === goalId) pendingWakes.splice(index, 1)
    }
  }

  const startQueued = (next: PendingWake): void => {
    void coordinator.run(next.goalId, next.runner).catch((error) => options.onError?.(error, next.goalId))
  }

  const drainWake = (): void => {
    if (active) return
    const next = pendingWakes.shift()
    if (next) startQueued(next)
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
      let promise: Promise<T>
      try {
        promise = runner(controller.signal)
      } catch (error) {
        // 同步抛错的 runner 也必须登记成一次运行：否则 `active` 保持 null，
        // 清理逻辑和待唤醒队列的排空都会被跳过。
        promise = Promise.reject(error)
      }
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
      dropPendingWakes(goalId)
      if (!active) return
      // 空字符串曾经按“中断所有”处理：goalId 只要给定了就精确匹配。
      if (goalId !== undefined && active.goalId !== goalId) return
      const current = active
      current.controller.abort()
      try {
        await settleWithin(current.promise, interruptTimeoutMs)
      } catch {
        // 面向用户的错误上报由活跃的 runner 负责。
      }
    },
  }

  return coordinator
}
