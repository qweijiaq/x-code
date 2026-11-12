// @x-code-cli/core — 统一本地上下文检索
//
// 不是新的索引：把已有的记忆、文档库、会话 JSONL 和 ripgrep 结果聚合到一个
// 只读工具里，统一返回 source/title/snippet/引用信息。这样模型不必分别调用
// memorySearch、documentSearch、grep 再自己拼证据。
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import type { LoopState } from '../agent/loop-state.js'
import { listSessions } from '../agent/session-store.js'
import { searchCodeIndex } from '../code-index/index.js'
import { tokenizeMemoryText } from '../knowledge/memory/search-index.js'
import type { MemoryService } from '../knowledge/memory/service.js'
import { searchLibrary } from '../library/index.js'
import { extractText } from '../utils/message-helpers.js'
import { grep } from './grep.js'

const MAX_SESSIONS_SCANNED = 40
const MAX_SESSION_BYTES = 8 * 1024 * 1024
const MAX_SESSION_SCAN_BYTES = 32 * 1024 * 1024
const SNIPPET_CHARS = 360

export type ContextSearchSource = 'memory' | 'docs' | 'sessions' | 'code'

export interface ContextSearchResult {
  source: ContextSearchSource
  title: string
  snippet: string
  score?: number
  path?: string
  page?: number
  sessionId?: string
  role?: string
  line?: number
}

export interface ContextSearchOptions {
  projectCwd: string
  state: LoopState
  memoryService?: MemoryService
}

function latestUserText(state: LoopState): string {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]
    if (message?.role === 'user') {
      const text = extractText(message.content)
      if (!text.startsWith('Output token limit hit.')) return text
    }
  }
  return ''
}

function memoryQueryIsGrounded(query: string, userText: string): boolean {
  const queryTokens = new Set(tokenizeMemoryText(query))
  if (queryTokens.size === 0) return false
  const allowed = new Set(tokenizeMemoryText(userText))
  return [...queryTokens].every((token) => allowed.has(token))
}

function clip(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function searchMemory(
  service: MemoryService | undefined,
  query: string,
  projectCwd: string,
  limit: number,
  state: LoopState,
  exposedTopics: Set<string>,
): Promise<ContextSearchResult[]> {
  if (!service) return []
  if (!memoryQueryIsGrounded(query, latestUserText(state))) return []
  try {
    const results = await service.search(
      { query, maxResults: Math.min(limit, 5), semantic: true },
      { repositoryId: projectCwd },
    )
    return results
      .filter((result) => {
        if (exposedTopics.has(result.topicId)) return true
        if (exposedTopics.size >= 5) return false
        exposedTopics.add(result.topicId)
        return true
      })
      .map((result) => ({
        source: 'memory' as const,
        title: `${result.topicId} · ${result.section}`,
        snippet: clip(result.snippet),
        score: result.score,
        path: result.path,
      }))
  } catch {
    return []
  }
}

async function searchDocs(query: string, limit: number): Promise<ContextSearchResult[]> {
  try {
    const { results } = await searchLibrary(query, { limit })
    return results.map((result) => ({
      source: 'docs' as const,
      title: result.fileName,
      snippet: clip(result.snippet),
      score: result.score,
      path: result.filePath,
      ...(result.page !== undefined ? { page: result.page } : {}),
    }))
  } catch {
    return []
  }
}

async function searchSessions(query: string, projectCwd: string, limit: number): Promise<ContextSearchResult[]> {
  const needle = query.toLowerCase()
  const sessions = await listSessions(projectCwd).catch(() => [])
  const results: ContextSearchResult[] = []
  let scannedBytes = 0
  for (const session of sessions.slice(0, MAX_SESSIONS_SCANNED)) {
    if (results.length >= limit) break
    const stat = await fs.stat(session.filePath).catch(() => null)
    if (!stat || stat.size > MAX_SESSION_BYTES) continue
    if (scannedBytes + stat.size > MAX_SESSION_SCAN_BYTES) break
    scannedBytes += stat.size
    const raw = await fs.readFile(session.filePath, 'utf8').catch(() => '')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let entry: { t?: string; message?: { role?: string; content?: unknown }; ts?: string }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (entry.t !== 'msg' || !entry.message?.content) continue
      const text = extractText(entry.message.content as Parameters<typeof extractText>[0])
      if (!text.toLowerCase().includes(needle)) continue
      results.push({
        source: 'sessions',
        title: session.name || session.firstPrompt.slice(0, 80) || session.sessionId,
        snippet: clip(text),
        sessionId: session.sessionId,
        ...(entry.message.role ? { role: entry.message.role } : {}),
      })
      break
    }
  }
  return results
}

