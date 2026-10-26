// 测试浏览器子智能体：launch-config 构建器（纯函数）和
// 由配置门控的注册（该智能体只有在启用时才出现在 registry 中）。
// 这里不真正连接 @playwright/mcp —— 那会拉起 npx + 一个浏览器，对 CI 来说太重 / 太联网。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PLAYWRIGHT_MCP_PACKAGE, buildBrowserServerConfig } from '../src/agent/browser/registry.js'
import { createBuiltInRegistry, createSubAgentRegistry } from '../src/agent/sub-agents/registry.js'

describe('buildBrowserServerConfig', () => {
  it('defaults to npx @playwright/mcp on the chrome channel, headed', () => {
    const c = buildBrowserServerConfig({}) as { command: string; args: string[] }
    // command 因平台而异（win32 上是 cmd /c）；playwright 参数不变。
    const joined = [c.command, ...c.args].join(' ')
    expect(joined).toContain(PLAYWRIGHT_MCP_PACKAGE)
    expect(joined).not.toContain('@latest')
    expect(joined).toContain('--browser chrome')
    expect(joined).not.toContain('--headless')
    expect(joined).toContain('--caps vision')
    expect(joined).not.toContain('--extension')
  })

  it('adds --headless and honours the browser channel', () => {
    const c = buildBrowserServerConfig({ headless: true, browser: 'msedge' }) as { command: string; args: string[] }
    const joined = [c.command, ...c.args].join(' ')
    expect(joined).toContain('--headless')
    expect(joined).toContain('--browser msedge')
  })

  it('a command override bypasses the npx default', () => {
    const c = buildBrowserServerConfig({ command: 'my-server', args: ['--port', '7'] })
    expect(c).toMatchObject({ command: 'my-server', args: ['--port', '7'] })
  })

  it('redirects saved output off the repo via --output-dir (npx path only)', async () => {
    const def = buildBrowserServerConfig({}) as { command: string; args: string[] }
    expect(def.args).toContain('--output-dir')
    const outputDirectory = def.args[def.args.indexOf('--output-dir') + 1]!
    expect(path.dirname(outputDirectory)).toBe(os.tmpdir())
    expect(path.basename(outputDirectory)).toMatch(/^x-code-browser-/)
    if (process.platform !== 'win32') {
      expect((await fs.stat(outputDirectory)).mode & 0o777).toBe(0o700)
    }

    // 完整的 command 覆盖拥有自己的 argv —— 我们不注入 --output-dir。
    const override = buildBrowserServerConfig({ command: 'my-server', args: ['--port', '7'] })
    if (!('command' in override)) throw new Error('Expected a stdio browser server config')
    expect(override.args).not.toContain('--output-dir')
  })

  it('keeps vision capabilities stable by default and supports an explicit tree-only override', () => {
    const off = buildBrowserServerConfig({ vision: false }) as { command: string; args: string[] }
    expect([off.command, ...off.args].join(' ')).not.toContain('--caps vision')

    const on = buildBrowserServerConfig({}) as { command: string; args: string[] }
    // 相邻的参数，在 win32 的 cmd /c 包装后依然保留
    expect([on.command, ...on.args].join(' ')).toContain('--caps vision')
  })
})

describe('browser sub-agent registration gating', () => {
  let home: string
  let prevHome: string | undefined
  beforeAll(async () => {
    // 与开发者真实的 ~/.x-code 隔离，让 custom-agent 磁盘扫描
    // 和默认配置门控都看到一个空 home。
    prevHome = process.env.X_CODE_HOME
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-'))
    process.env.X_CODE_HOME = home
  })
  afterAll(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  })

  it('registers the browser agent only when includeBrowser is true', async () => {
    const on = await createSubAgentRegistry({ includeBrowser: true })
    expect(on.names()).toContain('browser')

    const off = await createSubAgentRegistry({ includeBrowser: false })
    expect(off.names()).not.toContain('browser')
  })

  it('omits the browser agent by default (no config enabling it)', async () => {
    const reg = await createSubAgentRegistry()
    expect(reg.names()).not.toContain('browser')
  })

  it('setBrowserEnabled toggles the browser agent in place (the /browser on|off mechanism)', () => {
    const reg = createBuiltInRegistry()
    expect(reg.names()).not.toContain('browser')
    reg.setBrowserEnabled(true)
    expect(reg.names()).toContain('browser')
    reg.setBrowserEnabled(false)
    expect(reg.names()).not.toContain('browser')
  })
})
