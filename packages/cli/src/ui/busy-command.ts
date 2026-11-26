import type { TurnOwner } from './agent/turn-coordinator.js'

/** 无需取得活动轮次就能安全运行的斜杠命令。让输入门禁和命令分发器共享这一策略。 */
export function isSlashCommandAllowedWhileBusy(
  text: string,
  activeOwner: TurnOwner,
  hasStableForkBoundary: boolean,
): boolean {
  const trimmed = text.trimStart()
  // 非斜杠输入永远不是斜杠命令：没有这层判定，任意文本都会被 `slice(1)` 后的
  // 首个词当成命令（`ostop` → `stop`），从而绕过忙时输入门禁。
  if (!trimmed.startsWith('/')) return false
  const [command = '', subcommand = ''] = trimmed.slice(1).trim().toLowerCase().split(/\s+/)
  if (command === 'fork') {
    return hasStableForkBoundary && (activeOwner === 'user' || activeOwner === 'peer' || activeOwner === 'goal')
  }
  if (command === 'ps' || command === 'stop' || command === 'policy') return true
  return command === 'goal' && ['pause', 'cancel', 'clear', 'steer'].includes(subcommand)
}
