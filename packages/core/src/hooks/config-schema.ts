// @x-code-cli/core — hooks.json 的 zod 模式
//
// 校验 `HookConfig`，无论它来自磁盘上的 hooks.json 文件还是
// 内联的 manifest 对象。两条路径用同一模式 —— 让失败模式保持一致，
// 这样插件作者不会因为用了哪种形式而得到不同的错误。
//
// `matcher` 里的坏正则不是模式错误 —— 要求作者针对 zod 的严格模式
// 编写 / 测试自己的正则会很麻烦。总线在发射时捕获 RegExp 构造错误，
// 并降级为“匹配所有工具”（记录日志以供排查）。
import { z } from 'zod'

import type { HookConfig } from './types.js'

const hookEntrySchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  // 平台专属覆盖。可选；某平台上缺失则回退到 `command`。
  // 我们刻意不要求至少设置其中一个 —— 基础命令始终是必需的。
  commandWindows: z.string().min(1).optional(),
  commandDarwin: z.string().min(1).optional(),
  commandLinux: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(30_000).optional(),
  description: z.string().optional(),
  failurePolicy: z.enum(['allow', 'block']).optional(),
})

export const hookConfigSchema = z
  .object({
    SessionStart: z.array(hookEntrySchema).optional(),
    UserPromptSubmit: z.array(hookEntrySchema).optional(),
    PreToolUse: z.array(hookEntrySchema).optional(),
    PostToolUse: z.array(hookEntrySchema).optional(),
    PreCompact: z.array(hookEntrySchema).optional(),
    PostCompact: z.array(hookEntrySchema).optional(),
    SubagentStart: z.array(hookEntrySchema).optional(),
    SubagentStop: z.array(hookEntrySchema).optional(),
    TurnComplete: z.array(hookEntrySchema).optional(),
    SessionEnd: z.array(hookEntrySchema).optional(),
  })
  // 容忍未知键以保持前向兼容（未来的事件名）。
  .passthrough()

export class HookConfigParseError extends Error {
  constructor(
    message: string,
    public readonly sourceLabel: string,
  ) {
    super(message)
    this.name = 'HookConfigParseError'
  }
}

/** 校验已解析为对象的形式。用于内联 manifest
 *  配置以及 JSON.parse 之后的 hooks.json 正文。 */
export function parseHookConfig(raw: unknown, sourceLabel: string): HookConfig {
  const result = hookConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new HookConfigParseError(`invalid hooks config — ${issues}`, sourceLabel)
  }
  // 在类型边界剥离未知的未来键 —— passthrough 把它们
  // 保留在运行时对象上，但我们的 HookConfig 类型只认识
  // 那十个事件。
  const known: HookConfig = {}
  for (const k of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'TurnComplete',
    'SessionEnd',
  ] as const) {
    const arr = (result.data as Record<string, unknown>)[k]
    if (Array.isArray(arr)) known[k] = arr as HookConfig[typeof k]
  }
  return known
}
