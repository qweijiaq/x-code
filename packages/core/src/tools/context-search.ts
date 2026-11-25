// @x-code-cli/core — 统一本地上下文检索
//
// 不是新的索引：把已有的记忆、文档库、会话 JSONL 和 ripgrep 结果聚合到一个
// 只读工具里，统一返回 source/title/snippet/引用信息。这样模型不必分别调用
// memorySearch、documentSearch、grep 再自己拼证据。
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import type { LoopState } from '../agent/loop-state.js'
import { listSessions } from '../agent/session-store.js'
import { searchCodeIndex } from '../code-index/index.js'
import { tokenizeMemoryText } from '../knowledge/memory/search-index.js'
import type { MemoryService } from '../knowledge/memory/service.js'
import { searchLibrary } from '../library/index.js'
import { errorMessage } from '../utils.js'
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

/** 调用方的工具调用上下文。透传下来让下游 ripgrep 子进程能随会话中断被取消，
 *  进度事件也挂到真实的 tool call 上。 */
export interface ContextSearchRuntime {
  toolCallId?: string
  abortSignal?: AbortSignal
}

/** 记忆检索一次最多暴露多少个不同 topic（跨轮复用同一个 Set）。 */
const MAX_EXPOSED_MEMORY_TOPICS = 5

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
): Promise<{ results: ContextSearchResult[]; notes: string[] }> {
  if (!service) return { results: [], notes: [] }
  // 被跳过时给一条可诊断的说明：返回空数组会让模型误判"记忆里没有相关内容"。
  if (!memoryQueryIsGrounded(query, latestUserText(state))) {
    return {
      results: [],
      notes: ['memory search skipped: the query is not grounded in the latest user message'],
    }
  }
  try {
    const results = await service.search(
      { query, maxResults: Math.min(limit, 5), semantic: true },
      { repositoryId: projectCwd },
    )
    const selected: ContextSearchResult[] = []
    for (const result of results) {
      // 语义是"最近已暴露过的 topic 不再重复"，而不是"暴露满 N 个之后永远
      // 闭嘴"：满了就淘汰最旧的记录，后续轮次的新话题仍然能被检索到。
      if (!exposedTopics.has(result.topicId) && exposedTopics.size >= MAX_EXPOSED_MEMORY_TOPICS) {
        const oldest = exposedTopics.values().next().value
        if (oldest !== undefined) exposedTopics.delete(oldest)
      }
      exposedTopics.add(result.topicId)
      selected.push({
        source: 'memory',
        title: `${result.topicId} · ${result.section}`,
        snippet: clip(result.snippet),
        score: result.score,
        path: result.path,
      })
    }
    return { results: selected, notes: [] }
  } catch (error) {
    return { results: [], notes: [`memory search failed: ${errorMessage(error)}`] }
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

async function searchCode(
  query: string,
  projectCwd: string,
  limit: number,
  runtime: ContextSearchRuntime,
): Promise<ContextSearchResult[]> {
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
    // 真实 tool call id + signal：伪造的 id 会让 grep 的进度事件挂到不存在的
    // tool call 上，缺 signal 则 ripgrep 子进程无法随会话中断被取消。
    {
      toolCallId: runtime.toolCallId ?? 'context-search',
      ...(runtime.abortSignal ? { abortSignal: runtime.abortSignal } : {}),
    },
  )
  if (!output || output.startsWith('Error') || output === 'No matches found.') return []
  const results: ContextSearchResult[] = []
  for (const line of output.split('\n')) {
    if (results.length >= limit) break
    // 首组用非贪婪：`path:42:  const t = "x:100:y"` 这类正文里再出现
    // `:<数字>:` 的匹配行，贪婪匹配会把路径和行号都解析错。
    const match = line.match(/^(.*?):(\d+):(.*)$/)
    if (!match) continue
    const filePath = match[1]
    const lineNumber = match[2]
    const text = match[3]
    if (!filePath || !lineNumber || text === undefined) continue
    results.push({
      source: 'code',
      // 与索引分支保持同一标题格式（文件名:行号）；完整路径走 path 字段。
      title: `${path.basename(filePath)}:${lineNumber}`,
      path: filePath,
      line: Number(lineNumber),
      snippet: clip(text),
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
  runtime: ContextSearchRuntime = {},
): Promise<{ query: string; results: ContextSearchResult[]; notes: string[] }> {
  const wanted = new Set(scopes ?? ['memory', 'docs', 'sessions', 'code'])
  const perSource = Math.min(limit ?? 6, 20)
  const [memory, docs, sessions, code] = await Promise.all([
    wanted.has('memory')
      ? searchMemory(options.memoryService, query, options.projectCwd, perSource, options.state, exposedMemoryTopics)
      : Promise.resolve({ results: [], notes: [] }),
    wanted.has('docs') ? searchDocs(query, perSource) : Promise.resolve([]),
    wanted.has('sessions') ? searchSessions(query, options.projectCwd, perSource) : Promise.resolve([]),
    wanted.has('code') ? searchCode(query, options.projectCwd, perSource, runtime) : Promise.resolve([]),
  ])
  const results = [...memory.results, ...docs, ...sessions, ...code]
  const notes = [...memory.notes]
  if (results.length === 0) {
    notes.push('No local context matched. Try a broader query or index the document library.')
  }
  return { query, results, notes }
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
    execute: async ({ query, scopes, limit }, toolOptions) =>
      collectContextResults(options, query, scopes, limit, exposedMemoryTopics, {
        toolCallId: toolOptions.toolCallId,
        ...(toolOptions.abortSignal ? { abortSignal: toolOptions.abortSignal } : {}),
      }),
  })
}
