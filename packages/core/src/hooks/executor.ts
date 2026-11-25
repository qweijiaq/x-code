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
  // `hook.entry.timeout` 来自 manifest，是未经校验的外部输入。0 / 负数会让
  // execa 不挂超时定时器（插件的作者常把 0 理解为"不限"），NaN 则让
  // `Math.min` 得到 NaN——两者都与文件头"损坏的 hook 绝不能卡死代理循环"
  // 的约定冲突：一个挂死的 hook 就能无限期阻塞 agent 循环。
  const requestedTimeout = hook.entry.timeout ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(
    Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  if (timeoutMs !== requestedTimeout) {
    debugLog('hooks.timeout-clamped', `${hook.pluginId} ${event.name}: ${String(hook.entry.timeout)} -> ${timeoutMs}ms`)
  }

  // 把所属插件的 userConfig 值合并进 hook 的环境变量。
  // 需要 manifest 中声明的 API key 的 hook 脚本可直接读
  // `process.env[KEY]`，无需任何胶水代码 —— 命令字符串中的 `${env:KEY}`
  // 替换也基于这份合并后的环境解析（因此必须在展开**之前**读取）。
  // 读取出错时静默失败（尚未设置 userConfig ⇒ 空映射）。
  let pluginEnv: Record<string, string> = {}
  try {
    pluginEnv = await getPluginUserConfigEnv(hook.pluginId)
  } catch (err) {
    debugLog('hooks.user-config-read-failed', `${hook.pluginId}: ${String(err)}`)
  }

  // 环境准备、命令展开与 stdin 序列化全部放在 try 里：`event.session.cwd`
  // 在 session 缺失时会抛 TypeError，manifest 里的 command 可能是非字符串
  // （`expandVariables` 内部直接 `source.replace`），`JSON.stringify` 遇到
  // BigInt / 循环引用也会抛。任何一个冒出 try 之外都会中断整条 hook 级联，
  // 而不是按 `failurePolicy` 降级。
  try {
    const command = pickPlatformCommand(hook.entry)
    if (typeof command !== 'string' || command.trim() === '') {
      debugLog('hooks.invalid-command', `${hook.pluginId} ${event.name}: hook entry has no runnable command`)
      return failurePolicyDecision(hook, 'hook entry has no runnable command')
    }

    const sandbox = isExtensionSandboxActive() ? getShellSandbox() : null
    // Hook 作者依赖继承的环境来获取 PATH 和 locale，但
    // 形如凭证的变量不应泄漏进沙箱化的 hook。插件的
    // 自有 userConfig 值则特意在之后重新加入。
    const inherited = sanitizeShellEnv(process.env, sandbox ?? { ...getShellSandbox(), enabled: false })
    const vars = buildVariableContext({
      pluginDir: hook.pluginDir,
      cwd: event.session.cwd,
      pluginId: hook.pluginId,
    })
    const expandedCommand = expandVariables(command, {
      ...vars,
      env: { ...inherited, ...pluginEnv },
    })
    const stdinPayload = JSON.stringify(buildStdinPayload(hook, event))

    const wrapped = sandbox ? wrapShellSpawn('/bin/sh', ['-c', expandedCommand], sandbox) : null
    const result = await execa(wrapped?.executable ?? expandedCommand, wrapped?.args ?? [], {
      shell: !wrapped,
      input: stdinPayload,
      timeout: timeoutMs,
      cancelSignal: opts.signal,
      stdio: 'pipe',
      reject: false, // 非零退出在下方显式处理，而不是作为异常抛出。
      cwd: event.session.cwd,
      extendEnv: false,
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
    // 被信号杀死（SIGKILL / SIGSEGV / 子进程自行 SIGTERM，且不走 timeout /
    // abort 路径）时 execa 的 `exitCode` 是 undefined，只看 exitCode 会让这类
    // 异常终止继续走 `parseDecision`，多半得到一个 allow——把崩溃当成放行。
    if (
      result.failed ||
      result.signal !== undefined ||
      (typeof result.exitCode === 'number' && result.exitCode !== 0)
    ) {
      const stderrTail = (result.stderr ?? '').toString().slice(0, 200)
      debugLog(
        'hooks.exec-nonzero',
        `${hook.pluginId} ${event.name}: exit ${String(result.exitCode)} signal=${result.signal ?? 'none'} stderr=${stderrTail}`,
      )
      return failurePolicyDecision(
        hook,
        result.signal !== undefined ? `hook killed by ${result.signal}` : `hook exited ${String(result.exitCode)}`,
      )
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

/** 把 hook 返回的对象窄化成 `HookDecision`：只保留协议里声明的字段，并校验
 *  类型。hook 的 stdout 是不可信输入，`output`/`context` 若是数字或对象，
 *  原样透传会让下游拼接上下文时崩掉；未知字段也不该流进 agent 循环。 */
function narrowDecision(obj: Record<string, unknown>): HookDecision | null {
  switch (obj.decision) {
    case 'allow':
      return typeof obj.context === 'string' ? { decision: 'allow', context: obj.context } : { decision: 'allow' }
    case 'deny':
      return typeof obj.reason === 'string' ? { decision: 'deny', reason: obj.reason } : { decision: 'deny' }
    case 'modify': {
      const modify: Extract<HookDecision, { decision: 'modify' }> = { decision: 'modify' }
      if (obj.args !== undefined) modify.args = obj.args
      if (typeof obj.output === 'string') modify.output = obj.output
      if (typeof obj.context === 'string') modify.context = obj.context
      return modify
    }
    default:
      return null
  }
}

function parseDecision(stdout: string, hook: RegisteredHook, event: HookEvent): HookDecision {
  // 逐行（从尾向前）尝试解析：hook 里常见的写法是先打一行日志再输出决策
  // JSON。整体 `JSON.parse` 会因为那行日志而失败并落到 allow，等于把一个
  // 本意 `deny` 的 hook 静默 fail-open —— 而文件头写的是"stdout 上的其他
  // 内容被忽略"。
  const lines = (stdout ?? '').toString().split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const trimmed = lines[index]!.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const decision = narrowDecision(parsed as Record<string, unknown>)
    if (decision) return decision
  }

  // 没有任何一行是可解析的合法决策 —— 许多 hook 的 stdout 是给人看的
  // （日志）。按默认 allow 处理，但记录面包屑，以防用户原本期望它能影响代理。
  const preview = (stdout ?? '').toString().trim().slice(0, 200)
  if (preview) {
    debugLog('hooks.decision-not-json', `${hook.pluginId} ${event.name}: ignoring non-JSON stdout: ${preview}`)
  }
  return { decision: 'allow' }
}
