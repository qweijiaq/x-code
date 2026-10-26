// @x-code-cli/core — MCP 工具名改写
//
// 我们用带命名空间的名称把 MCP 工具暴露给模型，使它们不会与内置工具
// （readFile、shell 等）冲突，也让模型一眼就能看出"这来自服务器 X"：
//
//     <server>__<tool>
//
// 服务器名和工具名都会被消毒：[A-Za-z0-9_] 之外的任何字符都变成 `_`。
// 我们选 `__`（双下划线）作分隔符，使原始名字含单个下划线的工具
// （很常见——`read_file`、`list_issues`）不会产生歧义。
//
// 不加 `mcp__` 伞形前缀——Claude Code 会加一个（`mcp__<server>__<tool>`），
// 但那会在每个工具上烧 token，且没有告诉模型任何 description 里没有的信息。
// Codex 和 Gemini CLI 都省略该前缀；我们跟随它们。"这个工具是 MCP 还是
// 内置的？" 的判定是 tool-execution.ts 里的一次 registry 查找，不是名字前缀
// 检查。
//
// 面向模型的工具名有 64 字符硬上限（OpenAI 的历史限制；Anthropic/Google
// 更高，但 64 让我们保持可移植）。超长的名字会被截断并打上 6 字符内容
// 哈希，使两个长而相似的名字仍然不同。
//
// 跨服务器名字冲突在实践中很罕见但可能发生（两个服务器都暴露
// `read_file`）。我们通过在第二个添加的条目上给服务器名哈希出 4 字符
// 后缀来解决。
import { createHash } from 'node:crypto'

export const MCP_MAX_NAME_LEN = 64

function sanitize(part: string): string {
  // 把任意连续的不允许字符替换为单个 `_`。修剪首尾下划线，
  // 避免得到 `_server__tool_`。
  const cleaned = part.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  // 消毒后为空（例如全 CJK 的服务器名）→ 回退到哈希，
  // 以便仍能生成稳定、合法的标识符。
  if (cleaned === '') {
    return shortHash(part, 6)
  }
  return cleaned
}

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

/** 为一个 MCP 工具构建面向模型的工具名。
 *
 *  `existing` 是当前 registry 中已被占用的名字集合——若新名字冲突，
 *  我们追加服务器名的 4 字符哈希来消歧。（刻意哈希服务器而非工具：工具名
 *  承载模型依赖的语义；服务器名是用户挑选的部分，所以消歧符以它作键更有意义。） */
export function buildCallableName(serverName: string, rawToolName: string, existing: ReadonlySet<string>): string {
  const s = sanitize(serverName)
  const t = sanitize(rawToolName)

  let name = `${s}__${t}`

  // 超长：截断的同时保留内容哈希，
  // 使截断后不同的名字不会坍缩成同一个字符串。
  if (name.length > MCP_MAX_NAME_LEN) {
    const hash = shortHash(`${serverName}::${rawToolName}`, 6)
    const room = MCP_MAX_NAME_LEN - 1 /* underscore */ - hash.length
    name = `${(s + '__' + t).slice(0, room)}_${hash}`
  }

  // 冲突：追加 4 字符服务器名哈希。如果这样仍冲突（在众多服务器间理论上
  // 可能），就逐步加长哈希直到唯一——受 MCP_MAX_NAME_LEN 限制。
  if (existing.has(name)) {
    for (let extra = 4; extra <= 12; extra++) {
      const suffix = '_' + shortHash(serverName, extra)
      const candidate =
        name.length + suffix.length <= MCP_MAX_NAME_LEN
          ? name + suffix
          : name.slice(0, MCP_MAX_NAME_LEN - suffix.length) + suffix
      if (!existing.has(candidate)) {
        return candidate
      }
    }
    // 病态情形：直接追加一个近似随机的后缀，姑且一试。
    return name.slice(0, MCP_MAX_NAME_LEN - 9) + '_' + shortHash(name + Date.now(), 8)
  }

  return name
}