async function searchCode(query: string, projectCwd: string, limit: number): Promise<ContextSearchResult[]> {
  try {
    const indexed = await searchCodeIndex(query, { limit, path: projectCwd, semantic: true })
    if (indexed.results.length > 0) {
      return indexed.results.map((result) => ({
        source: 'code' as const,
        title: `${result.fileName}:${result.startLine}`,
        path: result.filePath,
        line: result.startLine,
        snippet: clip(result.snippet),
        score: result.score,
      }))
    }
  } catch {
    // 索引不存在/损坏时回退到 ripgrep。
  }
  const execute = (
    grep as unknown as {
      execute?: (
        input: Record<string, unknown>,
        options: { toolCallId: string; abortSignal?: AbortSignal },
      ) => Promise<string>
    }
  ).execute
  if (!execute) return []
  const output = await execute(
    {
      pattern: escapeRegex(query),
      path: projectCwd,
      outputMode: 'content',
      caseInsensitive: true,
      headLimit: Math.max(20, limit * 4),
    },
    { toolCallId: 'context-search' },
  )
  if (!output || output.startsWith('Error') || output === 'No matches found.') return []
  const results: ContextSearchResult[] = []
  for (const line of output.split('\n')) {
    if (results.length >= limit) break
    const match = line.match(/^(.*):(\d+):(.*)$/)
    if (!match) continue
    results.push({
      source: 'code',
      title: match[1]!,
      path: match[1]!,
      line: Number(match[2]),
      snippet: clip(match[3]!),
    })
  }
  return results
}

export async function collectContextResults(
  options: ContextSearchOptions,
  query: string,
  scopes?: ContextSearchSource[],
  limit?: number,
  exposedMemoryTopics: Set<string> = new Set(),
): Promise<{ query: string; results: ContextSearchResult[]; notes: string[] }> {
  const wanted = new Set(scopes ?? ['memory', 'docs', 'sessions', 'code'])
  const perSource = Math.min(limit ?? 6, 20)
  const [memory, docs, sessions, code] = await Promise.all([
    wanted.has('memory')
      ? searchMemory(options.memoryService, query, options.projectCwd, perSource, options.state, exposedMemoryTopics)
      : Promise.resolve([]),
    wanted.has('docs') ? searchDocs(query, perSource) : Promise.resolve([]),
    wanted.has('sessions') ? searchSessions(query, options.projectCwd, perSource) : Promise.resolve([]),
    wanted.has('code') ? searchCode(query, options.projectCwd, perSource) : Promise.resolve([]),
  ])
  const results = [...memory, ...docs, ...sessions, ...code]
  return {
    query,
    results,
    notes: results.length === 0 ? ['No local context matched. Try a broader query or index the document library.'] : [],
  }
}

export function createContextSearchTool(options: ContextSearchOptions) {
  const exposedMemoryTopics = new Set<string>()
  return tool({
    description:
      'Search local context across long-term memory, the local document library, past session transcripts, and workspace code. Use when the user asks where something is, what was decided earlier, or wants evidence with citations. Read-only. Results include source/path/page/sessionId so you can cite them. Prefer this over calling memorySearch, documentSearch, and grep separately for the same question.',
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      scopes: z
        .array(z.enum(['memory', 'docs', 'sessions', 'code']))
        .max(4)
        .optional()
        .describe('Limit to specific sources (default: all)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results per source (default: 6)'),
    }),
    execute: async ({ query, scopes, limit }) =>
      collectContextResults(options, query, scopes, limit, exposedMemoryTopics),
  })
}
