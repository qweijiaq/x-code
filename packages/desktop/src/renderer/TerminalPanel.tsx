import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { useEffect, useRef } from 'react'

const LIGHT_TERMINAL_THEME = {
  background: '#fbfaf7',
  foreground: '#1f1e1c',
  cursor: '#c0563f',
  cursorAccent: '#fbfaf7',
  selectionBackground: 'rgba(155, 74, 99, 0.22)',
  black: '#1c1a16',
  red: '#b03a2e',
  green: '#5f7a61',
  yellow: '#a8732f',
  blue: '#3f5f7f',
  magenta: '#9b4a63',
  cyan: '#6b8f99',
  white: '#f6f2e8',
  brightBlack: '#6b675e',
  brightRed: '#c9574a',
  brightGreen: '#7d9a7f',
  brightYellow: '#c9a227',
  brightBlue: '#5b7fa3',
  brightMagenta: '#b56b82',
  brightCyan: '#8fb0b8',
  brightWhite: '#ffffff',
}

const DARK_TERMINAL_THEME = {
  background: '#1a1a19',
  foreground: '#e9e7e1',
  cursor: '#d97862',
  cursorAccent: '#1a1a19',
  selectionBackground: 'rgba(180, 167, 200, 0.25)',
  black: '#1c1a16',
  red: '#cc6a5b',
  green: '#9cba9d',
  yellow: '#cfa368',
  blue: '#91b1cd',
  magenta: '#ca8297',
  cyan: '#9fc2cc',
  white: '#d9d2c2',
  brightBlack: '#6b675e',
  brightRed: '#da8374',
  brightGreen: '#b3d0b4',
  brightYellow: '#dfc667',
  brightBlue: '#a8c4dc',
  brightMagenta: '#dd9cae',
  brightCyan: '#b6d4dc',
  brightWhite: '#f6f2e8',
}

function terminalTheme(): typeof LIGHT_TERMINAL_THEME {
  return document.documentElement.dataset.theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}

export function TerminalPanel(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'PingFang SC', monospace",
      scrollback: 5000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    term.focus()

    let disposed = false
    let shellId: string | null = null
    const bufferedOutput: string[] = []

    const off = window.xcode.onEvent((event) => {
      if (event.type === 'shell:output') {
        if (shellId === null) bufferedOutput.push(event.data)
        else if (event.id === shellId) term.write(event.data)
      } else if (event.type === 'shell:exit' && event.id === shellId) {
        term.writeln(`\r\n\x1b[90m[process exited: ${event.exitCode}]\x1b[0m`)
      }
    })

    void window.xcode
      .request({
        id: crypto.randomUUID(),
        method: 'shell:create',
        params: { cols: term.cols, rows: term.rows },
      })
      .then((response) => {
        if (!response.ok) {
          if (!disposed) term.writeln(`\x1b[31m[shell error] ${response.error.message}\x1b[0m`)
          return
        }
        const id = (response.result as { id: string }).id
        if (disposed) {
          // The panel closed before the shell finished starting.
          void window.xcode.request({ id: crypto.randomUUID(), method: 'shell:kill', params: { id } })
          return
        }
        shellId = id
        for (const chunk of bufferedOutput.splice(0)) term.write(chunk)
      })

    const dataSub = term.onData((data) => {
      if (!shellId) return
      void window.xcode.request({
        id: crypto.randomUUID(),
        method: 'shell:write',
        params: { id: shellId, data },
      })
    })

    const observer = new ResizeObserver(() => {
      fit.fit()
      if (shellId) {
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'shell:resize',
          params: { id: shellId, cols: term.cols, rows: term.rows },
        })
      }
    })
    observer.observe(container)

    // The terminal palette follows the app theme without recreating the shell.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      disposed = true
      off()
      dataSub.dispose()
      observer.disconnect()
      themeObserver.disconnect()
      if (shellId) {
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'shell:kill',
          params: { id: shellId },
        })
      }
      term.dispose()
    }
  }, [])

  return <div className="terminal" ref={containerRef} />
}
