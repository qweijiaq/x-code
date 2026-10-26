// 安装器（本地源路径）+ 加载器集成的测试
import { execa } from 'execa'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  InstallError,
  findInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from '../src/plugins/installer.js'
import { loadAllPlugins, resolveContributions } from '../src/plugins/loader.js'
import { pluginCacheDir } from '../src/plugins/paths.js'

let originalPluginsDir: string | undefined

async function makeTempPlugin(body: Record<string, unknown>, rel = 'plugin.json'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-src-'))
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf-8')
  return root
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-cache-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

// ── 安装器 ──────────────────────────────────────────────────────────

describe('installPlugin (local source)', () => {
  it('copies a local plugin into the cache + records it', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'd' })

    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
    })

    expect(result.pluginId).toBe('demo@local')
    expect(result.manifest.name).toBe('demo')
    expect(result.rootDir).toBe(pluginCacheDir('local', 'demo', '1.0.0'))

    // 缓存的 manifest 应存在
    expect(
      await fs
        .access(path.join(result.rootDir, 'plugin.json'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)

    // 记录已落地
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(1)
    expect(installed[0]!.id).toBe('demo@local')
    expect(installed[0]!.version).toBe('1.0.0')
  })

  it('rejects a Gemini-only source with a friendly error', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' }, 'gemini-extension.json')

    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /Gemini extension/,
    )
  })

  it('rejects a source with no manifest', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-empty-'))
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toBeInstanceOf(
      InstallError,
    )
  })

  it('enforces expectedName when set', async () => {
    const src = await makeTempPlugin({ name: 'actually-this', version: '1.0.0' })
    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        expectedName: 'something-else',
      }),
    ).rejects.toThrow(/does not match/)
  })

  it('re-installs over an existing same-version install (wipes first)', async () => {
    const src1 = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    // 在缓存目录里放一个标记文件
    const dir = pluginCacheDir('local', 'demo', '1.0.0')
    await fs.writeFile(path.join(dir, 'stale.txt'), 'should not survive')

    const src2 = await makeTempPlugin({ name: 'demo', version: '1.0.0', description: 'updated' })
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })

    // 清理替换后，过期文件应已消失
    const staleExists = await fs
      .access(path.join(dir, 'stale.txt'))
      .then(() => true)
      .catch(() => false)
    expect(staleExists).toBe(false)
  })

  it('also copies non-manifest files (skills/, agents/, etc.) into the cache', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-rich-'))
    await fs.writeFile(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills' }),
    )
    await fs.mkdir(path.join(src, 'skills', 'foo'), { recursive: true })
    await fs.writeFile(path.join(src, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\n')

    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    const skillFile = path.join(result.rootDir, 'skills', 'foo', 'SKILL.md')
    expect(
      await fs
        .access(skillFile)
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
  })

  // 无特权 Windows CI 任务无法可靠创建真实符号链接；
  // 生产代码仍会处理 Windows junction/符号链接。
  it.skipIf(process.platform === 'win32')('drops symlinks that escape the plugin source tree', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-outside-')), 'secret.txt')
    await fs.writeFile(outside, 'host secret')
    await fs.symlink(outside, path.join(src, 'escape.txt'))

    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    await expect(fs.access(path.join(result.rootDir, 'escape.txt'))).rejects.toThrow()
  })
})

describe('install policy gates (strictKnownMarketplaces + blockedPlugins)', () => {
  // known_marketplaces.json 的这两个字段是为了给管理员对安装内容
  // 施加可执行的控制。两者过去都被解析但从未被检查 ——
  // 这些测试钉住新的强制行为。

  it('strictKnownMarketplaces rejects installs from a non-subscribed marketplace', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], strictKnownMarketplaces: true }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /strict marketplace mode/,
    )
  })

  it('strictKnownMarketplaces accepts installs whose marketplace IS subscribed', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        marketplaces: [{ name: 'official', source: 'github:foo/official' }],
        strictKnownMarketplaces: true,
      }),
    )

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'official' })
    expect(result.pluginId).toBe('demo@official')
  })

  it('blockedPlugins rejects matching id regardless of marketplace / consent', async () => {
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo@local'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })).rejects.toThrow(
      /blockedPlugins/,
    )
  })

  it('blockedPlugins also matches bare plugin name (block-everywhere shortcut)', async () => {
    // 管理员合理地期望 `blockedPlugins: ['demo']` 能一次性拦截
    // 每个 marketplace 的 "demo" 插件，类似 npm-ignore。
    // 全限定形式仍被接受以提供精确性。
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await expect(
      installPlugin({ source: { kind: 'local', path: src }, marketplace: 'some-other-marketplace' }),
    ).rejects.toThrow(/blockedPlugins/)
  })

  it('blockedPlugins does not match a different plugin sharing a prefix', async () => {
    // 确保裸名称匹配是严格相等而非子串 ——
    // 拦截 "demo" 不应拦截 "demo-extra"。
    const file = path.join(process.env.XC_PLUGINS_DIR!, 'known_marketplaces.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ marketplaces: [], blockedPlugins: ['demo'] }))

    const src = await makeTempPlugin({ name: 'demo-extra', version: '1.0.0' })
    const result = await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    expect(result.pluginId).toBe('demo-extra@local')
  })
})

