import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { McpOAuthProvider } from '../src/mcp/oauth/provider.js'
import { McpTokenStorage } from '../src/mcp/oauth/token-storage.js'

/** 将测试与开发者真实的 ~/.x-code/mcp-auth.json 隔离开。 */
function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-oauth-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

function makeProvider(): McpOAuthProvider {
  return new McpOAuthProvider({
    serverName: 'test-server',
    serverUrl: 'https://example.com/mcp',
    storage: new McpTokenStorage(),
  })
}

describe('McpOAuthProvider.redirectUrl', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('returns a loopback placeholder when no callback server is running', () => {
    // 回归修复：早期版本在这里抛错，导致 HTTP MCP server 在首次引导时表现为
    // `failed` 而不是 `needs_auth`（SDK 在构造 authorize URL 时读取 redirectUrl，
    // 早于 redirectToAuthorization 触发并启动 callback server）。
    const provider = makeProvider()
    const url = provider.redirectUrl
    // 必须是 loopback URL —— 按 RFC 8252，auth server 必须接受本机的任意端口，
    // 因此没有具体端口是可以的。
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1/)
  })

  it('keeps clientMetadata.redirect_uris consistent with redirectUrl', () => {
    // 两个 getter 使用的占位符必须一致，否则动态注册请求里是一个 URL，
    // 而 SDK 用另一个 URL 构造 authorize URL —— auth server 会返回 redirect_uri_mismatch。
    const provider = makeProvider()
    expect(provider.clientMetadata.redirect_uris).toContain(provider.redirectUrl)
  })
})

describe('McpOAuthProvider.redirectToAuthorization (passive vs interactive)', () => {
  beforeEach(() => {
    isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('does NOT open a browser by default (passive mode)', async () => {
    // 回归修复：早期版本在这里无条件打开浏览器，只要 HTTP MCP server 没有存储令牌，
    // 就会在 CLI 引导时触发。没有任何竞品 CLI 这样做 —— 它们都等待用户显式操作。
    // 我们通过检查没有启动 callback server、也没有触发 onOpenBrowser 钩子来验证。
    let opened: string | null = null
    const provider = new McpOAuthProvider({
      serverName: 'test-server',
      serverUrl: 'https://example.com/mcp',
      storage: new McpTokenStorage(),
      onOpenBrowser: (url) => {
        opened = url
      },
    })

    const before = provider.redirectUrl
    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
    const after = provider.redirectUrl

    expect(opened).toBeNull()
    // 前后占位符相同 —— callback server 从未启动，因此 URL 没有变成包含真实端口。
    expect(after).toBe(before)
  })

  // 我们有意不在这里测试交互式（setInteractive(true)）路径。该路径调用
  // openInBrowser → child_process.spawn，每次 `pnpm test` 运行时都会真的打开
  // 开发者的浏览器。交互流程由手动 /mcp auth 测试 + 现有的 connectWithOAuth 接线覆盖。
})
