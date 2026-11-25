import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { TokenUsage } from '../types/index.js'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

export interface BackgroundTaskSnapshot {
  id: string
  toolCallId: string
  agentName: string
  description: string
  status: BackgroundTaskStatus
  startedAt: number
  endedAt?: number
  resultText?: string
  error?: string
  tokenUsage?: TokenUsage
  turnCount?: number
  toolCallCount?: number
  /** 子代理读入过外部内容；供父级在读取结果时传播 taint。 */
  externalContentTainted?: boolean
  externalContentSources?: string[]
  /** 写入该快照的窗口/运行时；多窗口共用一个文件时用于合并。 */
  ownerId?: string
  /** 落盘时 `resultText` 被截断过；读取方据此告知用户输出并不完整。 */
  resultTruncated?: boolean
}

/** 磁盘上一个 `resultText` 最多保留的字符数。内存里保留全文，只有快照落盘
 *  时截断——超出后必须打上 `resultTruncated`，否则读取方会当成完整结果。 */
const MAX_PERSISTED_RESULT_CHARS = 2000

/** 磁盘快照条数上限（本窗口内存列表与共享文件使用同一上限）。 */
const MAX_PERSISTED_TASKS = 200

/** 按码点截断，避免把代理对切成孤立码元（`JSON.stringify` 会替换成 U+FFFD）。 */
function truncateForPersist(text: string): { text: string; truncated: boolean } {
  // 快速路径：字符数没超限时码点数也不会超限。
  if (text.length <= MAX_PERSISTED_RESULT_CHARS) return { text, truncated: false }
  const codePoints = Array.from(text)
  if (codePoints.length <= MAX_PERSISTED_RESULT_CHARS) return { text, truncated: false }
  return { text: codePoints.slice(0, MAX_PERSISTED_RESULT_CHARS).join(''), truncated: true }
}

export interface BackgroundTaskStartInput {
  toolCallId: string
  agentName: string
  description: string
  parentSignal?: AbortSignal
}

export type BackgroundTaskEvent = { kind: 'start' | 'end'; task: BackgroundTaskSnapshot }

interface Entry {
  task: BackgroundTaskSnapshot
  controller: AbortController
  waiters: Set<(task: BackgroundTaskSnapshot) => void>
}

/** 跟踪后台子代理。注册表只保存状态和停止句柄；实际运行由 agent loop
 *  的 `runSubAgent` 完成，因此 CLI 不配置注册表时仍走原来的同步路径。 */
export class BackgroundTaskRegistry {
  private entries = new Map<string, Entry>()
  private seq = 0
  private readonly storePath: string | undefined
  private readonly ownerId: string

  constructor(options: { storePath?: string; ownerId?: string } = {}) {
    this.storePath = options.storePath
    this.ownerId = options.ownerId ?? 'default'
    this.restore()
  }

  /** 从磁盘恢复上次会话的快照；未完成的任务标记为 interrupted。 */
  private restore(): void {
    if (!this.storePath) return
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return
    // 与 persist 使用同一上限，否则磁盘上保留的记录在重启后会不断变少。
    for (const raw of parsed.slice(-MAX_PERSISTED_TASKS)) {
      if (!raw || typeof raw !== 'object') continue
      const task = raw as BackgroundTaskSnapshot
      if (typeof task.id !== 'string' || typeof task.startedAt !== 'number') continue
      // 别的窗口（ownerId 不同）的快照保留在磁盘上，但不进入本窗口的内存列表；
      // 共享视图负责跨窗口展示。
      if (task.ownerId !== undefined && task.ownerId !== this.ownerId) continue
      const restored: BackgroundTaskSnapshot =
        task.status === 'running'
          ? {
              ...task,
              status: 'interrupted',
              endedAt: Date.now(),
              error: task.error ?? 'Interrupted when the app exited',
            }
          : task
      restored.ownerId = this.ownerId
      this.entries.set(restored.id, { task: restored, controller: new AbortController(), waiters: new Set() })
      // id 形如 `bg-<base36 时间>-<seq>-<6 位十六进制>`：末段是随机后缀，约 6%
      // 的概率全为十进制数字。按“倒数第二段”取 seq，否则会把随机后缀
      // 当成计数器（最大 999999）导致 seq 异常跳变。
      const seqSegment = restored.id.split('-').slice(-2, -1)[0]
      const seqValue = Number(seqSegment)
      if (Number.isInteger(seqValue) && seqValue > 0) this.seq = Math.max(this.seq, seqValue)
    }
  }

