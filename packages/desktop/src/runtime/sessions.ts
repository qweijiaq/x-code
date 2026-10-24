import fs from 'node:fs/promises'

import { TOOL_SEARCH_TOOL_NAME, extractText, getContextWindow, listSessions, loadSession } from '@x-code-cli/core'
import type { LoadedSession, ModelMessage, TokenUsage } from '@x-code-cli/core'

import type {
  LoadedSessionView,
  SessionListItem,
  SessionMessage,
  SessionSearchResult,
  UsageView,
} from '../shared/protocol.js'

interface ContentPartLike {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
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

/** Port of the CLI's modelMessagesToDisplay, producing serializable view
 *  messages for the desktop transcript. */
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
      const text = extractText(message.content)
      if (text) out.push({ id, role: 'user', text })
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

/** Full-text search across the workspace's session transcripts. Reads files
 *  asynchronously with bounded concurrency so a large history cannot block the
 *  runtime's request loop; malformed/oversized transcripts are skipped. */
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
