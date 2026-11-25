import { errorMessage } from '@x-code-cli/core'
import type { ShellSessionController, TerminateAllResult } from '@x-code-cli/core'

export type ShellSessionTransitionResult =
  | { ok: true; result: TerminateAllResult }
  | { ok: false; reason: string; result?: TerminateAllResult }

export async function disposeShellSessionsForTransition(
  manager: Pick<ShellSessionController, 'dispose'>,
  reason: 'clear' | 'resume',
): Promise<ShellSessionTransitionResult> {
  // `dispose` 的实现并不只有 TS 类：测试与子代理闭环用例用 `as unknown as
  // ShellSessionController` 桩接，`cleanup-controller.ts` 也允许返回 null。因此
  // 不能相信类型标注——一旦 resolve 出 null / 缺少 `results` 的对象，下面的
  // `result.results.some(...)` 会抛 TypeError 而不是被转换成 `{ ok: false }`，
  // 而调用方 `beginSessionTransition` 只在 `!disposed.ok` 分支和成功路径释放
  // 租约，异常会同时绕过两者，使 turn lease 永久占用、后续回合全部卡死。
  let result: TerminateAllResult | null | undefined
  try {
    result = await manager.dispose(reason)
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }

  if (!result || !Array.isArray(result.results)) {
    return { ok: false, reason: 'background terminal cleanup returned an invalid result' }
  }

  // 残项缺失按「未确认」处理而非 fail-open：拿不到确认就别放行切换。
  if (result.results.some((entry) => !entry?.treeConfirmedExited)) {
    return { ok: false, reason: 'background terminal cleanup was not confirmed', result }
  }
  return { ok: true, result }
}