  /** 读取其他窗口写入的共享快照。返回 null 表示“文件存在但读不出来”
   *  （被截断、半写、手工改坏）——与“文件不存在”是两回事：前者必须跳过本次
   *  持久化，否则本窗口会用不含其他窗口条目的内容把它们整体覆盖掉。 */
  private readStored(): BackgroundTaskSnapshot[] | null {
    if (!this.storePath) return []
    let raw: string
    try {
      raw = fs.readFileSync(this.storePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return null
    }
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as BackgroundTaskSnapshot[]) : null
    } catch {
      return null
    }
  }

  private persist(): void {
    if (!this.storePath) return
    try {
      // 先读回其他窗口的快照再合并，避免后写的窗口整体覆盖另一个窗口。
      const stored = this.readStored()
      // 共享文件读不出来时宁可不写：用只有本窗口条目的内容覆盖它，会把其他
      // 窗口的快照永久丢掉。
      if (stored === null) return
      const own = [...this.entries.values()].map((entry) => {
        if (!entry.task.resultText) return { ...entry.task }
        const { text, truncated } = truncateForPersist(entry.task.resultText)
        return { ...entry.task, resultText: text, ...(truncated ? { resultTruncated: true } : {}) }
      })
      const ownIds = new Set(own.map((task) => task.id))
      // 没有 ownerId 的记录来自旧版本写入——既不算 own 也不算 foreign 就会在
      // 下一次写入时被永久删除，因此按“不是本窗口的”保留下来。
      const foreign = stored.filter((task) => task.ownerId !== this.ownerId && !ownIds.has(task.id))
      const tasks = [...foreign, ...own].slice(-MAX_PERSISTED_TASKS)
      const dir = path.dirname(this.storePath)
      fs.mkdirSync(dir, { recursive: true })
      this.writeStore(`${JSON.stringify(tasks, null, 2)}\n`)
    } catch {
      // 持久化只是便利功能；写入失败不影响正在运行的任务。
    }
  }

  /** 原子写入：同目录临时文件 + rename。另一个窗口在此期间读到的要么是旧文件，
   *  要么是新文件，绝不会是半写的 JSON（那会让它对 readStored 返回 null 并跳过
   *  持久化）。Windows 上目标被短暂占用时 rename 可能返回 EPERM/EBUSY，
   *  该情况下退化为直接覆写，保持功能可用。 */
  private writeStore(payload: string): void {
    const target = this.storePath!
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, payload, { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(temp, target)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      fs.writeFileSync(target, payload, { encoding: 'utf-8', mode: 0o600 })
    }
    fs.chmodSync(target, 0o600)
  }

  start(input: BackgroundTaskStartInput): { task: BackgroundTaskSnapshot; signal: AbortSignal } {
    const controller = new AbortController()
    const id = `bg-${Date.now().toString(36)}-${++this.seq}-${randomUUID().slice(0, 6)}`
    const task: BackgroundTaskSnapshot = {
      id,
      toolCallId: input.toolCallId,
      agentName: input.agentName,
      description: input.description,
      status: 'running',
      startedAt: Date.now(),
      ownerId: this.ownerId,
    }
    this.entries.set(id, { task, controller, waiters: new Set() })
    // 立即落盘：否则进程被强杀时这条 running 记录根本不存在（restore 的
    // interrupted 语义只覆盖已落盘的任务），其他窗口也看不到运行中的任务。
    this.persist()
    const signal = input.parentSignal ? AbortSignal.any([input.parentSignal, controller.signal]) : controller.signal
    return { task: { ...task }, signal }
  }

  complete(
    id: string,
    patch: {
      status: Exclude<BackgroundTaskStatus, 'running'>
      resultText?: string
      error?: string
      tokenUsage?: TokenUsage
      turnCount?: number
      toolCallCount?: number
      externalContentTainted?: boolean
      externalContentSources?: string[]
    },
  ): BackgroundTaskSnapshot | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    // 终态幂等：`disposeAll()` 已把任务标成 interrupted 时，稍后才 settle 的
    // 子代理 promise 不得把它改回 completed（会反转磁盘上的 interrupted 记录）。
    if (entry.task.status !== 'running') return { ...entry.task }
    entry.task = {
      ...entry.task,
      status: patch.status,
      endedAt: Date.now(),
      resultText: patch.resultText,
      error: patch.error,
      tokenUsage: patch.tokenUsage,
      turnCount: patch.turnCount,
      toolCallCount: patch.toolCallCount,
      // taint 字段缺省时保留原值：catch 分支只传 {status, error}，若直接覆盖成
      // undefined，父级在 backgroundGet 读取时就不再传播外部内容污染。
      externalContentTainted: patch.externalContentTainted ?? entry.task.externalContentTainted,
      externalContentSources: patch.externalContentSources ?? entry.task.externalContentSources,
    }
    for (const resolve of entry.waiters) resolve({ ...entry.task })
    entry.waiters.clear()
    this.persist()
    return { ...entry.task }
  }

  get(id: string): BackgroundTaskSnapshot | null {
    const entry = this.entries.get(id)
    return entry ? { ...entry.task } : null
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.task })).sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 等待任务结束；超时或中止时返回当前快照，不抛错。 */
  waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundTaskSnapshot | null> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve(null)
    if (entry.task.status !== 'running') return Promise.resolve({ ...entry.task })
    // 已中止的 signal 不会再触发 abort 事件——不提前返回就会白等满 timeoutMs
    // （最长 300s），而调用方的会话早已被用户中断。
    if (signal?.aborted) return Promise.resolve({ ...entry.task })
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (task: BackgroundTaskSnapshot): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        entry.waiters.delete(finish)
        resolve(task)
      }
      const onAbort = (): void => finish({ ...entry.task })
      entry.waiters.add(finish)
      timer = setTimeout(() => finish({ ...entry.task }), Math.max(0, timeoutMs))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  abort(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.task.status !== 'running') return false
    entry.controller.abort()
    return true
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.task.status !== 'running') continue
      entry.controller.abort()
      entry.task = {
        ...entry.task,
        status: 'interrupted',
        endedAt: Date.now(),
        error: 'Interrupted when the app exited',
      }
    }
    // 退出路径用同步写，保证下次启动能看到 interrupted 状态。
    this.persist()
  }
}