describe('uninstallPlugin', () => {
  it('removes cache + record + returns the version it cleaned up', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const result = await uninstallPlugin('demo@local')
    expect(result.removedRecord).toBe(true)
    expect(result.removedVersions).toEqual(['1.0.0'])

    expect(await findInstalledPlugin('demo@local')).toBeUndefined()
  })

  it('is a no-op for an unknown plugin', async () => {
    const result = await uninstallPlugin('ghost@local')
    expect(result).toEqual({ removedRecord: false, removedVersions: [] })
  })
})

// ── 加载器 ─────────────────────────────────────────────────────────────

describe('loadAllPlugins', () => {
  it('returns empty registry when disabled', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd, disabled: true })
    expect(result.registry.list()).toEqual([])
    expect(result.contributions.size).toBe(0)
  })

  it('loads user-scope installed plugins from installed_plugins.json', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0', skills: './skills' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const result = await loadAllPlugins({ cwd })

    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('demo@local')
    expect(list[0]!.enabled).toBe(true) // 默认启用

    const contrib = result.contributions.get('demo@local')
    expect(contrib?.skillsDir).toBe(path.resolve(list[0]!.rootDir, './skills'))
  })

  it('loads project-local plugins from <cwd>/.x-code/plugins/<name>/', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'inhouse')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'inhouse', version: '0.1.0' }))

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('inhouse@local')
    expect(list[0]!.scope).toBe('project')
  })

  it('records load errors for broken manifests without aborting', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const broken = path.join(cwd, '.x-code', 'plugins', 'broken')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'plugin.json'), '{ not json', 'utf-8')

    const good = path.join(cwd, '.x-code', 'plugins', 'good')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'plugin.json'), JSON.stringify({ name: 'good', version: '1.0.0' }))

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(1)
    expect(result.registry.listAll()[0]!.id).toBe('good@local')
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.path).toBe(broken)
  })

  it('records a Gemini-extension load error without crashing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const gemini = path.join(cwd, '.x-code', 'plugins', 'gemini-plugin')
    await fs.mkdir(gemini, { recursive: true })
    await fs.writeFile(
      path.join(gemini, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini-plugin', version: '1.0.0' }),
    )

    const result = await loadAllPlugins({ cwd })
    expect(result.registry.listAll()).toHaveLength(0)
    expect(result.registry.loadErrors()).toHaveLength(1)
    expect(result.registry.loadErrors()[0]!.message).toMatch(/Gemini/)
  })

  it('respects enable flags from <cwd>/.x-code/settings.local.json', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-loader-cwd-'))
    const pluginDir = path.join(cwd, '.x-code', 'plugins', 'disabled-one')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'disabled-one', version: '1.0.0' }))

    await fs.writeFile(
      path.join(cwd, '.x-code', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'disabled-one@local': false } }),
    )

    const result = await loadAllPlugins({ cwd })
    const list = result.registry.listAll()
    expect(list).toHaveLength(1)
    expect(list[0]!.enabled).toBe(false)
    expect(result.registry.list()).toHaveLength(0) // 被 .list() 过滤器隐藏
  })
})

describe('resolveContributions', () => {
  it('resolves manifest-declared paths against rootDir', async () => {
    const plugin = {
      id: 'demo@local',
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        skills: './skills',
        agents: './agents',
        mcpServers: './mcp.json',
      },
      rootDir: '/abs/root',
      manifestPath: '/abs/root/plugin.json',
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.skillsDir).toBe(path.resolve('/abs/root', './skills'))
    expect(c.agentsDir).toBe(path.resolve('/abs/root', './agents'))
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.resolve('/abs/root', './mcp.json') })
  })

  it('auto-discovers commands/ agents/ skills/ when manifest omits them (Claude Code convention)', async () => {
    // 构建一个真实的磁盘插件，让基于约定的 fs.stat 探测有东西可找。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-resolve-conv-'))
    await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await fs.mkdir(path.join(root, 'commands'), { recursive: true })
    await fs.mkdir(path.join(root, 'agents'), { recursive: true })
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }))

    const plugin = {
      id: 'demo@local',
      manifest: { schemaVersion: '1', name: 'demo', version: '1.0.0' },
      rootDir: root,
      manifestPath: path.join(root, 'plugin.json'),
      manifestFormat: 'bare' as const,
      source: undefined,
      marketplace: 'local',
      scope: 'project' as const,
      enabled: true,
    }
    const c = await resolveContributions(plugin)
    expect(c.commandsDir).toBe(path.join(root, 'commands'))
    expect(c.agentsDir).toBe(path.join(root, 'agents'))
    expect(c.skillsDir).toBeUndefined() // 无 skills/ 目录 → undefined
    expect(c.mcpServers).toEqual({ kind: 'path', path: path.join(root, '.mcp.json') })
  })
})

