import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { RuntimeEvent, RuntimeRequest, RuntimeResponse, UiSmokeResult, XcodeBridge } from '../shared/protocol.js'

const bridge: XcodeBridge = {
  request(request: RuntimeRequest): Promise<RuntimeResponse> {
    return ipcRenderer.invoke('runtime:request', request) as Promise<RuntimeResponse>
  },
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent): void => listener(payload)
    ipcRenderer.on('runtime:event', handler)
    return () => {
      ipcRenderer.removeListener('runtime:event', handler)
    }
  },
  reportUiSmoke(result: UiSmokeResult): void {
    ipcRenderer.send('ui-smoke:result', result)
  },
  reportUiSmokeProgress(name: string): void {
    ipcRenderer.send('ui-smoke:progress', name)
  },
  copyText(text: string): void {
    // Sandboxed preloads cannot access the clipboard module; the main
    // process owns it.
    ipcRenderer.send('app:copy-text', text)
  },
  pathForFile(file: unknown): string {
    try {
      return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
    } catch {
      return ''
    }
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('xcode', bridge)
