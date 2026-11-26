import { errorMessage, forceTerminateManagedShellsSync } from '@x-code-cli/core'
import type { EmergencyTerminationResult, TerminationBudget, TerminationReason } from '@x-code-cli/core'

import type { CliCleanupController } from './cleanup-controller.js'

export const SHELL_SHUTDOWN_BUDGET: TerminationBudget = {
  gracefulMs: 1_000,
  forceMs: 1_000,
  confirmMs: 250,
}
export const ORDINARY_DRAIN_BUDGET_MS = 1_500
export const CLI_SHUTDOWN_HARD_CAP_MS = 4_000
export const EMERGENCY_RESERVE_MS = 500

/** 普通阶段（drain + 会话落盘等 finalizer）的最小预算：即使前面的阶段已经把
 *  `ordinaryDeadline` 用光，也要给它们留出这段时间，否则紧接着的
 *  `process.exit()` 会把正在写 JSONL 的 saveSession 打断。 */
export const MIN_ORDINARY_DRAIN_MS = 500

export interface ShutdownTiming {
  shellBudget: TerminationBudget
  ordinaryDrainMs: number
  hardCapMs: number
  emergencyReserveMs: number
}

export interface ShutdownPhaseResult {
  absoluteDeadline: number
  shellPhaseTimedOut: boolean
  ordinaryPhaseTimedOut: boolean
  /** 各阶段失败 / 被放弃的摘要。调用方负责写日志——协调器本身没有 logger，
   *  之前这些信息被完全丢掉，线上无法定位孤儿进程与半截会话的来源。 */
  errors: string[]
  /** forceSync 自身抛错（注册表访问异常等）：此时托管 shell 可能仍然存活，
   *  退出码不应再被当成「清理成功」。 */
  emergencyFailed: boolean
  emergency: EmergencyTerminationResult
}

const DEFAULT_TIMING: ShutdownTiming = {
  shellBudget: SHELL_SHUTDOWN_BUDGET,
  ordinaryDrainMs: ORDINARY_DRAIN_BUDGET_MS,
  hardCapMs: CLI_SHUTDOWN_HARD_CAP_MS,
  emergencyReserveMs: EMERGENCY_RESERVE_MS,
}

interface SettleOutcome {
  settled: boolean
  /** 清理本身抛错时的可读摘要。 */
  error?: string
}

