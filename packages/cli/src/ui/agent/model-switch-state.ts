import { markExpectedCacheMiss } from '@x-code-cli/core'
import type { LoopState } from '@x-code-cli/core'

/** 使每个内容可能依赖模型能力的缓存表面失效。已激活的名称会存活下来，并在
 *  下一次提交时针对新构建的目录解析，因此过期的 schema 对象绝不会被复用。 */
export function invalidateModelDependentState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  // 与 systemPromptCache 成对清理（同 core `agent/loop.ts` 的 model fallback）：
  // blocks 里快照的是按模型能力裁剪过的 skill/mcpDeferred 块，残留旧快照会让
  // 上下文构成估算按旧块做减法。
  state.systemPromptBlocks = undefined
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'model-change')
}

/** 在 registry 或 MCP 表面变化后，使提示词和延迟工具元数据失效。把缓存未命中
 *  原因与失效放在一起，能防止合法的刷新被报告为意外的未命中。 */
export function invalidateToolSurfaceState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  // MCP/skill 表面变化改写的正是 blocks 里的 skill/mcpDeferred 字段。
  state.systemPromptBlocks = undefined
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'tool-surface-change')
}
