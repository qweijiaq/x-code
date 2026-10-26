// @x-code-cli/core — Hooks 子系统类型
//
// hook 是插件针对十个代理生命周期事件之一注册的 shell 命令。
// CLI 把事件负载以一行 JSON 写到 hook 的 stdin；hook 可在 stdout
// 用一行 JSON `HookDecision` 回复，以影响代理下一步做什么
// （allow / deny / 修改 args / 注入上下文）。
//
// 为什么用 shell 命令而不是程序化 SDK：对插件作者门槛最低，
// 与用户在 Claude Code 里已看到的格式一致，且让表面积保持很小
// （没有插件代码在我们的进程内运行）。完整理由见
// [[plugin-marketplace-design]] §8。
//
// 为什么是十个事件：足以覆盖高价值的生命周期集成
// （上下文注入、工具门控、子代理审计、压缩插桩、完成通知），
// 而不必暴露每个我们以后可能想重构的内部接缝。以后新增事件很便宜；
// 删除事件则是破坏性变更。PreCompact / PostCompact 和
// SubagentStart / SubagentStop 在第二轮加入以对齐
// Claude/Codex 的形状 —— 想记录每次子代理调用、
// 或在压缩抹除状态前持久化状态的插件此前没有其他可挂载的 hook。
import type { ExecutionAuthority } from '../types/index.js'

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TurnComplete'
  | 'SessionEnd'

/** 会产生代理需要执行的决策的事件子集。其余事件
 *  是即发即忘 —— hook 可以执行副作用（日志、
 *  通知），但代理忽略它们的 stdout。 */
export type DecisionEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

/** hooks.json 中出现的单个 hook 条目。 */
export interface HookConfigEntry {
  /** 匹配工具名的可选正则。仅对 PreToolUse /
   *  PostToolUse 有意义 —— 其他事件忽略。缺失 matcher 表示
   *  “所有工具”。 */
  matcher?: string
  /** 未设置下方平台专属覆盖时，在当前平台上运行的 shell 命令。
   *  支持 `${pluginDir}` / `${pluginDataDir}` / `${cwd}` / `${homedir}` /
   *  `${env:NAME}` / `${sep}` 变量展开（见 [[variables]]）。
   *
   *  即使设置了平台覆盖，我们仍要求提供此命令，这样插件作者
   *  就不会意外发布一个只在*某一个*操作系统上运行的插件 ——
   *  基础命令是作者未显式考虑的平台的安全网。 */
  command: string
  /** 平台专属覆盖命令。设置后，匹配的那个在该操作系统上
   *  替代 `command`。键与 `process.platform` 的值对应；
   *  未知平台（freebsd / sunos / aix）回退到基础 `command`。 */
  commandWindows?: string
  commandDarwin?: string
  commandLinux?: string
  /** 每个 hook 的超时时间（毫秒，默认 5000，上限 30000）。 */
  timeout?: number
  description?: string
  /** hook 非零退出或崩溃时的处理方式：
   *
   *    'allow'（默认）— 记录警告，视同 hook 说了 allow
   *    'block'         — 视同 deny（仅对 DecisionEvent 有意义）
   *
   *  默认宽松是刻意的：损坏的 hook 绝不能
   *  无限期卡死代理循环。 */
  failurePolicy?: 'allow' | 'block'
}

/** 一个完整的 hooks.json 文件。每个事件名映射到一个有序的
 *  条目数组 —— 靠前的条目先运行，对决策事件而言 deny
 *  会短路其余条目。 */
export type HookConfig = Partial<Record<HookEventName, HookConfigEntry[]>>

/** 附加到每个事件负载的会话级上下文。 */
export interface SessionContext {
  cwd: string
  modelId: string
  /** 可选 —— CLI 分配会话 id 时我们透传它，
   *  这样 hook 能关联事件。 */
  sessionId?: string
}

/** 所有事件负载形状的可辨识联合。`name` 字段兼作标签。
 *  CLI 构建这些并交给 [[HookBus.emit]] —— 执行器将其序列化为 JSON
 *  写入 stdin。 */
export type HookEvent =
  | { name: 'SessionStart'; session: SessionContext }
  | { name: 'UserPromptSubmit'; session: SessionContext; prompt: string; authority?: ExecutionAuthority }
  | {
      name: 'PreToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string }
      authority?: ExecutionAuthority
    }
  | {
      name: 'PostToolUse'
      session: SessionContext
      tool: { name: string; args: unknown; callId: string; output: string; isError: boolean }
      authority?: ExecutionAuthority
    }
  | {
      name: 'PreCompact'
      session: SessionContext
      /** 压缩即将执行的原因 —— 对想决定是否做状态检查点
       *  或跳过的 hook 有用。 */
      trigger: 'proactive' | 'reactive'
      /** 压缩前的大致消息数和 token 数。 */
      messageCount: number
      tokenEstimate: number
      authority?: ExecutionAuthority
    }
  | {
      name: 'PostCompact'
      session: SessionContext
      trigger: 'proactive' | 'reactive'
      /** 压缩后的消息数 —— 与 PreCompact 的 messageCount 之差
       *  告诉 hook 回收了多少。 */
      messageCount: number
      /** 轻量压缩（未写 LLM 摘要）时为空字符串。 */
      summary: string
      authority?: ExecutionAuthority
    }
  | {
      name: 'SubagentStart'
      session: SessionContext
      agent: {
        /** 子代理的注册名（如 `code-reviewer`）。 */
        name: string
        /** 父代理的一行任务描述。 */
        description: string
        /** 父代理发给子代理的完整提示词。 */
        prompt: string
      }
      authority?: ExecutionAuthority
    }
  | {
      name: 'SubagentStop'
      session: SessionContext
      agent: {
        name: string
        description: string
      }
      /** 子代理运行的墙钟时长。 */
      durationMs: number
      /** 子代理如何结束。`aborted` 包括 Esc 取消
       *  以及未完成就达到每个代理的 maxTurns 上限。 */
      outcome: 'completed' | 'aborted' | 'failed'
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
      authority?: ExecutionAuthority
    }
  | {
      name: 'TurnComplete'
      session: SessionContext
      turn: number
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }
      authority?: ExecutionAuthority
    }
  | { name: 'SessionEnd'; session: SessionContext; authority?: ExecutionAuthority }

/** hook 可以通过其 stdout JSON 请求代理做的事情。 */
export type HookDecision =
  | { decision: 'allow'; context?: string }
  | { decision: 'deny'; reason?: string }
  | { decision: 'modify'; args?: unknown; output?: string; context?: string }

/** 一个可执行的 hook —— 与其所属插件的身份和 rootDir 配对，
 *  以便变量展开能解析 `${pluginDir}`。由 [[buildHookRegistry]]
 *  在启动时构建，会话期间不可变。 */
export interface RegisteredHook {
  pluginId: string
  /** 插件根目录的绝对路径 —— 通过 `${pluginDir}`
   *  替换进 hook 命令。 */
  pluginDir: string
  event: HookEventName
  entry: HookConfigEntry
}
