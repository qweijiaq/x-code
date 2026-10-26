// @x-code-cli/core — MCP 配置的环境变量展开
//
// 支持 MCP 服务器配置中任意字符串字段里的两种形式：
//   ${VAR}             — 展开，若 VAR 未设置则抛出
//   ${VAR:-fallback}   — 展开，或使用字面 fallback
//
// 我们刻意不支持任意的 shell 展开（不支持不带花括号的 `$VAR`、不支持
// 命令替换、不支持嵌套的 `${${A}}`）。更花哨的应该在 X-Code 启动之前
// 在用户侧完成。

/** 当 ${VAR} 引用无法解析时抛出。loader 捕获它并把该服务器标记为 `failed`，
 *  使 CLI 的其余部分继续运行。 */
export class EnvExpansionError extends Error {
  constructor(public varName: string) {
    super(`Required environment variable not set: ${varName}`)
    this.name = 'EnvExpansionError'
  }
}

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** 展开单个字符串中所有的 ${VAR} 引用。 */
export function expandEnvString(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(REF_RE, (_match, name: string, fallback?: string) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    throw new EnvExpansionError(name)
  })
}

/** 递归遍历配置值并展开字符串。数组 / 普通对象会被遍历；
 *  number/boolean/null 原样通过。返回深拷贝——绝不修改输入
 *  （重要：输入可能直接来自缓存的已解析配置对象）。 */
export function expandEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return expandEnvString(value, env) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvDeep(v, env)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvDeep(v, env)
    }
    return out as unknown as T
  }
  return value
}
