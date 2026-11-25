import { forceTerminateManagedShellsSync } from '@x-code-cli/core'
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
  emergency: EmergencyTerminationResult
}

const DEFAULT_TIMING: ShutdownTiming = {
  shellBudget: SHELL_SHUTDOWN_BUDGET,
  ordinaryDrainMs: ORDINARY_DRAIN_BUDGET_MS,
  hardCapMs: CLI_SHUTDOWN_HARD_CAP_MS,
  emergencyReserveMs: EMERGENCY_RESERVE_MS,
}

async function settleUntil(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = Math.max(0, deadline - performance.now())
  if (remaining === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining)
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

  const quiescePhase = options.controller?.quiesce
    ? Promise.resolve().then(() => options.controller!.quiesce!())
    : Promise.resolve()
  await settleUntil(quiescePhase, ordinaryDeadline)

  const shellPhase = options.controller
    ? Promise.resolve().then(() => options.controller!.terminateShells(options.reason, timing.shellBudget))
    : Promise.resolve(null)
  const shellPhaseTimedOut = !(await settleUntil(shellPhase, ordinaryDeadline))

  const ordinary = Promise.allSettled([
    ...(options.controller ? [Promise.resolve().then(() => options.controller!.drain())] : []),
    ...options.ordinaryFinalizers.map((finalize) => Promise.resolve().then(finalize)),
  ])
  const ordinaryPhaseDeadline = Math.min(performance.now() + timing.ordinaryDrainMs, ordinaryDeadline)
  const ordinaryPhaseTimedOut = !(await settleUntil(ordinary, ordinaryPhaseDeadline))

  const forceSync = options.forceSync ?? forceTerminateManagedShellsSync
  // 兜底阶段必须始终留有最小预算。`absoluteDeadline` 是相对 `startedAt` 算的，而
  // 前面所有阶段的等待都依赖 setTimeout 触发——一旦事件循环被阻塞（清理钩子里的
  // 同步工作、进程被挂起）或调用方传入较早的 `startedAt`，走到这里
  // `performance.now()` 很可能已 >= absoluteDeadline。此时 forceSync 内部会对每个
  // target 直接记 'deadline-exhausted' 并跳过 forceTreeSync，即一个 shell 都不会被
  // 真正杀掉，随后 process.exit() 把托管 shell 留成孤儿进程。
  const emergencyDeadline = Math.max(absoluteDeadline, performance.now() + timing.emergencyReserveMs)
  let emergency: EmergencyTerminationResult
  try {
    emergency = forceSync(options.reason, emergencyDeadline)
  } catch {
    // 作为最后一道防线，绝不能因为 forceSync 抛错就让 runShutdownPhases reject：
    // 那样 `process.exit()` 永远不会被调用，而 shutdownInProgress 已置为 true，
    // 进程会永久挂住。
    emergency = { reason: options.reason, requested: 0, results: [] }
  }
  return { absoluteDeadline, shellPhaseTimedOut, ordinaryPhaseTimedOut, emergency }
}
