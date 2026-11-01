// @x-code-cli/desktop — 会话导出
//
// 从 AgentHost 拆出的无状态导出：Markdown / JSON / PDF。只依赖 loadSessionView
// 和主进程的 PDF 渲染桥，不触碰 host 的字段。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { requestMain } from './main-bridge.js'
import { loadSessionView } from './sessions.js'

export async function exportSessionFile(
  filePath: string,
  format: 'markdown' | 'json' | 'pdf',
): Promise<{ path: string; size: number }> {
  const loaded = await loadSessionView(filePath)
  if (!loaded) throw new Error(`会话不存在：${filePath}`)
  const view = loaded.view
  const title = view.messages.find((message) => message.role === 'user')?.text.slice(0, 60) || view.sessionId
  const safeTitle =
    title
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = process.env.X_CODE_EXPORT_DIR?.trim() || path.join(os.homedir(), 'Downloads')
  await fs.promises.mkdir(dir, { recursive: true })

  if (format === 'json') {
    const target = path.join(dir, `x-code-${safeTitle}-${stamp}.json`)
    const data = JSON.stringify(
      {
        sessionId: view.sessionId,
        filePath: view.filePath,
        modelId: view.modelId,
        name: title,
        usage: view.usage,
        messages: view.messages,
      },
      null,
      2,
    )
    await fs.promises.writeFile(target, data, 'utf-8')
    return { path: target, size: Buffer.byteLength(data) }
  }

  if (format === 'markdown') {
    const lines: string[] = [
      `# ${title}`,
      '',
      `- 会话：${view.sessionId}`,
      `- 模型：${view.modelId}`,
      `- 用量：↑${view.usage.inputTokens} ↓${view.usage.outputTokens}`,
      '',
    ]
    for (const message of view.messages) {
      if (message.role === 'user') lines.push('## 你', '', message.text, '')
      else if (message.role === 'assistant') lines.push('## X-CODE', '', message.text, '')
      else if (message.role === 'system') lines.push(`> ${message.text}`, '')
      else if (message.role === 'tool' && message.toolOutput) {
        lines.push(`### 工具 · ${message.toolName ?? ''}`, '', '```', message.toolOutput.slice(0, 4000), '```', '')
      }
    }
    const target = path.join(dir, `x-code-${safeTitle}-${stamp}.md`)
    const content = lines.join('\n')
    await fs.promises.writeFile(target, content, 'utf-8')
    return { path: target, size: Buffer.byteLength(content) }
  }

  const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const blocks = view.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map(
      (message) =>
        `<section class="${message.role}"><h2>${message.role === 'user' ? '你' : 'X-CODE'}</h2><pre>${escapeHtml(message.text)}</pre></section>`,
    )
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; margin: 32px; color: #1c1a16; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 12px; color: #8a8378; margin: 18px 0 4px; }
  pre { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; }
  section { border-top: 1px solid #e6e0d6; padding-top: 8px; }
</style></head><body><h1>${escapeHtml(title)}</h1><div>${escapeHtml(view.sessionId)} · ${escapeHtml(view.modelId)}</div>${blocks}</body></html>`
  const rendered = await requestMain<{ data: string }>('app:render-pdf', { html, title })
  const target = path.join(dir, `x-code-${safeTitle}-${stamp}.pdf`)
  const pdf = Buffer.from(rendered.data, 'base64')
  await fs.promises.writeFile(target, pdf)
  return { path: target, size: pdf.length }
}
