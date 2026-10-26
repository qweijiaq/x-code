// @x-code-cli/core — MCP 配置的 Zod schema
//
// 校验 ~/.x-code/config.json（以及项目级 .x-code/config.json）里的
// `mcpServers` 字段。一个 schema 同时覆盖 stdio 与 streamable-http
// 服务器；联合类型的判别依据是字段是否存在：`command` → stdio，
// `url` → http。两者都缺（或都有）的配置会在我们尝试 spawn 之前就被拒绝。
import { z } from 'zod'

import { errorMessage } from '../utils.js'
import type { McpServerConfig } from './types.js'

/** 一个宽松 schema 覆盖两种 transport。字段是否存在（`command` vs `url`）
 *  是判别依据，通过 superRefine 而非 z.union 强制——union 的逐变体校验
 *  会在两个字段都缺失时隐藏我们的"恰好其一"规则（Zod 只会说
 *  "Invalid input"，因为没有变体匹配）。用扁平 schema + superRefine，
 *  我们能为每种畸形情况得到可读的错误信息。 */
const serverSchema = z
  .object({
    type: z.enum(['stdio', 'http']).optional(),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    env: z.record(z.string().min(1).max(256), z.string().max(65_536)).optional(),
    cwd: z.string().max(4096).optional(),
    url: z
      .string()
      .url()
      .max(8192)
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'MCP URL must use http or https')
      .optional(),
    headers: z.record(z.string().min(1).max(256), z.string().max(16_384)).optional(),
    timeout: z.number().int().positive().max(300_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasCommand = typeof v.command === 'string'
    const hasUrl = typeof v.url === 'string'
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry has both `command` and `url` — set only one',
      })
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry must set either `command` (stdio) or `url` (http)',
      })
    }
    // 跨字段校验：stdio 配置里的 HTTP 专属字段，反之亦然。并非严格要求
    // （运行时多余的字段会被忽略），但错误信息能尽早发现笔误。
    if (hasCommand && typeof v.headers !== 'undefined') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`headers` is only valid for HTTP servers' })
    }
    if (hasUrl && (v.args || v.env || v.cwd)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`args`/`env`/`cwd` are only valid for stdio servers' })
    }
    if ((v.type === 'stdio' && !hasCommand) || (v.type === 'http' && !hasUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`type` does not match the configured MCP transport' })
    }
  })

const MAX_MCP_SERVERS = 128

export const mcpServersSchema = z
  .record(z.string().min(1).max(128), serverSchema)
  .refine(
    (servers) => Object.keys(servers).length <= MAX_MCP_SERVERS,
    `at most ${MAX_MCP_SERVERS} MCP servers are allowed`,
  )

/** 校验单个服务器配置；失败时抛出带上下文标记的错误信息。包含服务器名，
 *  使错误能告诉用户其 config.json 中哪一项是坏的。 */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const result = serverSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ')
    throw new Error(`mcpServers.${name}: ${issues}`)
  }
  return result.data as McpServerConfig
}

/** 校验整个 `mcpServers` 块。返回部分结果：所有干净解析的条目都包含在内；
 *  损坏的条目出现在 `errors` 中，使 loader 能把它们标记为 `failed` 而不
 *  中止整个配置。 */
export function parseServersBlock(raw: unknown): {
  servers: Record<string, McpServerConfig>
  errors: Array<{ name: string; message: string }>
} {
  const servers: Record<string, McpServerConfig> = {}
  const errors: Array<{ name: string; message: string }> = []

  if (raw === undefined || raw === null) return { servers, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: '(root)', message: 'mcpServers must be an object' })
    return { servers, errors }
  }

  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_MCP_SERVERS) {
    errors.push({ name: '*', message: `At most ${MAX_MCP_SERVERS} MCP servers are allowed` })
  }
  for (const [name, entry] of entries.slice(0, MAX_MCP_SERVERS)) {
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
      errors.push({ name, message: 'MCP server name must be 1-128 characters without control characters' })
      continue
    }
    try {
      servers[name] = parseServerConfig(name, entry)
    } catch (err) {
      errors.push({ name, message: errorMessage(err) })
    }
  }

  return { servers, errors }
}
