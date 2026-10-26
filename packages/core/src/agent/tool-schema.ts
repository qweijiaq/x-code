import { zodToJsonSchema } from 'zod-to-json-schema'

import { estimateTextTokenCount } from './context-window.js'

/** 估算单个函数工具面向模型的线上体积。由直接工具预算与 /usage 共享，
 *  使策略与可观测性使用同一个数字。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function estimateToolDefinitionTokens(name: string, def: any): number {
  const payload: Record<string, unknown> = { name }
  if (typeof def?.description === 'string') payload.description = def.description
  const schema = def?.inputSchema
  if (schema) {
    try {
      const rawJsonSchema =
        typeof schema === 'object' && schema !== null ? (schema as { jsonSchema?: unknown }).jsonSchema : undefined
      if (rawJsonSchema && typeof rawJsonSchema === 'object') {
        payload.parameters = rawJsonSchema
      } else {
        payload.parameters = zodToJsonSchema(schema)
      }
    } catch {
      try {
        payload.parameters = JSON.stringify(schema)
      } catch {
        // 未知的循环 schema：description + name 仍能提供下界。
      }
    }
  }
  return estimateTextTokenCount(JSON.stringify(payload))
}

export function estimateToolSetTokens(tools: Record<string, unknown>): number {
  return Object.entries(tools).reduce((sum, [name, def]) => sum + estimateToolDefinitionTokens(name, def), 0)
}
