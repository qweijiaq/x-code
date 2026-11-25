// @x-code-cli/core — TypeScript language service client
//
// A deliberately small tsserver client for semantic code navigation. It is not
// a general LSP transport yet: it resolves the workspace's own TypeScript
// installation and talks to `tsserver.js` over its line-delimited JSON
// protocol. That keeps the CLI/desktop package free of a bundled compiler while
// still giving the agent real definitions, references and diagnostics in
// TypeScript/JavaScript projects.
//
// Tools using this service are read-only. Rename returns the workspace edit as
// a preview; applying it is left to the normal edit/write approval path.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

export interface LspLocation {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  preview?: string
}

export interface LspDiagnostic extends LspLocation {
  severity: 'error' | 'warning' | 'info'
  code?: number
  message: string
}

export interface LspRenameEdit extends LspLocation {
  newText?: string
}

interface Position {
  line: number
  offset: number
}

interface FileSpan {
  file: string
  start?: Position
  end?: Position
  lineText?: string
  contextText?: string
}

interface TsResponse {
  type: 'response'
  request_seq: number
  success: boolean
  message?: string
  body?: unknown
}

interface TsEvent {
  type: 'event' | 'request'
  seq?: number
  command?: string
  event?: string
  body?: unknown
}

const REQUEST_TIMEOUT_MS = 15_000
const IDLE_DISPOSE_MS = 60_000
/** 行文本缓存最多保留多少个文件——缓存只是为了给预览省掉重复读盘，不该无限增长。 */
const MAX_CACHED_FILES = 32

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.line === 'number' && typeof item.offset === 'number'
}

function spans(value: unknown): FileSpan[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is FileSpan => {
    if (!item || typeof item !== 'object') return false
    return typeof (item as FileSpan).file === 'string'
  })
}

/** `rename` 的 `locs` 是**按文件分组**的 `FileSpanWithContext`（
 *  `{ file, locs: Span[] }`），与 `references` 的扁平 `FileSpan[]` 不同。
 *  扁平化后每段补上所属文件，否则所有编辑都会退化成 line 1 / offset 1，
 *  应用重命名时会改坏每个文件的第一行。 */
function renameSpans(value: unknown): FileSpan[] {
  if (!Array.isArray(value)) return []
  const out: FileSpan[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const file = entry.file
    if (typeof file !== 'string') continue
    const nested = entry.locs
    if (Array.isArray(nested)) {
      for (const part of nested) {
        if (!part || typeof part !== 'object') continue
        const span = part as Record<string, unknown>
        if (!isPosition(span.start)) continue
        out.push({
          file,
          start: span.start as Position,
          ...(isPosition(span.end) ? { end: span.end as Position } : {}),
          ...(typeof span.lineText === 'string' ? { lineText: span.lineText } : {}),
          ...(typeof span.contextText === 'string' ? { contextText: span.contextText } : {}),
        })
      }
      continue
    }
    if (isPosition(entry.start)) out.push(item as FileSpan)
  }
  return out
}

/** 丢掉 `toLocation` 判定为不可用的结果（缺少合法 `start` 的 span）。 */
function compactLocations(locations: ReadonlyArray<LspLocation | undefined>): LspLocation[] {
  return locations.filter((location): location is LspLocation => location !== undefined)
}

function diagnosticList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>).diagnostics
    if (Array.isArray(nested)) return nested
  }
  return []
}

/** Resolve the workspace's TypeScript compiler. `X_CODE_TSSERVER_PATH` is an
 * escape hatch for monorepos with a non-standard compiler location. */
export function resolveTsserverPath(root: string): string {
  const override = process.env.X_CODE_TSSERVER_PATH
  if (override) return override

  const candidates = [path.join(root, 'package.json'), path.join(process.cwd(), 'package.json')]
  for (const candidate of candidates) {
    try {
      return createRequire(candidate).resolve('typescript/lib/tsserver.js')
    } catch {
      // Try the next anchor. A workspace without TypeScript gets the clear
      // error below rather than a half-working server.
    }
  }
  throw new Error(
    'TypeScript language service is unavailable: install `typescript` in this workspace ' +
      '(`npm install -D typescript`) or set X_CODE_TSSERVER_PATH to its lib/tsserver.js.',
  )
}

