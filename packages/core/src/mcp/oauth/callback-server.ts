// @x-code-cli/core — 本地 OAuth 回调接收器
//
// 在 127.0.0.1:<随机端口>/callback 上启动一个临时 HTTP 服务器，等待用户的
// 授权服务器重定向，返回捕获到的 `code` + `state`（或错误）。在首个请求
// （或超时）后自动关闭。
//
// 为什么用临时 + 随机端口：
//   - 两个 CLI 并发运行时会撞固定端口。
//   - 随机端口要求监听器起来后再告诉 OAuth provider URL——我们暴露的
//     `start()` 会在解析任何回调之前返回真实 URL。
//
// 安全：
//   - 只绑定 127.0.0.1，绝不 0.0.0.0——监听器不应被其他机器访问。
//   - 我们只接受第一个匹配的请求；后续命中返回友好的
//     "auth complete, you can close this window" 页面。
//   - 这里不校验 `state`——那是 SDK 的职责。我们只转发认证服务器回传的
//     内容。
import http from 'node:http'
import { AddressInfo } from 'node:net'

import { debugLog } from '../../utils.js'

export interface CallbackResult {
  code: string
  state?: string
}

export interface RunningCallbackServer {
  /** 要告知认证服务器的完整重定向 URL。 */
  url: string
  /** 在首个有效回调请求时以 code/state resolve，
   *  或在超时 / OAuth 错误响应时 reject。 */
  waitForCallback: () => Promise<CallbackResult>
  /** 停止接受新连接并释放端口。幂等。 */
  close: () => void
}

export interface StartOptions {
  /** 最长等待时间（毫秒）。默认 5 分钟。 */
  timeoutMs?: number
  /** 认证服务器应重定向到的路径。
   *  默认 '/callback'。 */
  path?: string
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_PATH = '/callback'

/** 启动监听器并把控制权返回给调用方，使其能把 URL 交给认证 provider。
 *  真正的等待通过返回的 `waitForCallback()` promise 进行。 */
export async function startCallbackServer(options: StartOptions = {}): Promise<RunningCallbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectedPath = options.path ?? DEFAULT_PATH

  let resolveOnce: ((r: CallbackResult) => void) | null = null
  let rejectOnce: ((e: Error) => void) | null = null

  const waiter = new Promise<CallbackResult>((res, rej) => {
    resolveOnce = res
    rejectOnce = rej
  })

  const server = http.createServer((req, response) => {
    if (!req.url) {
      response.writeHead(400).end('missing URL')
      return
    }
    // 用一个虚拟 base 解析——我们只关心 pathname + search。
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname !== expectedPath) {
      response.writeHead(404).end('not found')
      return
    }

    const err = u.searchParams.get('error')
    if (err) {
      const desc = u.searchParams.get('error_description') ?? ''
      response
        .writeHead(400, { 'Content-Type': 'text/html' })
        .end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(err)}: ${escapeHtml(desc)}</p></body></html>`)
      rejectOnce?.(new Error(`OAuth callback error: ${err} ${desc}`.trim()))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const code = u.searchParams.get('code')
    if (!code) {
      response.writeHead(400).end('missing code')
      rejectOnce?.(new Error('OAuth callback missing `code` parameter'))
      resolveOnce = null
      rejectOnce = null
      return
    }

    const state = u.searchParams.get('state') ?? undefined
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<html><body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto;">` +
          `<h1>Authorization complete</h1>` +
          `<p>You can close this tab and return to the X-Code CLI.</p>` +
          `</body></html>`,
      )
    resolveOnce?.({ code, state })
    resolveOnce = null
    rejectOnce = null
  })

  // 监听 socket 错误，使连接重置不会在 Windows 上崩溃 CLI
  // （那里 ECONNRESET 更常见）。
  server.on('error', (err) => {
    debugLog('mcp.callback-server-error', String(err))
    rejectOnce?.(err)
    resolveOnce = null
    rejectOnce = null
  })

  // 绑定到临时端口。listen(0, '127.0.0.1') 让 OS 分配任意空闲端口；
  // 实际端口从 address() 里取。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}${expectedPath}`

  const timeoutHandle = setTimeout(() => {
    rejectOnce?.(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
    resolveOnce = null
    rejectOnce = null
  }, timeoutMs)
  // 任一 resolve 路径都清除定时器。
  void waiter.finally(() => clearTimeout(timeoutHandle))

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    server.close()
  }
  // 处理完（单个）回调后自动关闭。
  void waiter.finally(close)

  return { url, waitForCallback: () => waiter, close }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
