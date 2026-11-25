import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  diagnosticsPath: string
  diagnosticsError: string
  copied: boolean
}

/** 渲染错误否则会留下空白窗口时的兜底 UI。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, diagnosticsPath: '', diagnosticsError: '', copied: false }

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
    // 这段代码运行在错误兜底 UI 里：它本身绝不能再抛错，否则最后的可用
    // 界面也会崩掉（IPC 很可能已经不可用）。
    try {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'diagnostics:export',
        params: {},
      })
      if (!response.ok) {
        this.setState({ diagnosticsError: `导出诊断失败：${response.error.message}` })
        return
      }
      const filePath = (response.result as { path?: unknown } | undefined)?.path
      if (typeof filePath !== 'string' || !filePath) {
        this.setState({ diagnosticsError: '导出诊断失败：返回结果中缺少文件路径' })
        return
      }
      this.setState({ diagnosticsPath: filePath, diagnosticsError: '' })
    } catch (cause) {
      this.setState({ diagnosticsError: `导出诊断失败：${cause instanceof Error ? cause.message : String(cause)}` })
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
          {this.state.diagnosticsError ? (
            <p className="crash-path" role="alert">
              {this.state.diagnosticsError}
            </p>
          ) : null}
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
