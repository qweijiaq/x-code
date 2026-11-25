import { parseScopeFlag } from '../src/ui/app/commands/scope-flag.js'

describe('parseScopeFlag', () => {
  it('extracts long and short scope flags while preserving the remaining argument', () => {
    expect(parseScopeFlag('alpha --scope=project')).toEqual({ value: 'alpha', scope: 'project' })
    expect(parseScopeFlag('-s=user alpha beta')).toEqual({ value: 'alpha beta', scope: 'user' })
  })

  it('reports an error (instead of silently keeping the default) when a scope flag has an unknown value', () => {
    // 静默回落成默认 scope 会把用户的启停写进错误的 settings.json，属于静默的
    // 错写配置——未知取值必须能被调用方识别并中止。
    const parsed = parseScopeFlag('alpha --scope=invalid', 'user')
    expect(parsed.value).toBe('alpha')
    expect(parsed.error).toContain("Invalid scope value 'invalid'")
  })

  it('reports a missing-value error for a bare --scope flag', () => {
    // 过去裸 `--scope` 会让后一个 token 作为普通参数残留进 value（技能/插件名被
    // 污染成 `alpha project`），scope 又回落到默认值，且没有任何提示。
    const parsed = parseScopeFlag('alpha --scope project', 'user')
    expect(parsed.value).toBe('alpha project')
    expect(parsed.error).toContain('requires a value')
  })

  it('leaves scope undefined when no default or valid flag is present', () => {
    expect(parseScopeFlag('alpha')).toEqual({ value: 'alpha', scope: undefined })
  })
})
