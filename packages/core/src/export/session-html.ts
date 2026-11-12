// @x-code-cli/core — 会话回放 HTML
//
// 单文件、内联 CSS、无外部依赖。CLI 的 `/export html` 与桌面的 HTML/PDF
// 导出共用这一份渲染器，避免两边样式和行为漂移。所有用户/工具内容都经过
// HTML 转义：导出的文件可能来自任意工具输出，不能被当作可执行标记。
export interface SessionHtmlEntry {
  role: 'user' | 'assistant' | 'system' | 'error' | 'tool'
  text: string
  toolName?: string
  toolInput?: unknown
  toolOutput?: string
  toolStatus?: string
}

export interface SessionHtmlMeta {
  title: string
  sessionId: string
  modelId?: string
  usage?: { inputTokens: number; outputTokens: number }
  generatedAt?: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderEntry(entry: SessionHtmlEntry): string {
  if (entry.role === 'user' || entry.role === 'assistant') {
    const label = entry.role === 'user' ? '你' : 'X-CODE'
    return `<section class="${entry.role}"><h2>${label}</h2><pre>${escapeHtml(entry.text)}</pre></section>`
  }
  if (entry.role === 'system' || entry.role === 'error') {
    const label = entry.role === 'error' ? '错误' : '系统'
    return `<section class="${entry.role}"><h2>${label}</h2><pre>${escapeHtml(entry.text)}</pre></section>`
  }
  const input =
    entry.toolInput === undefined
      ? ''
      : `<pre class="input">${escapeHtml(JSON.stringify(entry.toolInput, null, 2))}</pre>`
  const output = entry.toolOutput ? `<pre class="output">${escapeHtml(entry.toolOutput)}</pre>` : ''
  const status = entry.toolStatus ? ` · ${escapeHtml(entry.toolStatus)}` : ''
  return `<details class="tool"><summary>工具 · ${escapeHtml(entry.toolName ?? '(unknown)')}${status}</summary>${input}${output}</details>`
}

export function renderSessionHtml(meta: SessionHtmlMeta, entries: readonly SessionHtmlEntry[]): string {
  const blocks = entries.map(renderEntry).join('')
  const usage = meta.usage ? ` · ↑${meta.usage.inputTokens} ↓${meta.usage.outputTokens}` : ''
  const generated = meta.generatedAt ? `<div class="meta">导出于 ${escapeHtml(meta.generatedAt)}</div>` : ''
  const model = meta.modelId ? ` · ${escapeHtml(meta.modelId)}` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(
    meta.title,
  )}</title><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; margin: 32px auto; max-width: 900px; color: #1c1a16; background: #fbf8f1; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 11px; color: #8a8378; margin: 18px 0 4px; letter-spacing: .08em; text-transform: uppercase; }
  pre { font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; margin: 0; }
  section { border-top: 1px solid #e6e0d6; padding-top: 8px; }
  .meta { color: #8a8378; font-size: 12px; margin-bottom: 16px; }
  .tool { margin: 8px 0; border: 1px solid #e6e0d6; border-radius: 8px; padding: 8px 10px; background: #fffdf8; }
  .tool summary { cursor: pointer; font-size: 12px; color: #6f675b; }
  .tool .input { color: #8a8378; margin-top: 6px; }
  .tool .output { margin-top: 6px; border-top: 1px dashed #e6e0d6; padding-top: 6px; }
  .user pre { background: #f2ece2; padding: 10px 12px; border-radius: 8px; }
  .error pre { color: #b03a2e; }
</style></head><body><h1>${escapeHtml(meta.title)}</h1><div class="meta">${escapeHtml(meta.sessionId)}${model}${usage}</div>${generated}${blocks}</body></html>`
}