// ── userConfig 安装时提示 ─────────────────────────────────────

describe('installPlugin (userConfig prompt)', () => {
  it('passes manifest userConfig fields to the callback and persists the returned values', async () => {
    const { getPluginUserConfig } = await import('../src/plugins/user-config.js')
    const src = await makeTempPlugin({
      name: 'cfg-demo',
      version: '1.0.0',
      userConfig: [
        { key: 'API_KEY', type: 'string', sensitive: true, prompt: 'Enter the key' },
        { key: 'BASE_URL', type: 'string', default: 'https://api.example.com' },
      ],
    })

    let receivedFields: unknown
    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async (fields) => {
        receivedFields = fields
        return { API_KEY: 'sk-test', BASE_URL: 'https://override' }
      },
    })

    // 回调原样看到了两个字段。
    expect(Array.isArray(receivedFields)).toBe(true)
    expect((receivedFields as Array<{ key: string }>).map((f) => f.key)).toEqual(['API_KEY', 'BASE_URL'])

    // 持久化到插件 id 下的 user-config.json。
    const stored = await getPluginUserConfig(result.pluginId)
    expect(stored).toEqual({ API_KEY: 'sk-test', BASE_URL: 'https://override' })
  })

  it('aborts the install when the userConfig prompt returns null', async () => {
    const src = await makeTempPlugin({
      name: 'aborted',
      version: '1.0.0',
      userConfig: [{ key: 'TOKEN', type: 'string', required: true }],
    })

    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        userConfigPrompt: async () => null,
      }),
    ).rejects.toThrow(/userConfig/)

    // 未创建缓存条目（在移动前已中止）。
    const installed = await listInstalledPlugins()
    expect(installed).toHaveLength(0)
  })

  it('skips the prompt entirely when manifest declares no userConfig', async () => {
    const src = await makeTempPlugin({ name: 'no-cfg', version: '1.0.0' })
    let calls = 0
    await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      userConfigPrompt: async () => {
        calls++
        return {}
      },
    })
    expect(calls).toBe(0)
  })
})

// ── /plugin refresh 热重载 ─────────────────────────────────────────

