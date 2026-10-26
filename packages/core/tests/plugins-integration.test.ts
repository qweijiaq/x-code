// 插件 → 既有加载器集成的测试
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installPlugin } from '../src/plugins/installer.js'
import { buildPluginIntegration } from '../src/plugins/integration.js'
import { loadAllPlugins } from '../src/plugins/loader.js'

let originalPluginsDir: string | undefined

async function writeFileAt(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf-8')
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-int-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('buildPluginIntegration', () => {
  it('lists skill + agent dirs for each enabled plugin (resolved absolute)', async () => {
    // 构造一个带 skills/ 和 agents/ 目录的源插件树
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills', agents: './agents' }),
    )
    await fs.mkdir(path.join(src, 'skills'), { recursive: true })
    await fs.mkdir(path.join(src, 'agents'), { recursive: true })

    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const load = await loadAllPlugins({ cwd })
    const out = await buildPluginIntegration(load)

    expect(out.skillsDirs).toHaveLength(1)
    expect(out.skillsDirs[0]!.pluginId).toBe('demo@local')
    expect(path.isAbsolute(out.skillsDirs[0]!.dir)).toBe(true)
    expect(out.agentsDirs[0]!.dir).toContain('agents')
  })

  it('surfaces commandsDirs for any plugin with a commands/ contribution', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', commands: './cmds' }),
    )
    await fs.mkdir(path.join(src, 'cmds'), { recursive: true })

    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.commandsDirs).toHaveLength(1)
    expect(out.commandsDirs[0]!.pluginId).toBe('demo@local')
    expect(out.commandsDirs[0]!.pluginRoot).toBeDefined()
  })

  it('builds a HookRegistry from inline hooks contributions', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'lint.sh' }] },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.pluginHooks).toHaveLength(1)
    expect(out.pluginHooks[0]!.events).toEqual(['PreToolUse'])
    expect(out.hookRegistry.has('PreToolUse')).toBe(true)
    expect(out.hookRegistry.get('PreToolUse')).toHaveLength(1)
    expect(out.hookRegistry.get('PreToolUse')[0]!.pluginId).toBe('demo@local')
    expect(out.hookErrors).toEqual([])
  })

  it('records hook config parse errors per plugin without crashing the rest', async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-bad-'))
    await writeFileAt(
      path.join(bad, 'plugin.json'),
      JSON.stringify({
        name: 'badhook',
        version: '1.0.0',
        // 缺少 command —— schema 会拒绝
        hooks: { PreToolUse: [{ matcher: 'edit_file' }] },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: bad }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.hookErrors).toHaveLength(1)
    expect(out.hookErrors[0]!.pluginId).toBe('badhook@local')
    expect(out.hookRegistry.list()).toHaveLength(0)
  })

  it('parses path-style mcpServers from a JSON file at the plugin root', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', mcpServers: './mcp.json' }),
    )
    await writeFileAt(path.join(src, 'mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }))
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpServers.gh).toBeDefined()
    expect((out.mcpServers.gh as { command?: string }).command).toBe('gh-mcp')
  })

  it("accepts a flat `.mcp.json` (no `mcpServers` wrapper) — Claude Code's official plugin shape", async () => {
    // linear@anthropic-marketplace 发布的 .mcp.json 是扁平的 `name → cfg`
    // 映射，没有 `mcpServers` 包裹层。我们过去会静默丢弃它。
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-flat-mcp-'))
    await writeFileAt(path.join(src, 'plugin.json'), JSON.stringify({ name: 'linearish', version: '1.0.0' }))
    await writeFileAt(
      path.join(src, '.mcp.json'),
      JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpErrors).toEqual([])
    expect(out.mcpServers.linear).toBeDefined()
    expect((out.mcpServers.linear as { url?: string }).url).toBe('https://mcp.linear.app/mcp')
  })

  it('resolves mcpServers name collisions first-wins + records the loser', async () => {
    // 两个插件都贡献了名为 "gh" 的服务器
    const srcA = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-srcA-'))
    await writeFileAt(
      path.join(srcA, 'plugin.json'),
      JSON.stringify({
        name: 'aaa-first',
        version: '1.0.0',
        mcpServers: { gh: { command: 'first-cmd' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: srcA }, marketplace: 'local' })

    const srcB = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-srcB-'))
    await writeFileAt(
      path.join(srcB, 'plugin.json'),
      JSON.stringify({
        name: 'bbb-second',
        version: '1.0.0',
        mcpServers: { gh: { command: 'second-cmd' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: srcB }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    // 先安装者胜出（installed_plugins.json 的顺序）
    expect((out.mcpServers.gh as { command?: string }).command).toBe('first-cmd')
    expect(out.mcpCollisions).toHaveLength(1)
    expect(out.mcpCollisions[0]).toEqual({
      name: 'gh',
      droppedFrom: 'bbb-second@local',
      keptFrom: 'aaa-first@local',
    })
  })

  it('records mcp parse errors per plugin without killing the others', async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-bad-'))
    await writeFileAt(
      path.join(bad, 'plugin.json'),
      JSON.stringify({
        name: 'badmcp',
        version: '1.0.0',
        // 既没有 command 也没有 url —— mcp 配置 schema 必须拒绝此条目
        mcpServers: { broken: { args: ['x'] } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: bad }, marketplace: 'local' })

    const good = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-good-'))
    await writeFileAt(
      path.join(good, 'plugin.json'),
      JSON.stringify({
        name: 'goodmcp',
        version: '1.0.0',
        mcpServers: { ok: { command: 'echo' } },
      }),
    )
    await installPlugin({ source: { kind: 'local', path: good }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))

    expect(out.mcpErrors).toHaveLength(1)
    expect(out.mcpErrors[0]!.pluginId).toBe('badmcp@local')
    // 正常插件的服务器仍然落地
    expect(out.mcpServers.ok).toBeDefined()
  })

  it('skips contributions from disabled plugins', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-plugin-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', mcpServers: { gh: { command: 'gh-mcp' } } }),
    )
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-int-cwd-'))
    // 通过项目设置禁用该插件
    await writeFileAt(
      path.join(cwd, '.x-code', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'demo@local': false } }),
    )

    const out = await buildPluginIntegration(await loadAllPlugins({ cwd }))
    expect(out.mcpServers).toEqual({})
  })
})
