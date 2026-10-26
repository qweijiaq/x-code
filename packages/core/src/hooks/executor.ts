// @x-code-cli/core — Hook 命令执行器
//
// 启动 hook 的 shell 命令，把事件 JSON 写到 stdin，从 stdout 读取
// 决策 JSON。整个协议是行导向的：一个 JSON 对象进，一个 JSON 对象出
// （或 stdout 为空 = 默认 allow）。stdout 上的其他内容被忽略 —— 这是
// 只想往 stderr 打日志而不影响代理的 hook 的常见模式。
//
// 失败处理特意保持宽松（默认 `failurePolicy: 'allow'`）：
// 损坏的 hook 绝不能卡死代理循环。非零退出、超时或崩溃都会
// 降级为 `allow` 并记录一条 debug 面包屑。`block` 策略是显式选择的，
// 只保留给插件作者明确设计为门控型的 hook。
//
// AbortSignal 传播：传给 execa 的 `cancelSignal`，这样用户在 hook 执行
// 途中按 Esc 时子进程会被 SIGKILL。与 shell 工具使用的机制相同。
import { execa } from 'execa'

import { getPluginUserConfigEnv } from '../plugins/user-config.js'
import { debugLog, errorMessage } from '../utils.js'
import { getShellSandbox, isExtensionSandboxActive, sanitizeShellEnv, wrapShellSpawn } from '../utils/shell-sandbox.js'
import type { HookConfigEntry, HookDecision, HookEvent, RegisteredHook } from './types.js'
import { buildVariableContext, expandVariables } from './variables.js'

/** 返回适合当前操作系统的命令。插件作者把 `command` 设为可移植的默认值，
 *  并可添加 `commandWindows` / `commandDarwin` / `commandLinux` 处理
 *  各操作系统的差异（例如 shebang 行、可执行文件名、引号）。未知平台
 *  （freebsd、sunos、aix）回退到基础命令。 */