describe('refreshPluginContributions', () => {
  it('detects an added plugin between two scans and folds it into the skill registry', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { createSkillRegistry } = await import('../src/skills/registry.js')

    // 安装一个带 skill 的插件，从该快照构建注册表。
    const src1 = await makeTempPlugin({ name: 'p1', version: '1.0.0' })
    // 添加 skill 目录，使 resolveContributions 自动检测它。
    await fs.mkdir(path.join(src1, 'skills', 'hello'), { recursive: true })
    await fs.writeFile(
      path.join(src1, 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: greet\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src1 }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const { buildPluginIntegration } = await import('../src/plugins/integration.js')
    const initialIntegration = await buildPluginIntegration(initialLoad)
    const skillRegistry = await createSkillRegistry({ extraDirs: initialIntegration.skillsDirs })
    expect(skillRegistry.get('hello')).toBeDefined()

    // 在初始加载后再安装第二个插件。新 skill 在 /plugin refresh
    // 运行前不应出现。
    const src2 = await makeTempPlugin({ name: 'p2', version: '1.0.0' })
    await fs.mkdir(path.join(src2, 'skills', 'world'), { recursive: true })
    await fs.writeFile(
      path.join(src2, 'skills', 'world', 'SKILL.md'),
      '---\nname: world\ndescription: w\n---\nBody',
      'utf-8',
    )
    await installPlugin({ source: { kind: 'local', path: src2 }, marketplace: 'local' })
    expect(skillRegistry.get('world')).toBeUndefined()

    // 刷新：重建插件注册表并并入新 skill。
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      skillRegistry,
    })
    expect(summary.plugins.added).toContain('p2@local')
    expect(skillRegistry.get('world')).toBeDefined()
    // 既有插件仍然加载。
    expect(skillRegistry.get('hello')).toBeDefined()
  })

  it('restarts MCP servers when an mcpRegistry is wired (plugin install + refresh in one shot)', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')
    const { McpRegistry } = await import('../src/mcp/registry.js')

    // 安装一个声明了内联 mcpServer 的插件。我们使用一个不可达的
    // stdio 命令让服务器连接失败 —— 没关系，因为我们只需验证
    // restartAll 被调用时合并映射中包含该插件的服务器。
    const src = await makeTempPlugin({
      name: 'mcp-bringing-plugin',
      version: '1.0.0',
      mcpServers: {
        'plugin-mcp': { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    // 构建一个 stub McpRegistry，其 restartAll 只记录所见内容，
    // 这样测试不依赖真实的 MCP 子进程启动。
    const seenConfigs: Array<Map<string, unknown>> = []
    const stub = Object.create(McpRegistry.prototype)
    stub.restartAll = async (configs: Map<string, unknown>) => {
      seenConfigs.push(configs)
      return { added: [...configs.keys()], removed: [], changed: [], unchanged: [] }
    }

    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
      mcpRegistry: stub,
      // askUser 实际不会触发，因为测试没有可信的项目级
      // MCP 配置。提供一个被调用就抛错的 stub。
      askUser: async () => {
        throw new Error('askUser should not be invoked when project mcpServers is empty')
      },
    })

    expect(seenConfigs.length).toBe(1)
    expect(seenConfigs[0]!.has('plugin-mcp')).toBe(true)
    expect(summary.mcp).toBeDefined()
    expect(summary.mcp!.added).toContain('plugin-mcp')
  })

  it('skips MCP restart when mcpRegistry is omitted (backwards-compatible default)', async () => {
    const { refreshPluginContributions } = await import('../src/plugins/refresh.js')

    const src = await makeTempPlugin({ name: 'no-mcp-pass', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const initialLoad = await loadAllPlugins({ cwd: process.cwd() })
    const summary = await refreshPluginContributions({
      pluginRegistry: initialLoad.registry,
    })
    expect(summary.mcp).toBeUndefined()
  })
})

/** 启动一个本地 git 仓库并提交一次，返回其路径
 *  （可作为 `kind: 'git'` 的源 URL —— `git clone /path` 可行）以及
 *  最终的 HEAD sha。这样无需网络或真实 GitHub 仓库即可测试 sha 校验。 */
async function makeLocalGitRepo(manifest: Record<string, unknown>): Promise<{ url: string; sha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-git-src-'))
  // `git init -b` 需要 Git 2.28；部分 macOS 机器仍自带旧版本。
  // 改为重命名尚未出生的分支。
  await execa('git', ['init', '-q'], { cwd: root })
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execa('git', ['config', 'user.name', 'test'], { cwd: root })
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest))
  await execa('git', ['add', '-A'], { cwd: root })
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  const sha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  return { url: root, sha }
}

// Windows CI 的进程启动可能吃掉 Vitest 五秒默认超时的大部分，
// 甚至在本地 clone 真正运行之前就超时。为这个真实 Git 集成保持界限，
// 但给它足够空间测试安装器行为而非 runner 负载。
const GIT_INTEGRATION_TIMEOUT_MS = 15_000

describe('install sha integrity check (marketplace.json `sha` field)', () => {
  let repo: Awaited<ReturnType<typeof makeLocalGitRepo>>

  beforeAll(async () => {
    repo = await makeLocalGitRepo({ name: 'demo', version: '1.0.0' })
  }, GIT_INTEGRATION_TIMEOUT_MS)

  afterAll(async () => {
    await fs.rm(repo.url, { recursive: true, force: true })
  })

  it(
    'accepts an install when the declared sha matches the cloned HEAD',
    async () => {
      const result = await installPlugin({
        source: { kind: 'git', url: repo.url, expectedSha: repo.sha },
        marketplace: 'local',
      })
      expect(result.pluginId).toBe('demo@local')
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  )

  it(
    'rejects an install when the declared sha does not match',
    async () => {
      const fakeSha = '0000000000000000000000000000000000000000'
      await expect(
        installPlugin({
          source: { kind: 'git', url: repo.url, expectedSha: fakeSha },
          marketplace: 'local',
        }),
      ).rejects.toThrow(/sha integrity check failed/)
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  )

  it(
    'skips the check entirely when no sha is declared (back-compat with sha-less marketplaces)',
    async () => {
      const result = await installPlugin({
        source: { kind: 'git', url: repo.url }, // 无 expectedSha
        marketplace: 'local',
      })
      expect(result.pluginId).toBe('demo@local')
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  )

  it(
    'accepts a short (≥7 char) sha that prefix-matches the full HEAD — same tolerance as `git checkout <short>`',
    async () => {
      const shortSha = repo.sha.slice(0, 7)
      const result = await installPlugin({
        source: { kind: 'git', url: repo.url, expectedSha: shortSha },
        marketplace: 'local',
      })
      expect(result.pluginId).toBe('demo@local')
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  )

  it(
    'rejects a git subdir that escapes the cloned repository',
    async () => {
      await expect(
        installPlugin({
          source: { kind: 'git', url: repo.url, subdir: '../outside' },
          marketplace: 'local',
        }),
      ).rejects.toThrow(/escapes the cloned repository/)
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  )
})
