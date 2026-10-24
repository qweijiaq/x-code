import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import './i18n.js'
import './styles.css'
import { initTheme } from './theme.js'

initTheme()

function reportError(message: string, stack = ''): void {
  void window.xcode
    .request({ id: crypto.randomUUID(), method: 'renderer:error', params: { message, stack } })
    .catch(() => undefined)
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
