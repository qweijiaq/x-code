// @x-code-cli/cli — 非交互式（-p / --print）运行器。
//
// 有意完全绕过 Ink：没有 TUI 组件、没有 raw 模式 stdin、没有等待输入事件的
// reconciler 帧。Ink 路径无法在打印模式下可靠地自动退出，因为 `usePromptInput`
// 在 raw 模式下引用了 stdin，让事件循环保持存活，直到用户按键或调整终端大小
// ——那时排队的卸载才终于运行。把打印模式作为独立代码路径，避开了所有这些地雷。
import { agentLoop, createLoopState, hydrateLoopState, saveSession, stripTerminalControls } from '@x-code-cli/core'
import type { AgentCallbacks, AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

import { registerCleanupController } from './cleanup-controller.js'
import { SHELL_SHUTDOWN_BUDGET, runShutdownPhases } from './shutdown-coordinator.js'

export async function runPrintMode(
  model: LanguageModel,
  options: AgentOptions,
  prompt: string,
  initialSession?: LoadedSession | null,
): Promise<number> {
  // 在 Ctrl+C 时中止，让长时间运行的 -p 调用可以被中断。
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawError = false
  let exitCode = 0
  let shouldSaveSession = false
  const state = initialSession
    ? hydrateLoopState(initialSession, options.permissionMode ?? 'default', process.cwd())
    : createLoopState(options.permissionMode ?? 'default', { projectCwd: process.cwd() })

  registerCleanupController({
    terminateShells: (reason, budget = SHELL_SHUTDOWN_BUDGET) => state.shellSessions.dispose(reason, budget),
    drain: async () => {
      await options.memoryService?.shutdown(options.memoryService.getConfig().drainTimeoutMs)
    },
  })

  const callbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      if (delta) process.stdout.write(stripTerminalControls(delta))
    },
    onToolCall: () => {},
    onToolProgress: () => {},
    onToolResult: () => {},
    onAskPermission: async (toolCall) => {
      // 非交互式——我们无法提示。拒绝并让模型适应；想在 -p 模式下写工具的用户
      // 应该传 -t / --trust。
      process.stderr.write(`\n[permission denied: ${toolCall.toolName} — pass --trust to auto-approve in -p mode]\n`)
      return 'no'
    },
    onAskUser: async (question) => {
      process.stderr.write(`\n[cannot ask question in -p mode: ${question}]\n`)
      return ''
    },
    onPlanApprovalRequest: async () => {
      // 非交互式——无法显示批准对话框。拒绝，让模型保持在计划模式并写出最终
      // 计划，而不是假装用户接受了他们从未见过的东西。
      process.stderr.write(`\n[plan approval not available in -p mode — pass --plan + interactive session]\n`)
      return false
    },
    onPlanModeChange: () => {
      // 打印模式下没有要更新的 UI；模式变更仍会在 LoopState 上生效，而那是
      // 对这次短暂运行唯一真正重要的地方。
    },
    onTodosUpdate: () => {
      // 打印模式下没有实时面板——todos 存在于 LoopState 上，但没有终端 UI
      // 来渲染它们。静默空操作。
    },
    onShellOutput: () => {},
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onStreamRetry: (event) => {
      if (event) process.stderr.write(`\nReconnecting... ${event.attempt}/${event.maxAttempts}\n`)
    },
    onError: (err) => {
      sawError = true
      process.stderr.write(`\n[error] ${err.message}\n`)
    },
  }

  try {
    // 通过在打印模式中从已加载会话水合循环状态，来尊重 --continue / --resume。
    // 没有这一步，main() 会加载之前的 jsonl，但 agent 在这里开启全新对话，
    // 静默丢弃恢复请求。Ink 路径通过 useAgent → hydrateLoopState 贯通这一点；
    // 打印模式只需要同样的接线。
    await agentLoop(prompt, model, { ...options, abortSignal: controller.signal }, callbacks, state)

    // 当 stdout 是 TTY 时以换行结束，让 shell 提示符落在一个全新行上。
    // 被管道时，则原样信任模型的输出。
    if (process.stdout.isTTY) process.stdout.write('\n')

    shouldSaveSession = true
    exitCode = sawError ? 1 : 0
  } catch (err) {
    process.stderr.write(`\n[fatal] ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = 1
  } finally {
    process.off('SIGINT', onSigint)
    const shutdown = await runShutdownPhases({
      controller: {
        terminateShells: (reason, budget = SHELL_SHUTDOWN_BUDGET) => state.shellSessions.dispose(reason, budget),
        drain: async () => {
          await options.memoryService?.shutdown(options.memoryService.getConfig().drainTimeoutMs)
        },
      },
      reason: 'print-exit',
      ordinaryFinalizers: shouldSaveSession ? [() => saveSession(state, model).catch(() => undefined)] : [],
    })
    if (shutdown.emergency.requested > 0 && exitCode === 0) exitCode = 1
    registerCleanupController(null)
    // 返回前冲刷 stdout/stderr，这样调用方的 process.exit() 不会与管道排水
    // 竞争。在 Windows 上，管道写是非阻塞的——没有这一步，进程紧接着退出时，
    // 通过 process.stderr.write() 写的错误消息可能被静默丢失。
    await new Promise<void>((resolve) => {
      process.stdout.write('', () => process.stderr.write('', () => resolve()))
    })
  }
  return exitCode
}
