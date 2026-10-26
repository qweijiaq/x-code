// @x-code-cli/core — 把 toolSearch 查询解析到延迟目录上
//
// 激活模型（与 Claude Code / Codex 不同）：它们依赖 provider 侧的 `defer_loading` +
// tool_reference / tool_search_output 握手，在服务端展开被发现的工具 schema。我们跨多个
// provider 走 Vercel AI SDK，它暴露不了这些——于是我们直接把匹配到的工具拼进请求的
// `tools` map（见 composeTurnTools），让它们在下一步变得可调用。最终效果相同、与 provider
// 无关，代价是每个工具首次使用时多一次往返。
//
// 该函数是纯函数：activatedTools 的变更和 tool_result 的推送由调用方（tool-execution.ts）
// 负责。
import type { DeferredToolEntry } from './catalog.js'
import { searchDeferredTools } from './search.js'

export interface ToolSearchResult {
  /** 面向模型的 tool_result 文本。 */
  text: string
  /** 要加入 LoopState.activatedTools 的 callable 名称。 */
  activated: string[]
}

/** 在目录上解析 toolSearch 查询。同时处理 `select:` 精确加载路径和关键词路径。
 *  当没找到匹配时，把 `pendingServers`（若提供）呈现出来——告诉模型有些 MCP server
 *  还在连接中，应稍后重试。 */
export function runToolSearch(
  query: string,
  maxResults: number,
  catalog: readonly DeferredToolEntry[],
  pendingServers?: readonly string[],
): ToolSearchResult {
  const byName = new Map(catalog.map((e) => [e.name, e]))

  // ── select:<name>,<name> — 按名称精确加载 ──
  const selectMatch = query.match(/^select:(.+)$/i)
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const matched: string[] = []
    const missing: string[] = []
    for (const r of requested) {
      const e = byName.get(r) ?? catalog.find((c) => c.name.toLowerCase() === r.toLowerCase())
      if (e) {
        if (!matched.includes(e.name)) matched.push(e.name)
      } else {
        missing.push(r)
      }
    }
    if (matched.length === 0) {
      return {
        text: noMatchText(
          `No deferred tools matched select: ${missing.join(', ')}. Check the exact names under "## Deferred Tools" in the system prompt.`,
          pendingServers,
        ),
        activated: [],
      }
    }
    return { text: formatLoaded(matched, byName, missing), activated: matched }
  }

  // ── 裸工具名（若干）——隐式 select ──
  // 模型经常直接把精确工具名当作查询（"webSearch,webFetch" 或 "webSearch webFetch"），
  // 而不是用 select:。模糊关键词打分会把它们丢掉——像 "websearch" 这样的连写名称匹配不到
  // 拆开后的 "web"/"search" 两部分——于是搜索返回空，模型还得再花一轮用 select: 重调。
  // 如果每个 token 都能解析到某个已知延迟工具，就把整个查询当作隐式 select。
  const bareTokens = query
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (bareTokens.length > 0) {
    const bareMatched: string[] = []
    let allResolved = true
    for (const t of bareTokens) {
      const e = byName.get(t) ?? catalog.find((c) => c.name.toLowerCase() === t.toLowerCase())
      if (!e) {
        allResolved = false
        break
      }
      if (!bareMatched.includes(e.name)) bareMatched.push(e.name)
    }
    if (allResolved) return { text: formatLoaded(bareMatched, byName, []), activated: bareMatched }
  }

  // ── 关键词搜索 ──
  const matched = searchDeferredTools(query, catalog, maxResults)
  if (matched.length === 0) {
    return {
      text: noMatchText(
        `No matching deferred tools for "${query}". Browse the "## Deferred Tools" list in the system prompt and retry with different keywords, or use select:<exact_name>.`,
        pendingServers,
      ),
      activated: [],
    }
  }
  return { text: formatLoaded(matched, byName, []), activated: matched }
}

function formatLoaded(matched: string[], byName: Map<string, DeferredToolEntry>, missing: string[]): string {
  const lines = matched.map((n) => {
    const e = byName.get(n)
    return e?.description ? `- ${n}: ${e.description}` : `- ${n}`
  })
  let text = `Loaded ${matched.length} tool(s) — now callable directly on your next step:\n${lines.join('\n')}`
  if (missing.length > 0) text += `\n(not found: ${missing.join(', ')})`
  return text
}

function noMatchText(base: string, pendingServers?: readonly string[]): string {
  if (pendingServers && pendingServers.length > 0) {
    return `${base}\n\nNote: some MCP servers are still connecting (${pendingServers.join(', ')}). Their tools will become available shortly — try searching again.`
  }
  return base
}