function pickPlatformCommand(entry: HookConfigEntry): string {
  switch (process.platform) {
    case 'win32':
      return entry.commandWindows ?? entry.command
    case 'darwin':
      return entry.commandDarwin ?? entry.command
    case 'linux':
      return entry.commandLinux ?? entry.command
    default:
      return entry.command
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export interface ExecuteHookOptions {
  /** 触发时取消 hook 子进程。代理循环的 abort 信号经此传入，
   *  因此在慢 hook 执行期间按 Esc 能立即终止它。 */
  signal?: AbortSignal
  /** 覆盖默认 5 秒超时。两者都设置时，每个 hook 的 `entry.timeout`
   *  仍然优先。两者都被限制在 30 秒以内。 */
  defaultTimeoutMs?: number
}

/** 针对一个事件运行一个 hook。返回解析后的决策（任何意外情况默认 allow）。
 *  除非调用方的 AbortSignal 触发，否则绝不抛异常 —— 中止是唯一值得
 *  向上抛的错误，因为此时调用方的循环已经在收尾。 */
export async function executeHook(
  hook: RegisteredHook,
  event: HookEvent,
  opts: ExecuteHookOptions = {},
): Promise<HookDecision> {
  const timeoutMs = Math.min(hook.entry.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const vars = buildVariableContext({
    pluginDir: hook.pluginDir,
    cwd: event.session.cwd,
    pluginId: hook.pluginId,
  })
  const expandedCommand = expandVariables(pickPlatformCommand(hook.entry), vars)
  const stdinPayload = JSON.stringify(buildStdinPayload(hook, event))

  // 把所属插件的 userConfig 值合并进 hook 的环境变量。
  // 需要 manifest 中声明的 API key 的 hook 脚本可直接读
  // `process.env[KEY]`，无需任何胶水代码 —— 命令字符串中的 `${env:KEY}`
  // 替换也基于这份合并后的环境解析。读取出错时静默失败
  // （尚未设置 userConfig ⇒ 空映射）。
  let pluginEnv: Record<string, string> = {}
  try {
    pluginEnv = await getPluginUserConfigEnv(hook.pluginId)
  } catch (err) {
    debugLog('hooks.user-config-read-failed', `${hook.pluginId}: ${String(err)}`)
  }

  try {
    const sandbox = isExtensionSandboxActive() ? getShellSandbox() : null
    const wrapped = sandbox ? wrapShellSpawn('/bin/sh', ['-c', expandedCommand], sandbox) : null
    // Hook 作者依赖继承的环境来获取 PATH 和 locale，但
    // 形如凭证的变量不应泄漏进沙箱化的 hook。插件的
    // 自有 userConfig 值则特意在之后重新加入。
    const inherited = sandbox ? sanitizeShellEnv(process.env, sandbox) : process.env
    const result = await execa(wrapped?.executable ?? expandedCommand, wrapped?.args ?? [], {
      shell: !wrapped,
      input: stdinPayload,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      stdio: 'pipe',
      reject: false, // 非零退出在下方显式处理，而不是作为异常抛出。
      cwd: event.session.cwd,
      env: { ...inherited, ...pluginEnv },
    })

    if (opts.signal?.aborted) {
      // 执行途中被中止。调用方的循环正在收尾 —— 通过抛错
      // 暴露出来，让总线停止级联触发后续 hook。
      throw new Error('aborted')
    }

    if (result.timedOut) {
      debugLog('hooks.exec-timeout', `${hook.pluginId} ${event.name}: timed out after ${timeoutMs}ms`)
      return failurePolicyDecision(hook, `hook timed out after ${timeoutMs}ms`)
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      const stderrTail = (result.stderr ?? '').toString().slice(0, 200)
      debugLog('hooks.exec-nonzero', `${hook.pluginId} ${event.name}: exit ${result.exitCode} stderr=${stderrTail}`)
      return failurePolicyDecision(hook, `hook exited ${result.exitCode}`)
    }

    const decision = parseDecision(result.stdout ?? '', hook, event)
    // 追踪成功的 hook 运行，让插件作者无需自己加日志
    // 就能确认 hook 确实触发了。
    // stdio 是 `pipe` 的（我们从 stdout 读 JSON 决策），所以
    // hook 写到自身 stderr 的内容原本不可见 —— 这条面包屑正是
    // `--plugin-debug` / `DEBUG_STDOUT=1` 用户用来 grep 验证
    // 接线是否正确的依据。
    debugLog('hooks.exec-ran', `${hook.pluginId} ${event.name}: decision=${decision.decision}`)
    return decision
  } catch (err) {
    if (opts.signal?.aborted) throw err
    debugLog('hooks.exec-error', `${hook.pluginId} ${event.name}: ${String(err)}`)
    return failurePolicyDecision(hook, `hook crashed: ${errorMessage(err)}`)
  }
}

function failurePolicyDecision(hook: RegisteredHook, reason: string): HookDecision {
  if (hook.entry.failurePolicy === 'block') return { decision: 'deny', reason }
  return { decision: 'allow' }
}

/** 构建通过 stdin 发给 hook 的 JSON 对象。事件专属字段
 *  被扁平化到顶层（与 Claude Code 的 hook 协议形状一致）。 */
function buildStdinPayload(hook: RegisteredHook, event: HookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: event.name,
    session: event.session,
    plugin: { id: hook.pluginId, dir: hook.pluginDir },
  }
  switch (event.name) {
    case 'UserPromptSubmit':
      base.prompt = event.prompt
      break
    case 'PreToolUse':
      base.tool = event.tool
      break
    case 'PostToolUse':
      base.tool = event.tool
      break
    case 'PreCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.tokenEstimate = event.tokenEstimate
      break
    case 'PostCompact':
      base.trigger = event.trigger
      base.messageCount = event.messageCount
      base.summary = event.summary
      break
    case 'SubagentStart':
      base.agent = event.agent
      break
    case 'SubagentStop':
      base.agent = event.agent
      base.durationMs = event.durationMs
      base.outcome = event.outcome
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    case 'TurnComplete':
      base.turn = event.turn
      if (event.tokenUsage) base.tokenUsage = event.tokenUsage
      break
    // SessionStart / SessionEnd 除 session/plugin 外没有额外字段。
  }
  return base
}

function parseDecision(stdout: string, hook: RegisteredHook, event: HookEvent): HookDecision {
  const trimmed = (stdout ?? '').toString().trim()
  if (!trimmed) return { decision: 'allow' }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const d = obj.decision
      if (d === 'allow' || d === 'deny' || d === 'modify') {
        return obj as HookDecision
      }
    }
  } catch {
    // 不是 JSON —— 许多 hook 的 stdout 是给人看的（日志）。按默认
    // allow 处理，但记录面包屑，以防用户原本期望它能影响代理。
    debugLog(
      'hooks.decision-not-json',
      `${hook.pluginId} ${event.name}: ignoring non-JSON stdout: ${trimmed.slice(0, 200)}`,
    )
  }
  return { decision: 'allow' }
}
