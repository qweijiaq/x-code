import type { ShellExecutionResult } from './types.js'

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(3)}s`
}

function outputBlock(output: string): string {
  return `Output:\n${output.trimEnd() || '(no new output)'}`
}

function appendFullOutput(lines: string[], result: ShellExecutionResult): void {
  if (result.fullOutputPath) {
    lines.push(`Full output: ${result.fullOutputPath}`)
  } else if (result.fullOutputError) {
    lines.push(`Full output could not be saved: ${result.fullOutputError}`)
  }
}

/** `shellId` 在若干终态观察里是可选字段（持久 shell、被中断的启动、清理
 *  未确认的残留等）。直接模板插值会把 "undefined" 送给模型，并给出一个
 *  没有 ID、无法执行的 shellOutput / killShell 指引；缺省时返回 null 让调用
 *  方改用“ID 不可用”的分支。 */
function shellIdLabel(shellId: string | undefined): string | null {
  return shellId ? shellId : null
}

/** shell、shellOutput 与 killShell 共享的、面向模型的一种表示。 */
export function formatShellExecutionResult(result: ShellExecutionResult): string {
  // 头部对所有分支统一：`Chunk ID` 是模型/下游关联同一次执行的唯一键，
  // 提前 return 的分支若省略它，观察记录就无法与 chunk 对上。
  const lines = [`Chunk ID: ${result.chunkId}`, `Wall time: ${seconds(result.wallTimeMs)}`]
  const shellId = shellIdLabel(result.shellId)

  if (result.cleanupResidual && result.running) {
    lines.push('Command failed to start; process-tree cleanup could not be confirmed.')
    if (shellId) {
      lines.push(`Residual shell ID: ${shellId}`, 'Use shellOutput or killShell to inspect/retry cleanup.')
    } else {
      lines.push('Residual shell ID unavailable; re-run the command and check /ps for leftover processes.')
    }
    if (result.failure?.message) lines.push(`Failure: ${result.failure.message}`)
    if (result.output) lines.push(outputBlock(result.output))
    appendFullOutput(lines, result)
    return lines.join('\n')
  }

  if (result.running) {
    if (result.rootExited) {
      lines.push(
        shellId
          ? `Root process exited; managed descendants remain under shell ID ${shellId}`
          : 'Root process exited; managed descendants remain but their shell ID is unavailable (see /ps).',
      )
    } else {
      lines.push(
        shellId
          ? `Process running with shell ID ${shellId}`
          : 'Process running; its shell ID is unavailable (see /ps).',
      )
    }
    if (result.waitInterrupted) lines.push('Wait interrupted; the managed process is still running.')
    if (result.managerDraining) lines.push('Shell manager is draining this process tree.')
    if (result.failure?.message) lines.push(`Failure: ${result.failure.message}`)
    lines.push(outputBlock(result.output))
    appendFullOutput(lines, result)
    return lines.join('\n')
  }

  // 残留判断与 `running` 解耦：清理未确认的状态可能在后来的 terminate 尝试
  // 确认进程树退出之后依旧保留（manager 在这种情况下也仍保留 shellId）。只在
  // `running` 分支报告，会让模型完全看不到“还有残留进程需要处理”。
  if (result.cleanupResidual) {
    lines.push(
      shellId
        ? `Command started but residual descendants may remain (shell ID ${shellId}); use killShell to retry cleanup.`
        : 'Command started but residual descendants may remain; their shell ID is unavailable (see /ps).',
    )
  }

  if (result.lifecycle === 'spawn-failed') {
    lines.push(`Command failed to start${result.failure?.message ? `: ${result.failure.message}` : '.'}`)
  } else if (result.timedOut) {
    lines.push('Process timed out and its managed process tree exited.')
  } else if (result.signal) {
    lines.push(`Process exited with signal ${result.signal}`)
  } else if (result.exitCode !== undefined) {
    lines.push(`Process exited with code ${result.exitCode}`)
  } else if (result.isError) {
    // 持久 shell 路径上，命令被中断或 shell 意外退出时 exitCode / signal 都
    // 可能缺失而 isError 为 true：报 "code 0" 与错误语义自相矛盾。
    lines.push('Process exited with unknown status (no exit code reported); treat this command as failed.')
  } else {
    lines.push('Process exited with unknown status (no exit code reported).')
  }
  lines.push(outputBlock(result.output || (result.isError ? '' : 'Done')))
  appendFullOutput(lines, result)
  return lines.join('\n')
}
