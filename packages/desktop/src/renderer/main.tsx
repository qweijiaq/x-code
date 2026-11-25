import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import './i18n.js'
import './styles.css'
import { initTheme } from './theme.js'

initTheme()

function reportError(message: string, stack = ''): void {
  // 这个函数本身跑在 error / unhandledrejection 监听器里。preload 缺失、加载
  // 失败或环境里没有 crypto.randomUUID 时，任何同步抛错都会被当成新的 error
  // 再次进入本函数，形成递归噪声。所有前置条件先探测再调用。
  try {
    if (typeof window === 'undefined' || !window.xcode?.request) return
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `renderer-error-${Date.now()}-${Math.random().toString(16).slice(2)}`
    void window.xcode.request({ id, method: 'renderer:error', params: { message, stack } }).catch(() => undefined)
  } catch {
    // 上报通道本身不可用；不要再次抛出，否则会递归触发 error 监听器。
  }
}

window.addEventListener('error', (event) => {
  reportError(event.message, event.error instanceof Error ? (event.error.stack ?? '') : '')
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  reportError(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? (reason.stack ?? '') : '',
  )
})

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
