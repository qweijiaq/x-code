// @x-code-cli/core — Hook 事件总线
//
// 位于 [[HookRegistry]] 之上的薄编排层。代理循环、
// 工具执行、压缩和子代理运行器在十个生命周期节点调用 `bus.emit(event)`；
// 总线按 matcher 过滤 hook（仅 PreToolUse / PostToolUse），运行它们，
// 并返回聚合后的决策。
//
// 串行 vs 并行：
//
//   决策事件（UserPromptSubmit / PreToolUse / PostToolUse）串行运行。
//   一个 `deny` 会让后续 hook 短路 —— 代理在第一个 stop 处停下。
//   顺序即注册顺序，因此插件作者得到确定性的行为。
//
//   即发即忘事件（SessionStart / PreCompact / PostCompact /
//   SubagentStart / SubagentStop / TurnComplete / SessionEnd）并行运行 ——
//   它们没有决策，也没有顺序问题。
//
// 总线捕获每个 hook 的错误并降级为 `allow`，这样一个损坏的 hook
// 绝不会阻塞循环。执行器已经处理了“非零退出 / 超时 → allow” ——
// 这一层增加的是 matcher 正则的错误防护。
import { debugLog } from '../utils.js'
import { type ExecuteHookOptions, executeHook } from './executor.js'
import { type HookRegistry, emptyHookRegistry } from './registry.js'
import type { HookDecision, HookEvent, RegisteredHook } from './types.js'

export interface EmitOptions extends ExecuteHookOptions {
  /** 强制并行执行。默认是决策事件串行、
   *  即发即忘事件并行。调用方几乎从不覆盖。 */
  parallel?: boolean
}

export interface ToolHookSnapshot {
  readonly generation: number
  readonly toolName: string
  readonly preHooks: readonly RegisteredHook[]
  readonly postHooks: readonly RegisteredHook[]
}

export class HookBus {
  // 可变，以便 /plugin refresh 能换入新的注册表而无需
  // 强迫调用方重新捕获总线引用。之后新到达的事件发射
  // 会看到新 hook；任何进行中的 executeHook 调用仍针对旧注册表完成
  // （这是刻意的 —— 让 hook 跑完比协调关闭更省事）。
  private registryGeneration = 0

  constructor(private registry: HookRegistry) {}

  has(event: HookEvent['name']): boolean {
    return this.registry.has(event)
  }

  /** 替换内部注册表。由 /plugin refresh 在重新扫描后使用，
   *  以纳入新安装 / 已移除的插件 hook。 */
  replaceRegistry(registry: HookRegistry): void {
    this.registry = registry
    this.registryGeneration++
  }

  captureToolSnapshot(toolName: string): ToolHookSnapshot {
    return Object.freeze({
      generation: this.registryGeneration,
      toolName,
      preHooks: Object.freeze(
        this.registry
          .get('PreToolUse')
          .filter((hook) => matchesTool(hook, toolName))
          .slice(),
      ),
      postHooks: Object.freeze(
        this.registry
          .get('PostToolUse')
          .filter((hook) => matchesTool(hook, toolName))
          .slice(),
      ),
    })
  }

  async emitToolSnapshot(
    snapshot: ToolHookSnapshot,
    phase: 'pre' | 'post',
    event: Extract<HookEvent, { name: 'PreToolUse' | 'PostToolUse' }>,
    opts: EmitOptions = {},
  ): Promise<HookDecision[]> {
    const expectedName = phase === 'pre' ? 'PreToolUse' : 'PostToolUse'
    if (event.name !== expectedName || event.tool.name !== snapshot.toolName) {
      throw new Error(`Hook snapshot mismatch: expected ${expectedName} for ${snapshot.toolName}`)
    }
    if ('authority' in event && (event.authority?.peerTainted || event.authority?.source === 'peer')) return []
    return this.emitHooks(phase === 'pre' ? snapshot.preHooks : snapshot.postHooks, event, opts)
  }

  /** 发射一个事件。按运行顺序返回各 hook 的决策 —— 没有匹配的 hook 时
   *  为空。调用方通常只对三个 DecisionEvent 检查结果；对其余事件
   *  仅 await 完成以获取副作用。 */
  async emit(event: HookEvent, opts: EmitOptions = {}): Promise<HookDecision[]> {
    if ('authority' in event && (event.authority?.peerTainted || event.authority?.source === 'peer')) return []
    const hooks = this.registry.get(event.name)
    if (hooks.length === 0) return []

    const applicable = hooks.filter((h) => matches(h, event))
    if (applicable.length === 0) return []

    return this.emitHooks(applicable, event, opts)
  }

