import type { ShellSessionSummary, TerminateAllResult } from '@x-code-cli/core'

function safeText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function elapsed(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return 'starting'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatBackgroundTerminals(
  sessions: readonly ShellSessionSummary[],
  now = Date.now(),
  page = 1,
  pageSize = 10,
): string {
  const allLive = sessions.filter((session) => !session.treeConfirmedExited)
  if (allLive.length === 0) return 'No running background terminals.'
  const totalPages = Math.max(1, Math.ceil(allLive.length / pageSize))
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const start = (currentPage - 1) * pageSize
  const live = allLive.slice(start, start + pageSize)
  const lines = [`Background terminals (page ${currentPage}/${totalPages}, ${allLive.length} total)`]
  for (const session of live) {
    const state = session.cleanupResidual
      ? 'cleanup unconfirmed'
      : session.status === 'termination-failed'
        ? 'stop unconfirmed'
        : elapsed(session.startedAt, now)
    lines.push(`  • ${safeText(session.shellId)} · ${safeText(session.command)} · ${state}`)
    for (const output of session.recentOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)) {
      lines.push(`    ↳ ${safeText(output)}`)
    }
  }
  const remaining = allLive.length - (start + live.length)
  if (remaining > 0) lines.push(`  … ${remaining} more · run /ps ${currentPage + 1} or /ps <shell-id>`)
  else if (currentPage > 1) lines.push('  Use /ps <page> to move between pages, or /ps <shell-id> for details.')
  return lines.join('\n')
}

/** `/ps <shell-id>`：查看单个后台终端的详情与最近输出。 */
export function formatBackgroundTerminalDetail(
  sessions: readonly ShellSessionSummary[],
  shellIdPrefix: string,
  now = Date.now(),
): string {
  const prefix = shellIdPrefix.trim()
  const live = sessions.filter((session) => !session.treeConfirmedExited)
  const matches = live.filter((session) => session.shellId === prefix || session.shellId.startsWith(prefix))
  if (matches.length === 0) return `No running background terminal matches \`${safeText(prefix)}\`.`
  if (matches.length > 1) {
    return [
      `Multiple background terminals match \`${safeText(prefix)}\`:`,
      ...matches.map((session) => `  • ${safeText(session.shellId)} · ${safeText(session.command)}`),
    ].join('\n')
  }
  const session = matches[0]!
  const state = session.cleanupResidual
    ? 'cleanup unconfirmed'
    : session.status === 'termination-failed'
      ? 'stop unconfirmed'
      : session.status
  const lines = [
    `Background terminal ${safeText(session.shellId)}`,
    `  command: ${safeText(session.command)}`,
    `  cwd:     ${safeText(session.effectiveCwd)}`,
    `  state:   ${state} · ${elapsed(session.startedAt, now)}${session.tty ? ' · tty' : ''}`,
  ]
  const output = session.recentOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-20)
  if (output.length > 0) {
    lines.push('  recent output:')
    for (const line of output) lines.push(`    ↳ ${safeText(line)}`)
  }
  return lines.join('\n')
}

export function formatStopResult(result: TerminateAllResult | null): string {
  if (!result || result.requested === 0) return 'No running background terminals.'
  const failed = result.results.filter((entry) => !entry.treeConfirmedExited)
  const stopped = result.confirmed
  const alreadyExited =
    result.alreadyExited > 0
      ? `; ${result.alreadyExited} background terminal${result.alreadyExited === 1 ? '' : 's'} had already exited`
      : ''
  if (failed.length === 0) {
    return `Stopped ${stopped} background terminal${stopped === 1 ? '' : 's'}${alreadyExited}.`
  }
  const lines = [
    `Stopped ${stopped} background terminal${stopped === 1 ? '' : 's'}${alreadyExited}; ${failed.length} could not be confirmed stopped.`,
  ]
  for (const entry of failed) {
    lines.push(
      `  • ${safeText(entry.shellId)} · ${entry.failure?.code ?? 'termination-unconfirmed'} · ${safeText(entry.failure?.message ?? 'process tree may still be running')}`,
    )
  }
  return lines.join('\n')
}
