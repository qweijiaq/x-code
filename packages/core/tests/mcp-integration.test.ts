// MCP 栈的集成测试 —— 把 McpClient 连接到一个实现最小 stdio MCP server 的
// 真实子进程，然后端到端地演练 connect → listTools → callTool → readResource → close。
//
// 为什么用自定义 mock 而不用 `@modelcontextprotocol/server-filesystem`：
//   - 官方 server 在首次运行时通过 npx install 引入几百 KB 的依赖；没有热缓存时在 CI 中不稳定
//   - 我们需要确定性的工具 / 资源形状来做断言
//   - 仅 100 行，紧挨着使用它的测试
import { describe, expect, it } from 'vitest'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient } from '../src/mcp/client.js'
import { loadMcpServers } from '../src/mcp/loader.js'
import { buildCallableName } from '../src/mcp/name-mangling.js'
import { McpRegistry } from '../src/mcp/registry.js'
import type { McpServerConfig } from '../src/mcp/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mock-mcp-server.mjs')

describe('MCP integration (stdio)', () => {
  it('connect → list tools → call tool → close', async () => {
    const client = new McpClient('mock', {
      command: process.execPath,
      args: [MOCK_SERVER],
    })
    try {
      const info = await client.connect()
      expect(info.toolCount).toBe(2)
      const tools = client.tools()
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'echo'])

      const echoed = await client.callTool('echo', { text: 'hello' })
      expect(echoed.isError).toBe(false)
      expect(echoed.text).toBe('hello')

      const summed = await client.callTool('add', { a: 2, b: 3 })
      expect(summed.text).toBe('5')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('reports a close that happened before a lifecycle listener registered', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    let liveNotifications = 0
    let lateNotifications = 0
    try {
      await client.connect()
      expect(
        client.onClose(() => {
          liveNotifications++
        }),
      ).toBe(true)
      await client.close()
      expect(liveNotifications).toBe(1)

      expect(
        client.onClose(() => {
          lateNotifications++
        }),
      ).toBe(false)
      expect(lateNotifications).toBe(1)
    } finally {
      await client.close()
    }
  }, 15_000)

  it('reads resources end-to-end', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const resources = client.resources()
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('mock://hello')

      const content = await client.readResource('mock://hello')
      expect(content.text).toBe('hello world')
      expect(content.mimeType).toBe('text/plain')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('surfaces server-reported errors via isError', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const r = await client.callTool('boom', {})
      expect(r.isError).toBe(true)
    } finally {
      await client.close()
    }
  }, 15_000)

  it('restartServer reconnects a stdio server in place', async () => {
    // 通过 loader 引导一个真实 registry，从而端到端地演练 configs + oauthFactory
    // 的接线。loader 启动 mock server，枚举 `echo` + `add`，并返回一个 registry，
    // 其 configs map 记住了启动配置 —— restartServer() 从这里读取。
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      const before = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(before).toContain('mock__echo')

      const restarted = await registry.restartServer('mock')
      expect(restarted.status.kind).toBe('connected')

      // 对同一 server 重连后工具列表应保持不变 —— 我们验证的是 registry 干净地重建，
      // 而不是 server 改变了自己的接口。
      const after = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(after).toEqual(before)

      // 验证新 client（而非旧的、现已关闭的那个）处理调用。
      const r = await registry.callTool('mock__echo', { text: 'after-restart' })
      expect(r.text).toBe('after-restart')
    } finally {
      await registry.shutdown()
    }
  }, 20_000)

  it('restartAll diffs added / removed / changed servers', async () => {
    // 先用一个 server 引导，再用不同的配置集调用 restartAll：
    //   - 'mock' 保留（配置相同）            → unchanged
    //   - 'mock-b' 是新增                    → added
    //   - 'mock-old' 本应在但不存在          → (n/a —— 未被引导)
    // 然后第二次 restartAll 移除 'mock-b'，以演练 removed 路径。
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      // restartAll：`mock` 不变 + 新增 `mock-b`
      const configs1 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER] }],
        ['mock-b', { command: process.execPath, args: [MOCK_SERVER] }],
      ])
      const summary1 = await registry.restartAll(configs1)
      expect(summary1.added).toEqual(['mock-b'])
      expect(summary1.removed).toEqual([])
      expect(summary1.unchanged).toEqual(['mock'])

      // 现在两者都已连接 —— 工具列表覆盖两个 server。
      const names = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(names).toContain('mock__echo')
      expect(names).toContain('mock_b__echo')

      // 第二次 restartAll：移除 mock-b，轻微修改 mock 的 args。
      const configs2 = new Map<string, McpServerConfig>([
        ['mock', { command: process.execPath, args: [MOCK_SERVER], timeout: 15_000 }],
      ])
      const summary2 = await registry.restartAll(configs2)
      expect(summary2.added).toEqual([])
      expect(summary2.removed).toEqual(['mock-b'])
      expect(summary2.changed).toEqual(['mock'])

      // mock-b 不应再出现在工具面中。
      const afterRemoval = registry
        .list()
        .map((t) => t.callableName)
        .sort()
      expect(afterRemoval).not.toContain('mock_b__echo')
      expect(afterRemoval).toContain('mock__echo')
    } finally {
      await registry.shutdown()
    }
  }, 30_000)

  it('authenticateServer rejects stdio servers', async () => {
    const { registry } = await loadMcpServers({
      userServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
      projectServers: undefined,
      projectPath: process.cwd(),
      askUser: async () => 'skip',
    })
    try {
      await expect(registry.authenticateServer('mock')).rejects.toThrow(/stdio/i)
    } finally {
      await registry.shutdown()
    }
  }, 15_000)

  it('registry dispatches by callable name', async () => {
    const client = new McpClient('mock', { command: process.execPath, args: [MOCK_SERVER] })
    try {
      await client.connect()
      const taken = new Set<string>()
      const tools = client.tools().map((t) => ({
        callableName: buildCallableName('mock', t.name, taken),
        rawName: t.name,
        serverName: 'mock',
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }))
      for (const t of tools) taken.add(t.callableName)

      const registry = new McpRegistry({
        servers: [{ name: 'mock', client, status: { kind: 'connected', toolCount: 2, resourceCount: 1 } }],
        tools,
        resources: [],
      })

      // 验证分发经过 registry 的 callTool 包装器。
      const callable = tools.find((t) => t.rawName === 'echo')!.callableName
      const result = await registry.callTool(callable, { text: 'via registry' })
      expect(result.text).toBe('via registry')
    } finally {
      await client.close()
    }
  }, 15_000)

  it('keeps the first owner when servers expose the same resource URI', () => {
    const first = new McpClient('first', { command: process.execPath })
    const second = new McpClient('second', { command: process.execPath })
    const registry = new McpRegistry({
      servers: [
        { name: 'first', client: first, status: { kind: 'connected', toolCount: 0, resourceCount: 1 } },
        { name: 'second', client: second, status: { kind: 'connected', toolCount: 0, resourceCount: 1 } },
      ],
      tools: [],
      resources: [
        { uri: 'shared://resource', name: 'first', serverName: 'first' },
        { uri: 'shared://resource', name: 'second', serverName: 'second' },
      ],
    })

    expect(registry.listResources()).toEqual([{ uri: 'shared://resource', name: 'first', serverName: 'first' }])
    expect(registry.resourceServer('shared://resource')).toBe(first)
  })
})
