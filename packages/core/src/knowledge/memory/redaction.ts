/** 会被当作凭据键名的单词（`DB_PASSWORD`、`x-api-key`、`"accessToken"`…）。 */
const KEYED_CREDENTIAL_NAME =
  'api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd|secret|token'

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxai-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bhf_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bnpm_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[a-z]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [REDACTED_TOKEN]'],
  // 键值形式的凭据。要点（原规则在这三种常见形态上全都不成立）：
  //  1. key 名后允许闭合引号，否则 JSON `{"api_key": "…"}` 直接漏掉——而本模块
  //     的输入几乎都是投影 JSON / tool 输入输出的字符串化形式；
  //  2. key 名允许 `['"\w.-]` 前缀（`DB_PASSWORD=`、`MY_API_KEY=`、
  //     `client_secret:`），`_` 是单词字符，原来的 `\b` 在这些前缀下不成立；
  //  3. 取值优先整体匹配引号内的内容（`password: "correct horse …"`），
  //     未加引号时再退化为读到分隔符，避免只替换掉半个值、留下不配对的引号。
  //
  // 原规则在三种最常见的形态上整条链都失配（引号规则因字符类排除另一种引号而
  // 失败，未加引号规则又被 `(?!["'])` 挡住），导致密文原样泄漏：
  //  a. 值内部含另一种引号：`"password": "it's a secret"`；
  //  b. 值跨行（YAML / 多行字符串 / 含 `\n` 的字符串化内容）；
  //  c. 二次字符串化的 JSON：`{\"password\": \"secret\"}`（key 与 `:` 之间是 `\"`）。
  // 现在：opener 允许前置转义反斜杠（并把整段作为反向引用，闭合必须同形），
  // 值用惰性 `(?:\\.|[\s\S])`——转义对先整体吃掉，值内部的 `\"` 不会被误当闭合，
  // 换行也允许；长度上限 4096 防止未闭合引号时吞掉整篇文档。
  [
    new RegExp(
      `((?:\\\\?["'])?[\\w.-]*(?:${KEYED_CREDENTIAL_NAME})(?:\\\\?["'])?\\s*[:=]\\s*)(\\\\?["'])((?:\\\\.|[\\s\\S]){0,4096}?)\\2`,
      'gi',
    ),
    '$1$2[REDACTED]$2',
  ],
  [
    new RegExp(`(['"]?[\\w.-]*(?:${KEYED_CREDENTIAL_NAME})['"]?\\s*[:=]\\s*)(?!["'])[^\\s,;&\\n]+`, 'gi'),
    '$1[REDACTED]',
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, '[REDACTED_BASE64]'],
]

export function redactMemoryText(value: string): string {
  let redacted = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

export function redactMemoryValue<T>(value: T): T {
  if (typeof value === 'string') return redactMemoryText(value) as T
  if (Array.isArray(value)) return value.map((item) => redactMemoryValue(item)) as T
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = redactMemoryValue(item)
    return result as T
  }
  return value
}
