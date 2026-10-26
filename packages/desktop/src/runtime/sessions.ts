import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'

import { TOOL_SEARCH_TOOL_NAME, extractText, getContextWindow, listSessions, loadSession } from '@x-code-cli/core'
import type { LoadedSession, ModelMessage, TokenUsage } from '@x-code-cli/core'

import type {
  LoadedSessionView,
  SessionAttachmentView,
  SessionListItem,
  SessionMessage,
  SessionSearchResult,
  UsageView,
} from '../shared/protocol.js'

interface ContentPartLike {
  type?: string
  text?: string
  mediaType?: string
  filename?: string
  data?: unknown
  image?: unknown
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

const MAX_RESTORED_IMAGE_BASE64 = 8 * 1024 * 1024
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

function decodeMediaAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function decodeRefPath(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function basenameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function imageMimeFromPath(filePath: string): string | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXTENSION[extension]
}

function mediaTagPath(text: string): string | undefined {
  if (!text.trimStart().startsWith('<<')) return undefined
  const match = /\bpath="([^"]*)"/.exec(text)
  return match ? decodeMediaAttribute(match[1]!) : undefined
}

/** 桌面服务端以 `@"path"` 形式追加到提示中的附件路径。 */
function attachmentRefPaths(content: ModelMessage['content']): string[] {
  const parts = Array.isArray(content) ? (content as ContentPartLike[]) : []
  const paths = new Set<string>()
  for (const raw of parts) {
    if (raw?.type !== 'text' || typeof raw.text !== 'string') continue
    for (const match of raw.text.matchAll(/\s*@"((?:[^"\\]|\\.)*)"/g)) {
      if (match[1]) paths.add(decodeRefPath(match[1]))
    }
  }
  return [...paths]
}

function base64FromPart(part: ContentPartLike): string | undefined {
  const raw = part.type === 'image' ? part.image : part.data
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const nested = (raw as { data?: unknown }).data
    if (typeof nested === 'string') return nested
  }
  return undefined
}

/** 模型消息中人类可见的用户文本。媒体标签、提取的
 *  附件文本和仅模型可见的笔记被丢弃，而合并的排队
 *  提示及其分隔符被保留。 */
function displayUserText(content: ModelMessage['content'], attachmentPaths: Set<string>): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const kept: string[] = []
  for (const raw of content as ContentPartLike[]) {
    if (raw?.type !== 'text' || typeof raw.text !== 'string') continue
    const text = raw.text.trim()
    if (!text) continue
    if (text.startsWith('<plugin_context>')) continue
    if (/^<<(file|image|audio|pdf|video|document)\b/i.test(text)) continue
    if (text.startsWith('[Built-in local media processing succeeded.')) continue
    if (text.startsWith('[Image compressed to fit model limits:')) continue
    if (text.startsWith('[Note: the current model cannot natively see images.')) continue
    if (text.startsWith('[Image ') || text.startsWith('[Failed to attach image ')) continue
    const cleaned = raw.text.replace(/\s*@"((?:[^"\\]|\\.)*)"/g, (match, rawPath: string) =>
      attachmentPaths.has(decodeRefPath(rawPath)) ? '' : match,
    )
    if (cleaned.trim()) kept.push(cleaned)
  }
  return kept.join('')
}

function attachmentViewsFromContent(content: ModelMessage['content'], refPaths: string[]): SessionAttachmentView[] {
  if (!Array.isArray(content)) return []
  const views = new Map<string, SessionAttachmentView>()
  const keyFor = (view: SessionAttachmentView): string =>
    view.path ? `path:${view.path}` : `name:${view.name}:${view.mime ?? ''}`
  const add = (view: SessionAttachmentView): void => {
    const key = keyFor(view)
    const existing = views.get(key)
    views.set(key, {
      ...existing,
      ...view,
      ...(existing?.dataUrl && !view.dataUrl ? { dataUrl: existing.dataUrl } : {}),
    })
  }

  for (const filePath of refPaths) {
    if (!filePath) continue
    const mime = imageMimeFromPath(filePath)
    add({ name: basenameOf(filePath), path: filePath, ...(mime ? { mime } : {}) })
  }

  let pendingPath: string | undefined
  let attachmentIndex = 0
  for (const raw of content as ContentPartLike[]) {
    if (raw?.type === 'text' && typeof raw.text === 'string') {
      const tagged = mediaTagPath(raw.text)
      if (tagged) {
        pendingPath = tagged
        const mime = imageMimeFromPath(tagged)
        if (mime) add({ name: basenameOf(tagged), path: tagged, mime })
      }
      continue
    }
    if (raw?.type !== 'file' && raw?.type !== 'image') continue
    attachmentIndex++
    const mime = typeof raw.mediaType === 'string' ? raw.mediaType : undefined
    const filename = typeof raw.filename === 'string' && raw.filename.trim() ? raw.filename.trim() : ''
    const matchedRef = referencePathsForFilename(refPaths, filename)
    const filePath = pendingPath ?? matchedRef
    const name = filename || (filePath ? basenameOf(filePath) : '') || `attachment-${attachmentIndex}`
    pendingPath = undefined
    const data = base64FromPart(raw)
    // 优先使用磁盘上的附件：renderer 可以通过 app:image-preview
    // 懒加载它。把 base64 嵌入每个 session:load 会使图片密集的
    // 记录变大，并在 renderer 内存中保留副本。
    const canLoadFromDisk = Boolean(filePath && existsSync(filePath))
    const dataUrl =
      data && mime?.startsWith('image/') && !canLoadFromDisk && data.length <= MAX_RESTORED_IMAGE_BASE64
        ? `data:${mime};base64,${data}`
        : undefined
    add({
      name,
      ...(mime ? { mime } : {}),
      ...(filePath ? { path: filePath } : {}),
      ...(dataUrl ? { dataUrl } : {}),
    })
  }
  return [...views.values()]
}

