// @x-code-cli/desktop — 会话导出
//
// 从 AgentHost 拆出的无状态导出：Markdown / JSON / HTML / PDF。HTML 渲染器来自
// core（与 CLI 共用）；这里只负责路径、格式选择和主进程 PDF 渲染桥。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderSessionHtml as renderSessionHtmlDocument } from '@x-code-cli/core'

import type { LoadedSessionView } from '../shared/protocol.js'
import { requestMain } from './main-bridge.js'
import { loadSessionView } from './sessions.js'

export function renderSessionHtml(view: LoadedSessionView, title: string): string {
  return renderSessionHtmlDocument(
    {
      title,
      sessionId: view.sessionId,
      modelId: view.modelId,
      usage: view.usage,
    },
    view.messages.map((message) => ({
      role: message.role,
      text: message.text,
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.toolInput ? { toolInput: message.toolInput } : {}),
      ...(message.toolOutput ? { toolOutput: message.toolOutput } : {}),
      ...(message.toolStatus ? { toolStatus: message.toolStatus } : {}),
    })),
  )
}

export async function exportSessionFile(
  filePath: string,
  format: 'markdown' | 'json' | 'html' | 'pdf',
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

  const html = renderSessionHtml(view, title)
  if (format === 'html') {
    const target = path.join(dir, `x-code-${safeTitle}-${stamp}.html`)
    await fs.promises.writeFile(target, html, 'utf-8')
    return { path: target, size: Buffer.byteLength(html) }
  }

  const rendered = await requestMain<{ data: string }>('app:render-pdf', { html, title })
  const target = path.join(dir, `x-code-${safeTitle}-${stamp}.pdf`)
  const pdf = Buffer.from(rendered.data, 'base64')
  await fs.promises.writeFile(target, pdf)
  return { path: target, size: pdf.length }
}