async function settleUntil(promise: Promise<unknown>, deadline: number): Promise<SettleOutcome> {
  // 先挂 handler，再判预算：预算已耗尽（remaining === 0，正是最需要兜底的场景）
  // 时下面会直接 return false，promise 就再也没人认领——quiesce()/terminateShells()
  // 一旦 reject 就是 unhandled rejection，Node ≥15 默认把它升级成
  // uncaughtException，`process.exit()`、`resetTerminal()`、trace 冲刷全都跳过去，
  // 恰好与「绝不能让进程挂住或留下孤儿 shell」的意图相反。
  const settled = promise.then(
    (): SettleOutcome => ({ settled: true }),
    (error: unknown): SettleOutcome => ({ settled: true, error: errorMessage(error) }),
  )
  const remaining = Math.max(0, deadline - performance.now())
  if (remaining === 0) return { settled: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      settled,
      new Promise<SettleOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runShutdownPhases(options: {
  controller: CliCleanupController | null
  reason: TerminationReason
  ordinaryFinalizers: Array<() => Promise<unknown>>
  timing?: ShutdownTiming
  startedAt?: number
  forceSync?: typeof forceTerminateManagedShellsSync
}): Promise<ShutdownPhaseResult> {
  const timing = options.timing ?? DEFAULT_TIMING
  const startedAt = options.startedAt ?? performance.now()
  const absoluteDeadline = startedAt + timing.hardCapMs
  const ordinaryDeadline = absoluteDeadline - timing.emergencyReserveMs

  const errors: string[] = []

  const quiescePhase = options.controller?.quiesce
    ? Promise.resolve().then(() => options.controller!.quiesce!())
    : Promise.resolve()
  const quiesce = await settleUntil(quiescePhase, ordinaryDeadline)
  if (quiesce.error) errors.push(`quiesce: ${quiesce.error}`)
  if (!quiesce.settled) errors.push('quiesce abandoned (deadline exhausted)')

  const shellPhase = options.controller
    ? Promise.resolve().then(() => options.controller!.terminateShells(options.reason, timing.shellBudget))
    : Promise.resolve(null)
  const shell = await settleUntil(shellPhase, ordinaryDeadline)
  const shellPhaseTimedOut = !shell.settled
  if (shell.error) errors.push(`terminateShells: ${shell.error}`)
  // 超时后异步终止阶段仍在后台继续（发送 graceful 信号、await 退出、forceTree），
  // 与下面同步的 forceSync 会对同一批 PID 重复动手。这里至少让调用方知道
  // 「shell 阶段被放弃」，便于排查孤儿进程与重复 signal。
  if (shellPhaseTimedOut) errors.push('terminateShells abandoned (deadline exhausted) — force-sync ran concurrently')

  const ordinaryTasks: Array<{ label: string; run: () => Promise<unknown> }> = [
    ...(options.controller ? [{ label: 'drain', run: () => options.controller!.drain() }] : []),
    ...options.ordinaryFinalizers.map((finalize, index) => ({ label: `finalizer#${index}`, run: finalize })),
  ]
  const ordinary = Promise.allSettled(ordinaryTasks.map((task) => Promise.resolve().then(task.run))).then((results) => {
    // allSettled 自己不会丢结果，但这些失败此前没有任何出口：逐个记下来交给调用方。
    results.forEach((result, index) => {
      if (result.status === 'rejected') errors.push(`${ordinaryTasks[index]!.label}: ${errorMessage(result.reason)}`)
    })
  })
  // 给普通阶段留一个下限：事件循环被阻塞或前面阶段已把预算吃光时，
  // `ordinaryDeadline` 可能是过去时刻，remaining === 0 会让 drain / saveSession
  // 一秒都不被等待，紧接着的 process.exit() 就会写出半截 JSONL。
  const ordinaryPhaseDeadline = Math.max(
    Math.min(performance.now() + timing.ordinaryDrainMs, ordinaryDeadline),
    performance.now() + MIN_ORDINARY_DRAIN_MS,
  )
  const ordinaryOutcome = await settleUntil(ordinary, ordinaryPhaseDeadline)
  const ordinaryPhaseTimedOut = !ordinaryOutcome.settled
  if (ordinaryPhaseTimedOut) errors.push('drain/finalizers abandoned (deadline exhausted)')

  const forceSync = options.forceSync ?? forceTerminateManagedShellsSync
  // 兜底阶段必须始终留有最小预算。`absoluteDeadline` 是相对 `startedAt` 算的，而
  // 前面所有阶段的等待都依赖 setTimeout 触发——一旦事件循环被阻塞（清理钩子里的
  // 同步工作、进程被挂起）或调用方传入较早的 `startedAt`，走到这里
  // `performance.now()` 很可能已 >= absoluteDeadline。此时 forceSync 内部会对每个
  // target 直接记 'deadline-exhausted' 并跳过 forceTreeSync，即一个 shell 都不会被
  // 真正杀掉，随后 process.exit() 把托管 shell 留成孤儿进程。
  const emergencyDeadline = Math.max(absoluteDeadline, performance.now() + timing.emergencyReserveMs)
  let emergency: EmergencyTerminationResult
  let emergencyFailed = false
  try {
    emergency = forceSync(options.reason, emergencyDeadline)
  } catch (error) {
    // 作为最后一道防线，绝不能因为 forceSync 抛错就让 runShutdownPhases reject：
    // 那样 `process.exit()` 永远不会被调用，而 shutdownInProgress 已置为 true，
    // 进程会永久挂住。但也不能假装清理成功——托管 shell 这时可能仍然存活。
    emergencyFailed = true
    errors.push(`emergency termination failed: ${errorMessage(error)}`)
    process.stderr.write(
      `\n[shutdown] emergency shell cleanup failed (${errorMessage(error)}) — some background shells may survive\n`,
    )
    emergency = { reason: options.reason, requested: 0, results: [] }
  }
  return { absoluteDeadline, shellPhaseTimedOut, ordinaryPhaseTimedOut, errors, emergencyFailed, emergency }
}
