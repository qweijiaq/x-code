// 反向请求通道：运行时（utilityProcess）→ Electron 主进程。
//
// 有些工作只有主进程能做：打印 PDF（BrowserWindow）和
// safeStorage 加密（OS 钥匙串）。运行时发出 `main-request` 并
// 等待匹配的 `main-response`；两侧的类型都定义在
// shared/protocol.ts。
import type { MainRequestMethod, MainRequestParams, RuntimeInbound, RuntimeOutbound } from '../shared/protocol.js'

interface BridgePort {
  postMessage(message: RuntimeOutbound): void
}

interface PendingMainRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let port: BridgePort | null = null
const pending = new Map<string, PendingMainRequest>()
let sequence = 0

export function initMainBridge(nextPort: BridgePort): void {
  port = nextPort
}

export function requestMain<T>(method: MainRequestMethod, params: MainRequestParams, timeoutMs = 40_000): Promise<T> {
  const activePort = port
  if (!activePort) return Promise.reject(new Error('Main bridge is not initialized'))
  const id = `main-${++sequence}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Main request timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    // postMessage 在主进程端口已销毁时同步抛错。executor 里抛出只会让 promise
    // reject，而 pending 条目和定时器会一直挂着（还可能拖住 utilityProcess 退出），
    // 调用方也拿不到带方法名的错误。因此显式清理后再 reject。
    try {
      activePort.postMessage({ kind: 'main-request', id, method, params })
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(
        new Error(`Main request failed to send: ${method} (${error instanceof Error ? error.message : String(error)})`),
      )
    }
  })
}

/** 解决一个待处理请求。当消息是响应时返回 true。 */
export function handleMainResponse(message: RuntimeInbound): boolean {
  if (message.kind !== 'main-response') return false
  const entry = pending.get(message.id)
  if (entry) {
    clearTimeout(entry.timer)
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  }
  return true
}
