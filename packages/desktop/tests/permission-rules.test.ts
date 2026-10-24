import path from 'node:path'

import {
  normalizeNewPermissionRule,
  permissionRuleLabel,
  visiblePermissionRules,
} from '../src/runtime/permission-rules.js'

const workspace = path.resolve('/tmp/xcode-permission-workspace')

describe('permission rule views', () => {
  it('formats each rule shape like the CLI labels', () => {
    expect(permissionRuleLabel({ tool: 'shell', pattern: 'git commit', type: 'prefix' })).toBe('shell:git commit:*')
    expect(permissionRuleLabel({ tool: 'shell', pattern: 'git push origin main', type: 'exact' })).toBe(
      'shell:=git push origin main',
    )
    expect(permissionRuleLabel({ tool: 'writeFile', pattern: '*', type: 'tool' })).toBe('writeFile:*')
  })

  it('keeps shell rules bound to this workspace and sorts the result', () => {
    const rules = visiblePermissionRules(
      [
        { tool: 'shell', pattern: 'npm test', type: 'prefix', cwd: workspace },
        { tool: 'shell', pattern: 'make', type: 'prefix', cwd: '/tmp/other-project' },
        { tool: 'shell', pattern: 'git status', type: 'exact', cwd: workspace },
        { tool: 'writeFile', pattern: '*', type: 'tool' },
      ],
      workspace,
    )
    expect(rules.map((rule) => rule.label)).toEqual(['shell:=git status', 'shell:npm test:*', 'writeFile:*'])
  })
})

describe('normalizeNewPermissionRule', () => {
  it('binds shell rules to the workspace', () => {
    expect(normalizeNewPermissionRule(' shell ', 'prefix', '  npm test ', workspace)).toEqual({
      tool: 'shell',
      pattern: 'npm test',
      type: 'prefix',
      cwd: workspace,
    })
    expect(normalizeNewPermissionRule('shell', 'tool', '', workspace)).toEqual({
      tool: 'shell',
      pattern: '*',
      type: 'tool',
      cwd: workspace,
    })
  })

  it('allows tool-wide rules for other tools', () => {
    expect(normalizeNewPermissionRule('writeFile', 'tool', '*', workspace)).toEqual({
      tool: 'writeFile',
      pattern: '*',
      type: 'tool',
    })
  })

  it('rejects invalid input', () => {
    expect(() => normalizeNewPermissionRule(' ', 'prefix', 'npm', workspace)).toThrow('工具名不能为空')
    expect(() => normalizeNewPermissionRule('shell', 'regex' as never, 'npm', workspace)).toThrow('未知的规则类型')
    expect(() => normalizeNewPermissionRule('shell', 'prefix', '  ', workspace)).toThrow('匹配模式不能为空')
    expect(() => normalizeNewPermissionRule('shell', 'prefix', '*', workspace)).toThrow('匹配模式不能为空')
    expect(() => normalizeNewPermissionRule('writeFile', 'exact', 'src/a.ts', workspace)).toThrow(
      '只有 shell 工具支持前缀或精确匹配',
    )
  })
})
