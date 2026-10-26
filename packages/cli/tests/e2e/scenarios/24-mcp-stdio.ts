import path from 'node:path'

import type { Scenario } from '../framework/types.js'

// 最小化的 stdio MCP 服务器，以内联源码形式呈现，使场景自包含
//（无跨包文件引用）。实现了 McpClient.connect → listTools → callTool
// 所需的少数方法；其余以 method-not-found 应答，让 SDK 回退。
// `greet` 工具在其响应中打上不透明标记，这样我们可以从 assistant 文本
// 断言调用确实真的往返成功了 — 而一句普通的 "Hello, World!" 可能被模型幻觉出来。
const MOCK_SERVER_SRC = String.raw`#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) try { handle(JSON.parse(line)) } catch (e) { process.stderr.write(String(e) + '\n') }
  }
})
function send(m) { process.stdout.write(JSON.stringify(m) + '\n') }
function handle(msg) {
  const { method, id, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-e2e', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'greet', description: 'Greet a person by name and return a friendly hello.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    ] } })
  } else if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'greet') {
      const who = typeof args.name === 'string' ? args.name : 'stranger'
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Hello, ' + who + '! [MCP_MARKER_AB12CD34]' }] } })
    } else if (typeof id !== 'undefined') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } })
    }
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
  } else if (typeof id !== 'undefined') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}
`

const scenario: Scenario = {
  id: '24-mcp-stdio',
  name: 'MCP stdio: model calls mock__greet and quotes the server-stamped marker',
  async run(ctx) {
    // 1. 把内联 mock MCP 服务器写入 tmpDir，以及指向它的用户配置。
    //    harness 已经把 X_CODE_HOME 隔离在 <tmpDir>/.x-code-home 下，
    //    所以同一场景可并行运行而不会踩到真实的 ~/.x-code。
    await ctx.writeFile('mock-server.mjs', MOCK_SERVER_SRC)
    const serverPath = path.join(ctx.tmpDir, 'mock-server.mjs')

    await ctx.mkdir('.x-code-home')
    await ctx.writeFile(
      '.x-code-home/config.json',
      JSON.stringify(
        {
          // X_CODE_MODEL 由 harness 设置，所以这里无需 `model`。
          mcpServers: {
            mock: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
        null,
        2,
      ),
    )

    // 2. 运行 CLI。--trust 绕过每个工具的询问提示，让模型能调用
    //    mock__greet，而 onAskPermission 不会阻塞 print 模式
    //   （print 模式没有 UI 可应答对话框）。
    const r = await ctx.runCli(
      [
        'There is an MCP server named "mock" connected. It exposes a tool',
        'mock__greet that takes { name: string } and returns a greeting',
        'string. Call it with name="World" and then quote the EXACT text the',
        'tool returned in your reply.',
      ].join(' '),
      { args: ['--trust', '--max-turns', '5'] },
    )

    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'mock__greet', { name: 'World' })
    // 标记是服务器打入的随机外观 token。没有真正等待工具结果的
    // 模型无法复现它。
    ctx.expect.assistantMentions(r, /MCP_MARKER_AB12CD34/)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
