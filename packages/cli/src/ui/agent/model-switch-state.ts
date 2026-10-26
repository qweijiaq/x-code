import { markExpectedCacheMiss } from '@x-code-cli/core'
import type { LoopState } from '@x-code-cli/core'

/** 使每个内容可能依赖模型能力的缓存表面失效。已激活的名称会存活下来，并在
 *  下一次提交时针对新构建的目录解析，因此过期的 schema 对象绝不会被复用。 */
export function invalidateModelDependentState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'model-change')
}

/** 在 registry 或 MCP 表面变化后，使提示词和延迟工具元数据失效。把缓存未命中
 *  原因与失效放在一起，能防止合法的刷新被报告为意外的未命中。 */
export function invalidateToolSurfaceState(state: LoopState | null): void {
  if (!state) return
  state.systemPromptCache = null
  state.deferredCatalog = undefined
  markExpectedCacheMiss(state, 'tool-surface-change')
}