  private async emitHooks(
    applicable: readonly RegisteredHook[],
    event: HookEvent,
    opts: EmitOptions,
  ): Promise<HookDecision[]> {
    const isDecisionEvent =
      event.name === 'UserPromptSubmit' || event.name === 'PreToolUse' || event.name === 'PostToolUse'
    const parallel = opts.parallel ?? !isDecisionEvent

    if (parallel) {
      // 对即发即忘事件我们仍 await 结果，以保证调用方
      // await 至完成的语义成立；只是不串行执行。
      // 单个 hook 失败不会让整批失败（执行器失败时返回 `allow`）。
      const settled = await Promise.allSettled(applicable.map((h) => executeHook(h, event, opts)))
      const out: HookDecision[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(r.value)
        else {
          if (opts.signal?.aborted) throw r.reason
          debugLog('hooks.bus-error', `${event.name}: ${String(r.reason)}`)
          out.push({ decision: 'allow' })
        }
      }
      return out
    }

    // 串行：第一个 `deny` 就停止其余 hook。modify 决策通过调用方
    // 叠加到下一个 hook 的输入上（我们只负责收集它们）。
    const decisions: HookDecision[] = []
    for (const h of applicable) {
      try {
        const d = await executeHook(h, event, opts)
        decisions.push(d)
        if (d.decision === 'deny') break
      } catch (err) {
        if (opts.signal?.aborted) throw err
        debugLog('hooks.bus-error', `${h.pluginId} ${event.name}: ${String(err)}`)
        decisions.push({ decision: 'allow' })
      }
    }
    return decisions
  }
}

/** 一个未注册任何 hook 的总线。CLI 在插件被禁用（`--no-plugins`）
 *  时传入它，这样代理循环的发射点就不需要判空。 */
export function emptyHookBus(): HookBus {
  return new HookBus(emptyHookRegistry())
}

function matches(hook: RegisteredHook, event: HookEvent): boolean {
  if (event.name !== 'PreToolUse' && event.name !== 'PostToolUse') return true
  return matchesTool(hook, event.tool.name)
}

function matchesTool(hook: RegisteredHook, toolName: string): boolean {
  if (!hook.entry.matcher) return true
  try {
    return new RegExp(hook.entry.matcher).test(toolName)
  } catch (err) {
    // 错误的正则不应让 hook 静默失效 —— 降级为
    // “匹配所有工具”，但记录日志以便排查错误模式。
    debugLog('hooks.matcher-invalid', `${hook.pluginId}: ${String(err)}`)
    return true
  }
}

// ── 代理循环发射点使用的决策聚合辅助函数 ──

/** 把一组 PreToolUse 决策折叠为单一有效结果。
 *  顺序重要：deny 在 `emit` 中更早就短路，因此
 *  这里看到 `deny` 就是最终结论。modify 会叠加 ——
 *  最后一个带 `args` 的 `modify` 生效（后面的插件细化前面的插件）。 */
export interface PreToolEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** 修改后的 args，或 undefined 表示用原始值。 */
  args?: unknown
  /** 要注入的额外上下文（PreToolUse 少见；为对称性而支持）。 */
  context?: string
}

export function aggregatePreToolUse(decisions: ReadonlyArray<HookDecision>): PreToolEffect {
  let args: unknown
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason }
    if (d.decision === 'modify') {
      if (d.args !== undefined) args = d.args
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { decision: 'allow', args, context }
}

export interface PostToolEffect {
  /** 替换后的输出，或 undefined 表示保留原始值。 */
  output?: string
  context?: string
}

export function aggregatePostToolUse(decisions: ReadonlyArray<HookDecision>): PostToolEffect {
  let output: string | undefined
  let context: string | undefined
  for (const d of decisions) {
    if (d.decision === 'modify') {
      if (typeof d.output === 'string') output = d.output
      if (d.context) context = d.context
    } else if (d.decision === 'allow' && d.context) {
      context = d.context
    }
  }
  return { output, context }
}

export interface UserPromptEffect {
  decision: 'allow' | 'deny'
  reason?: string
  /** 每个 hook 的上下文拼接结果，可直接前置到用户消息。
   *  没有 hook 注入任何内容时为空字符串。 */
  context: string
}

export function aggregateUserPromptSubmit(decisions: ReadonlyArray<HookDecision>): UserPromptEffect {
  const contexts: string[] = []
  for (const d of decisions) {
    if (d.decision === 'deny') return { decision: 'deny', reason: d.reason, context: '' }
    // `context` 同时出现在 'allow' 和 'modify' 分支上；上面的
    // 收窄已排除 'deny'，因此这里是安全的。
    if (d.decision === 'allow' && d.context) contexts.push(d.context)
    else if (d.decision === 'modify' && d.context) contexts.push(d.context)
  }
  return { decision: 'allow', context: contexts.join('\n\n') }
}
