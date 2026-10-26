// 针对 `runPluginCli(['update', ...])` 的测试 — 覆盖单个 id 与 --all 两条路径。
//
// CLI 子命令与 slash 形式共用同一个核心 `installPlugin`，所以这里不重复验证
// 安装行为；聚焦 argv 解析与 --all 聚合：分类（updated / unchanged / failed）、
// 裸调用拒绝、以及出错跳过。
//
// 每个测试都在隔离的 XC_PLUGINS_DIR 中运行，安装落到临时缓存，
// 不会污染用户真实的 ~/.x-code。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installPlugin, listInstalledPlugins } from '@x-code-cli/core'

import { runPluginCli } from '../src/plugins/cli.js'

let originalPluginsDir: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

async function makeTempPlugin(body: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-src-'))
  await fs.writeFile(path.join(root, 'plugin.json'), JSON.stringify(body), 'utf-8')
  return root
}

function combinedOutput(): string {
  const log = logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
  const err = errSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
  return `${log}\n${err}`
}

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  process.env.XC_PLUGINS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-update-cache-'))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('xc plugin update — argv parsing', () => {
  it('rejects bare `update` invocation with a usage hint that lists both forms', async () => {
    const code = await runPluginCli(['update'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Usage:.*update.*<id>.*--all/)
  })

  it('rejects mixing a positional id and --all in the same call', async () => {
    const code = await runPluginCli(['update', 'demo@local', '--all'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/either `?--all`? or a plugin id, not both/)
  })

  it('errors when the requested single-id plugin is not installed', async () => {
    const code = await runPluginCli(['update', 'nope@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/Plugin 'nope@local' not installed/)
  })
})

describe('xc plugin update --all', () => {
  it("returns 0 and reports 'No plugins installed' when the registry is empty", async () => {
    const code = await runPluginCli(['update', '--all', '--yes'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })

  it("classifies a same-version re-install as 'unchanged' and returns 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', '--all', '--yes'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 0 failed/)
  })

  it("reports a real version bump as 'updated' and returns 0", async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    // 原地升级源清单 — update 从记录的源路径重装时应能拿到新版本。
    await fs.writeFile(path.join(src, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.1.0' }))

    const code = await runPluginCli(['update', '--all', '--yes'])
    expect(code).toBe(0)
    const out = combinedOutput()
    expect(out).toMatch(/demo@local: 1\.0\.0 → 1\.1\.0/)
    expect(out).toMatch(/Summary: 1 updated, 0 unchanged, 0 failed/)
  })

  it('skips on error: one failing plugin does not abort the others, summary counts failure, exit code is 1', async () => {
    const goodSrc = await makeTempPlugin({ name: 'good', version: '1.0.0' })
    const badSrc = await makeTempPlugin({ name: 'bad', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: goodSrc }, marketplace: 'local' })
    await installPlugin({ source: { kind: 'local', path: badSrc }, marketplace: 'local' })
    // 安装后删除坏源 — update 路径的 `installPlugin` 会因目录缺失而读取失败。
    await fs.rm(badSrc, { recursive: true, force: true })

    const code = await runPluginCli(['update', '--all', '--yes'])
    expect(code).toBe(1)
    const out = combinedOutput()
    expect(out).toMatch(/Updating 2 plugins/)
    expect(out).toMatch(/good@local: reinstalled at 1\.0\.0/)
    expect(out).toMatch(/bad@local: failed/)
    expect(out).toMatch(/Summary: 0 updated, 1 unchanged, 1 failed/)

    // 两个插件仍在注册表中 — 批量更新不应移除失败条目，只上报。
    const records = await listInstalledPlugins()
    expect(records.map((r) => r.id).sort()).toEqual(['bad@local', 'good@local'])
  })

  it('accepts -a as an alias for --all', async () => {
    const code = await runPluginCli(['update', '-a'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/No plugins installed/)
  })
})

describe('xc plugin update <id>', () => {
  it('single-id re-install at the same version returns 0', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })

    const code = await runPluginCli(['update', 'demo@local', '--yes'])
    expect(code).toBe(0)
    expect(combinedOutput()).toMatch(/demo@local: reinstalled at 1\.0\.0/)
  })

  it('single-id with broken source returns 1', async () => {
    const src = await makeTempPlugin({ name: 'demo', version: '1.0.0' })
    await installPlugin({ source: { kind: 'local', path: src }, marketplace: 'local' })
    await fs.rm(src, { recursive: true, force: true })

    const code = await runPluginCli(['update', 'demo@local'])
    expect(code).toBe(1)
    expect(combinedOutput()).toMatch(/demo@local: failed/)
  })
})
