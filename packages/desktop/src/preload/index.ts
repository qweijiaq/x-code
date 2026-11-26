import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { RuntimeEvent, RuntimeRequest, RuntimeResponse, UiSmokeResult, XcodeBridge } from '../shared/protocol.js'

const bridge: XcodeBridge = {
  request(request: RuntimeRequest): Promise<RuntimeResponse> {
    // invoke 可能 reject（通道未注册 / sender 窗口已销毁 / runtime 未就绪）。
    // 调用方按 XcodeBridge.request 的契约（总是 resolve 成 { id, ok, error }）编写，
    // 这里把 reject 收敛成错误响应，避免渲染进程出现 unhandled rejection。
    return (ipcRenderer.invoke('runtime:request', request) as Promise<RuntimeResponse>).catch(
      (error: unknown): RuntimeResponse => ({
        id: request.id,
        ok: false,
        error: { code: 'ipc-failed', message: error instanceof Error ? error.message : String(error) },
      }),
    )
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
    // 沙箱化的 preload 无法访问剪贴板模块；主进程
    // 拥有它。
    ipcRenderer.send('app:copy-text', text)
  },
  reportRunningSessions(workspace: string, sessionIds: string[]): void {
    ipcRenderer.send('app:running-sessions', { workspace, sessionIds })
  },
  onRunningSessions(listener: (entries: Array<{ workspace: string; sessionIds: string[] }>) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      entries: Array<{ workspace: string; sessionIds: string[] }>,
    ): void => listener(entries)
    ipcRenderer.on('app:running-sessions', handler)
    return () => {
      ipcRenderer.removeListener('app:running-sessions', handler)
    }
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
