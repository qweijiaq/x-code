import type { TurnOwner } from './agent/turn-coordinator.js'

/** 无需取得活动轮次就能安全运行的斜杠命令。让输入门禁和命令分发器共享这一策略。 */
export function isSlashCommandAllowedWhileBusy(
  text: string,
  activeOwner: TurnOwner,
  hasStableForkBoundary: boolean,
): boolean {
  const [command = '', subcommand = ''] = text.trimStart().slice(1).trim().toLowerCase().split(/\s+/)
  if (command === 'fork') {
    return hasStableForkBoundary && (activeOwner === 'user' || activeOwner === 'peer' || activeOwner === 'goal')
  }
  if (command === 'ps' || command === 'stop') return true
  return command === 'goal' && ['pause', 'cancel', 'steer'].includes(subcommand)
}
