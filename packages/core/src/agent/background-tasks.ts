import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

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
    for (const raw of parsed.slice(-100)) {
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
      const match = /-(\d+)$/.exec(restored.id)
      if (match) this.seq = Math.max(this.seq, Number(match[1]))
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
      const own = [...this.entries.values()].map((entry) => ({
        ...entry.task,
        ...(entry.task.resultText ? { resultText: entry.task.resultText.slice(0, 2000) } : {}),
      }))
      const ownIds = new Set(own.map((task) => task.id))
      const foreign = stored.filter(
        (task) => task.ownerId !== undefined && task.ownerId !== this.ownerId && !ownIds.has(task.id),
      )
      const tasks = [...foreign, ...own].slice(-200)
      const dir = this.storePath.replace(/[\\/][^\\/]+$/, '')
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
    entry.task = {
      ...entry.task,
      status: patch.status,
      endedAt: Date.now(),
      resultText: patch.resultText,
      error: patch.error,
      tokenUsage: patch.tokenUsage,
      turnCount: patch.turnCount,
      toolCallCount: patch.toolCallCount,
      externalContentTainted: patch.externalContentTainted,
      externalContentSources: patch.externalContentSources,
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