function referencePathsForFilename(refPaths: string[], filename: string): string | undefined {
  if (!filename) return undefined
  return refPaths.find((filePath) => basenameOf(filePath) === filename)
}

function readToolOutput(part: ContentPartLike): { output: string; isError: boolean } {
  const out = part.output as { type?: string; value?: unknown } | string | undefined
  if (typeof out === 'string') return { output: out, isError: false }
  if (out && typeof out === 'object') {
    const isError = out.type === 'error-text' || out.type === 'error-json'
    const value = out.value
    if (typeof value === 'string') return { output: value, isError }
    if (value !== undefined) return { output: JSON.stringify(value), isError }
  }
  return { output: '', isError: false }
}

/** 移植 CLI 的 modelMessagesToDisplay，为桌面记录生成
 *  可序列化的视图消息。 */
export function toSessionMessages(messages: ModelMessage[]): SessionMessage[] {
  const toolResults = new Map<string, { output: string; isError: boolean }>()
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content as ContentPartLike[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        toolResults.set(part.toolCallId, readToolOutput(part))
      }
    }
  }

  const out: SessionMessage[] = []
  let counter = 0
  for (const message of messages) {
    counter++
    if (message.role === 'system' || message.role === 'tool') continue
    const id = `hydrated-${counter}`

    if (message.role === 'user') {
      const refPaths = attachmentRefPaths(message.content)
      const text = displayUserText(message.content, new Set(refPaths))
      const attachmentViews = attachmentViewsFromContent(message.content, refPaths)
      if (text || attachmentViews.length > 0) {
        out.push({
          id,
          role: 'user',
          text,
          ...(attachmentViews.length > 0 ? { attachmentViews } : {}),
        })
      }
      continue
    }

    const text = extractText(message.content)
    if (text) out.push({ id: `${id}-text`, role: 'assistant', text })

    if (!Array.isArray(message.content)) continue
    let toolIndex = 0
    for (const part of message.content as ContentPartLike[]) {
      if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
      if (part.toolName === TOOL_SEARCH_TOOL_NAME) continue
      toolIndex++
      const result = toolResults.get(part.toolCallId)
      out.push({
        id: `${id}-tool-${toolIndex}`,
        role: 'tool',
        text: '',
        toolName: part.toolName ?? 'unknown',
        toolInput: (part.input as Record<string, unknown>) ?? {},
        toolStatus: result ? (result.isError ? 'error' : 'completed') : 'pending',
        toolOutput: result?.output,
      })
    }
  }
  return out
}

export function usageView(usage: TokenUsage, modelId?: string): UsageView {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    currentContextTokens: usage.currentContextTokens,
    ...(modelId ? { contextWindow: getContextWindow(modelId) } : {}),
  }
}

export async function listSessionItems(workspace: string): Promise<SessionListItem[]> {
  const items = await listSessions(workspace)
  return items.map((item) => ({
    filePath: item.filePath,
    sessionId: item.sessionId,
    name: item.name,
    firstPrompt: item.firstPrompt,
    startedAt: item.startedAt,
    modelId: item.modelId,
    mtime: item.mtime,
  }))
}

export async function loadSessionView(
  filePath: string,
): Promise<{ loaded: LoadedSession; view: LoadedSessionView } | null> {
  const loaded = await loadSession(filePath)
  if (!loaded) return null
  return {
    loaded,
    view: {
      sessionId: loaded.sessionId,
      filePath: loaded.filePath,
      modelId: loaded.modelId,
      messages: toSessionMessages(loaded.messages),
      usage: usageView(loaded.tokenUsage, loaded.modelId),
    },
  }
}

/** 对工作区的会话记录做全文搜索。以有界并发异步读取文件，
 *  使大量历史记录不会阻塞运行时的请求循环；
 *  格式损坏/过大的记录会被跳过。 */
export async function searchSessionItems(workspace: string, query: string, limit = 20): Promise<SessionSearchResult[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  const items = (await listSessionItems(workspace)).slice(0, 200)
  const results: SessionSearchResult[] = []
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      const result = await searchOneSession(items[index], needle)
      if (result) results.push(result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()))
  return results
    .sort((left, right) => right.matchCount - left.matchCount || right.mtime - left.mtime)
    .slice(0, Math.max(1, Math.min(50, limit)))
}

async function searchOneSession(item: SessionListItem, needle: string): Promise<SessionSearchResult | null> {
  let content = ''
  try {
    const stat = await fs.stat(item.filePath)
    if (stat.size > 4_000_000) return null
    content = await fs.readFile(item.filePath, 'utf-8')
  } catch {
    return null
  }

  let matches = 0
  let snippet = ''
  for (const line of content.split('\n')) {
    if (!line.includes('"t":"msg"')) continue
    let parsed: { message?: { role?: string; content?: unknown } }
    try {
      parsed = JSON.parse(line) as { message?: { role?: string; content?: unknown } }
    } catch {
      continue
    }
    if (parsed.message?.role !== 'user' && parsed.message?.role !== 'assistant') continue
    const text = extractText(parsed.message.content as ModelMessage['content'])
    if (!text) continue
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    matches += 1
    if (!snippet) {
      snippet = text
        .slice(Math.max(0, at - 60), at + needle.length + 90)
        .replace(/\s+/g, ' ')
        .trim()
    }
  }
  return matches > 0 ? { ...item, snippet, matchCount: matches } : null
}
