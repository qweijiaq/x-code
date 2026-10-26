// @x-code-cli/core — 对延迟工具目录做关键词搜索
//
// 确定性的关键词打分，无 embedding——忠实移植自 Claude Code 的 searchToolsWithKeywords。
// 模型通常用 server 名（"github"）、动作词（"create"、"list"）或能力短语（"search the web"）
// 来查询；我们对工具名分词，并用词项重叠度对名称各部分和预计算的 searchText 草堆（它已经
// 折进了描述和 MCP schema 属性名）打分。
//
// `select:<name>` 精确加载路径在 tool.ts 里——本文件只做模糊关键词路径。这里的精度并非
// 关键路径：模型在系统提示词里能看到精确的延迟工具名，随时可以 `select:` 它们；关键词
// 打分只是它不确定名称时的回退。
import type { DeferredToolEntry } from './catalog.js'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ParsedName {
  parts: string[]
  full: string
  isMcp: boolean
}

/** 把工具名拆成可搜索的部分：`mcp__server__tool` 按 `__`/`_` 拆，
 *  普通名称按 CamelCase + `_` 拆。小写。 */
function parseToolName(name: string): ParsedName {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.slice(5).toLowerCase()
    const parts = withoutPrefix
      .split('__')
      .flatMap((p) => p.split('_'))
      .filter(Boolean)
    return { parts, full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '), isMcp: true }
  }
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return { parts, full: parts.join(' '), isMcp: false }
}

/** 对延迟目录做关键词搜索。返回匹配到的 callable 名称，最佳优先，最多 `maxResults` 个。 */
export function searchDeferredTools(
  query: string,
  catalog: readonly DeferredToolEntry[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim()
  if (!queryLower) return []

  // 快路径：查询本身就是精确工具名（模型用了裸名称而非 select:）——直接返回。
  const exact = catalog.find((e) => e.name.toLowerCase() === queryLower)
  if (exact) return [exact.name]

  // mcp__server 前缀——模型带着 mcp__ 前缀按 server 搜索。
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefix = catalog
      .filter((e) => e.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((e) => e.name)
    if (prefix.length > 0) return prefix
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0)

  // `+term` 标记必选词项——候选必须匹配全部这些词项。
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const t of queryTerms) {
    if (t.startsWith('+') && t.length > 1) requiredTerms.push(t.slice(1))
    else optionalTerms.push(t)
  }
  const scoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms

  // 预先编译一次词边界模式（工具 × 词项会复用它们）。
  const patterns = new Map<string, RegExp>()
  for (const t of scoringTerms) {
    if (!patterns.has(t)) patterns.set(t, new RegExp(`\\b${escapeRegExp(t)}\\b`))
  }

  let candidates = catalog
  if (requiredTerms.length > 0) {
    candidates = catalog.filter((e) => {
      const parsed = parseToolName(e.name)
      return requiredTerms.every((term) => {
        const p = patterns.get(term)!
        return parsed.parts.includes(term) || parsed.parts.some((part) => part.includes(term)) || p.test(e.searchText)
      })
    })
  }

  const scored = candidates.map((e) => {
    const parsed = parseToolName(e.name)
    let score = 0
    for (const term of scoringTerms) {
      const p = patterns.get(term)!
      // 名称部分的精确匹配权重最高（MCP 名称是最强信号——模型通常知道自己要的
      // server/动作）。
      if (parsed.parts.includes(term)) score += parsed.isMcp ? 12 : 10
      else if (parsed.parts.some((part) => part.includes(term))) score += parsed.isMcp ? 6 : 5
      // 全名回退，兜住部分拆分漏掉的边界情况。
      if (parsed.full.includes(term) && score === 0) score += 3
      // 描述 / schema 属性匹配——词边界避免误命中。
      if (p.test(e.searchText)) score += 2
    }
    return { name: e.name, score }
  })

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x) => x.name)
}