export class TypeScriptService {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly opened = new Map<string, string>()
  private readonly lineCache = new Map<string, string[]>()
  private buffer = ''
  private seq = 0
  private disposed = false
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    readonly root: string,
    tsserverPath = resolveTsserverPath(root),
  ) {
    this.child = spawn(
      process.execPath,
      [
        tsserverPath,
        '--useInferredProjectPerProjectRoot',
        '--disableAutomaticTypingAcquisition',
        '--logVerbosity',
        'off',
      ],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        // tsserver 是 Node 脚本；桌面 runtime 的 execPath 是 Electron。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      },
    )
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => undefined)
    // 流级错误（tsserver 已退出时的 EPIPE / ECONNRESET）只在 stream 上 emit，
    // `child.on('error')` 收不到。没有监听器时 Node 会把它抛成未捕获异常，直接把
    // CLI 打挂——`write()` 里的 `destroyed` 检查是 check-and-use，替不了它。
    this.child.stdin.on('error', (error) => this.failAll(error instanceof Error ? error : new Error(String(error))))
    this.child.on('error', (error) => this.failAll(error))
    this.child.on('exit', (code, signal) => {
      if (!this.disposed)
        this.failAll(new Error(`tsserver exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`))
    })
    this.touch()
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.dispose()
    }, IDLE_DISPOSE_MS)
    this.idleTimer.unref?.()
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: TsResponse | TsEvent
      try {
        message = JSON.parse(line) as TsResponse | TsEvent
      } catch {
        continue
      }
      this.handle(message)
    }
  }

  private handle(message: TsResponse | TsEvent): void {
    if (message.type === 'response') {
      const entry = this.pending.get(message.request_seq)
      if (!entry) return
      this.pending.delete(message.request_seq)
      clearTimeout(entry.timer)
      if (message.success) entry.resolve(message.body)
      else entry.reject(new Error(message.message || 'tsserver request failed'))
      return
    }
    if (message.type === 'request' && typeof message.seq === 'number') {
      // tsserver occasionally asks the client for project/configuration data.
      // An empty successful response keeps it from waiting forever.
      this.write({
        seq: ++this.seq,
        type: 'response',
        request_seq: message.seq,
        command: message.command ?? 'unknown',
        success: true,
        body: {},
      })
    }
  }

  private write(value: unknown): void {
    if (this.disposed || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private failAll(error: Error): void {
    for (const [seq, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(seq)
    }
  }

  private request<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('TypeScript service is closed'))
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    this.touch()
    const seq = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`tsserver request timed out: ${command}`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      const onAbort = (): void => {
        const entry = this.pending.get(seq)
        if (!entry) return
        this.pending.delete(seq)
        clearTimeout(entry.timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(seq, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      this.write({ seq, type: 'request', command, arguments: args })
    })
  }

  private async open(filePath: string): Promise<void> {
    const absolute = path.resolve(this.root, filePath)
    const content = await fs.readFile(absolute, 'utf8')
    const previous = this.opened.get(absolute)
    if (previous === content) return
    // 文件变了：预览行缓存必须一起失效，否则 tsserver 给出的是新位置、而
    // `preview`/`diagnostics` 的行文本还是编辑前的旧内容。
    this.lineCache.delete(absolute)
    if (previous === undefined) {
      await this.request('open', { file: absolute, fileContent: content, projectRootPath: this.root })
    } else {
      // Keep an already-open document in sync after the agent edits it.
      await this.request('updateOpen', {
        openFiles: [{ file: absolute, fileContent: content }],
        closedFiles: [],
      })
    }
    this.opened.set(absolute, content)
  }

  private async line(filePath: string, lineNumber: number): Promise<string | undefined> {
    // 归一化 key：同一个文件可能以不同写法出现（Windows 的大小写 / 分隔符差异），
    // 不归一化会为一份文件堆出多份缓存。
    const key = path.resolve(filePath)
    let lines = this.lineCache.get(key)
    if (!lines) {
      try {
        const text = await fs.readFile(key, 'utf8')
        lines = text.split(/\r?\n/)
        this.cacheLines(key, lines)
      } catch {
        return undefined
      }
    }
    return lines[Math.max(0, lineNumber - 1)]
  }

  private cacheLines(key: string, lines: string[]): void {
    // 重新插入到末尾，使 Map 的插入顺序近似 LRU。
    this.lineCache.delete(key)
    this.lineCache.set(key, lines)
    while (this.lineCache.size > MAX_CACHED_FILES) {
      const oldest = this.lineCache.keys().next()
      if (oldest.done) break
      this.lineCache.delete(oldest.value)
    }
  }

  /** 缺少 `start` 的 span 直接丢弃：伪造 `{ line: 1, offset: 1 }` 会给出一个
   *  看起来合法、实际指向文件开头的定位，`rename` 叠加后尤其危险。 */
  private async toLocation(span: FileSpan): Promise<LspLocation | undefined> {
    const start = span.start
    if (!isPosition(start)) return undefined
    const end = span.end
    const preview = span.lineText ?? (await this.line(span.file, start.line))
    return {
      file: span.file,
      line: start.line,
      column: start.offset,
      ...(end ? { endLine: end.line, endColumn: end.offset } : {}),
      ...(preview ? { preview: preview.trim().slice(0, 240) } : {}),
    }
  }

  async diagnostics(filePath: string, signal?: AbortSignal, limit = 120): Promise<LspDiagnostic[]> {
    const absolute = path.resolve(this.root, filePath)
    await this.open(absolute)
    const [syntactic, semantic] = await Promise.all([
      this.request<unknown>('syntacticDiagnosticsSync', { file: absolute }, signal),
      this.request<unknown>('semanticDiagnosticsSync', { file: absolute }, signal),
    ])
    const output: LspDiagnostic[] = []
    for (const raw of [...diagnosticList(syntactic), ...diagnosticList(semantic)]) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const start = item.start
      if (!isPosition(start)) continue
      const category = typeof item.category === 'string' ? item.category : 'message'
      const severity: LspDiagnostic['severity'] =
        category === 'error' ? 'error' : category === 'warning' ? 'warning' : 'info'
      const preview = await this.line(absolute, start.line)
      output.push({
        file: absolute,
        line: start.line,
        column: start.offset,
        severity,
        ...(typeof item.code === 'number' ? { code: item.code } : {}),
        message: typeof item.text === 'string' ? item.text : 'Unknown diagnostic',
        ...(preview ? { preview: preview.trim().slice(0, 240) } : {}),
      })
      if (output.length >= limit) break
    }
    return output
  }

  async definition(
    filePath: string,
    line: number,
    column: number,
    signal?: AbortSignal,
    limit = 60,
  ): Promise<LspLocation[]> {
    const absolute = path.resolve(this.root, filePath)
    await this.open(absolute)
    const body = await this.request<unknown>('definition', { file: absolute, line, offset: column }, signal)
    return compactLocations(
      await Promise.all(
        spans(body)
          .slice(0, limit)
          .map((span) => this.toLocation(span)),
      ),
    )
  }

  async references(
    filePath: string,
    line: number,
    column: number,
    signal?: AbortSignal,
    includeDeclaration = true,
    limit = 120,
  ): Promise<LspLocation[]> {
    const absolute = path.resolve(this.root, filePath)
    await this.open(absolute)
    const body = await this.request<{ refs?: unknown } | null>(
      'references',
      { file: absolute, line, offset: column, includeDeclaration },
      signal,
    )
    return compactLocations(
      await Promise.all(
        spans(body?.refs)
          .slice(0, limit)
          .map((span) => this.toLocation(span)),
      ),
    )
  }

  async rename(
    filePath: string,
    line: number,
    column: number,
    newName: string,
    signal?: AbortSignal,
    limit = 200,
  ): Promise<LspRenameEdit[]> {
    const absolute = path.resolve(this.root, filePath)
    await this.open(absolute)
    const body = await this.request<{
      locs?: unknown
      info?: { canRename?: boolean; localizedErrorMessage?: string }
    } | null>('rename', { file: absolute, line, offset: column, findInComments: false, findInStrings: false }, signal)
    if (body?.info && body.info.canRename === false) {
      throw new Error(body.info.localizedErrorMessage || 'This symbol cannot be renamed')
    }
    const edits = await Promise.all(
      renameSpans(body?.locs)
        .slice(0, limit)
        .map(async (span) => {
          const location = await this.toLocation(span)
          return location ? { ...location, newText: newName } : undefined
        }),
    )
    return edits.filter((edit): edit is NonNullable<typeof edit> => edit !== undefined)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.failAll(new Error('TypeScript service was closed'))
    // 必须先把优雅关闭的 `exit` 请求发出去，再置 `disposed`——`write()` 在
    // `disposed` 为真时会直接 return，于是这里原来的顺序让这条请求永远不会发出，
    // tsserver 只能在 500ms 后被 kill() 强杀（来不及 flush 缓存/日志）。
    if (!this.child.stdin.destroyed) {
      try {
        this.child.stdin.write(
          `${JSON.stringify({ seq: ++this.seq, type: 'request', command: 'exit', arguments: {} })}\n`,
        )
      } catch {
        // stdin 已关闭：直接走下面的硬退出路径。
      }
    }
    this.disposed = true
    try {
      this.child.stdin.end()
    } catch {
      // Already closed.
    }
    const timer = setTimeout(() => {
      if (!this.child.killed) this.child.kill()
    }, 500)
    timer.unref?.()
  }
}

const services = new Map<string, TypeScriptService>()

/** Shared service for the normal tool path. The idle timer closes it after a
 * minute so a single lookup does not leave a tsserver process behind. */
export function getTypeScriptService(root: string): TypeScriptService {
  const normalized = path.resolve(root)
  const existing = services.get(normalized)
  if (existing && !existing.isDisposed) return existing
  const service = new TypeScriptService(normalized)
  services.set(normalized, service)
  return service
}

export function disposeTypeScriptServices(): void {
  for (const service of services.values()) service.dispose()
  services.clear()
}
