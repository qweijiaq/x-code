import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  diagnosticsPath: string
  copied: boolean
}

/** Last-resort UI when a render error would otherwise leave a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, diagnosticsPath: '', copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.xcode
      .request({
        id: crypto.randomUUID(),
        method: 'renderer:error',
        params: { message: error.message, stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` },
      })
      .catch(() => undefined)
  }

  private exportDiagnostics = async (): Promise<void> => {
    const response = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'diagnostics:export',
      params: {},
    })
    if (response.ok) {
      this.setState({ diagnosticsPath: (response.result as { path: string }).path })
    }
  }

  private copyError = (): void => {
    const error = this.state.error
    if (!error) return
    window.xcode.copyText(`${error.message}\n${error.stack ?? ''}`)
    this.setState({ copied: true })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <div className="crash-title">界面出错了</div>
          <p className="crash-desc">
            这个窗口的界面渲染失败，但运行时和会话数据仍在。可以先重新加载；如果反复出现，请导出诊断包。
          </p>
          <pre className="crash-detail">{`${error.message}\n${error.stack ?? ''}`}</pre>
          {this.state.diagnosticsPath ? <p className="crash-path">诊断包：{this.state.diagnosticsPath}</p> : null}
          <div className="crash-actions">
            <button className="btn solid" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button className="btn" onClick={() => void this.exportDiagnostics()}>
              导出诊断
            </button>
            <button className="btn btn-quiet" onClick={this.copyError}>
              {this.state.copied ? '已复制' : '复制错误'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
