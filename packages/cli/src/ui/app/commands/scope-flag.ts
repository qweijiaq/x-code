// 必须导出：`ScopeFlagParseResult` 是导出的接口，而 composite/declaration 构建下
// 引用私有名字会直接报 TS4033/TS4081。
export type SettingsScope = 'user' | 'project'

export interface ScopeFlagParseResult {
  value: string
  scope: SettingsScope | undefined
  /** 非空表示解析失败（非法 scope 值或缺值）。调用方应把这段文案直接展示给
   *  用户，而不是带着一个静默回落的默认 scope 继续写配置。 */
  error?: string
}

/** 从一段自由文本参数里剥出 `--scope=user|project` / `-s=user|project` 标志。
 *
 *  只承认带 `=` 的形式：裸 `--scope project` 曾让 `project` 作为普通参数残留进
 *  `value`（`/skill disable foo --scope project` 会解析成
 *  `{ value: 'foo project', scope: undefined }`——技能名被污染、作用域又静默
 *  回落到默认值）。现在裸标志直接报缺值错误。
 *
 *  非法的 scope 值也不再被静默忽略：返回 `error` 供调用方中止。 */
export function parseScopeFlag(
  arg: string,
  defaultScope: SettingsScope,
): ScopeFlagParseResult & { scope: SettingsScope }
export function parseScopeFlag(arg: string): ScopeFlagParseResult
export function parseScopeFlag(arg: string, defaultScope?: SettingsScope): ScopeFlagParseResult {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: SettingsScope | undefined = defaultScope
  let error: string | undefined
  const remaining: string[] = []
  for (const token of tokens) {
    if (token === '--scope' || token === '-s') {
      error ??= `${token} requires a value (use ${token}=user|project).`
      continue
    }
    const match = token.match(/^(?:--scope|-s)=(.*)$/)
    if (match) {
      const value = match[1]!.trim().toLowerCase()
      if (value !== 'user' && value !== 'project') {
        error ??= `Invalid scope value '${match[1]}' (expected user|project).`
        continue
      }
      scope = value
      continue
    }
    remaining.push(token)
  }
  return error === undefined ? { value: remaining.join(' '), scope } : { value: remaining.join(' '), scope, error }
}
