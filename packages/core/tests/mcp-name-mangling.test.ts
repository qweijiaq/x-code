import { describe, expect, it } from 'vitest'

import { MCP_MAX_NAME_LEN, buildCallableName } from '../src/mcp/name-mangling.js'

describe('buildCallableName', () => {
  it('produces <server>__<tool> for clean inputs', () => {
    const name = buildCallableName('filesystem', 'read_file', new Set())
    expect(name).toBe('filesystem__read_file')
  })

  it('sanitises disallowed chars to underscore', () => {
    const name = buildCallableName('my-server.v2', 'foo:bar', new Set())
    // 连字符、点、冒号 → “_”；连续多个会折叠成单个下划线
    expect(name).toBe('my_server_v2__foo_bar')
  })

  it('falls back to hash when sanitisation empties a part', () => {
    // 全 CJK 服务器名没有任何 [A-Za-z0-9_] 字符 —— 仍必须生成
    // 合法、唯一的标识符，而不是 `__tool`。
    const name = buildCallableName('文件系统', 'read', new Set())
    expect(name).toMatch(/^[a-f0-9]{6}__read$/)
  })

  it('stays under the 64-char cap with truncation hash', () => {
    const longServer = 'x'.repeat(40)
    const longTool = 'y'.repeat(40)
    const name = buildCallableName(longServer, longTool, new Set())
    expect(name.length).toBeLessThanOrEqual(MCP_MAX_NAME_LEN)
    // 截断形式以 `_<6 位哈希>` 结尾，这样两个长而相似的
    // 名字不会折叠成同一个字符串。
    expect(name).toMatch(/_[a-f0-9]{6}$/)
  })

  it('disambiguates collisions across servers', () => {
    const taken = new Set<string>()
    const a = buildCallableName('serverA', 'read', taken)
    taken.add(a)
    // 在“不同”服务器上同名，但净化后得到相同 id
    const b = buildCallableName('serverA', 'read', taken)
    expect(a).not.toBe(b)
    expect(b.startsWith(a)).toBe(true) // 追加了冲突后缀
  })

  it('always produces a unique name even on repeated collisions', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const name = buildCallableName('s', 't', taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
    expect(taken.size).toBe(5)
  })
})
