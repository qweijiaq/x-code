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

  private readStored(): BackgroundTaskSnapshot[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath!, 'utf-8'))
      return Array.isArray(parsed) ? (parsed as BackgroundTaskSnapshot[]) : []
    } catch {
      return []
    }
  }

  private persist(): void {
    if (!this.storePath) return
    try {
      // 先读回其他窗口的快照再合并，避免后写的窗口整体覆盖另一个窗口。
      const own = [...this.entries.values()].map((entry) => ({
        ...entry.task,
        ...(entry.task.resultText ? { resultText: entry.task.resultText.slice(0, 2000) } : {}),
      }))
      const ownIds = new Set(own.map((task) => task.id))
      const foreign = this.readStored().filter(
        (task) => task.ownerId !== undefined && task.ownerId !== this.ownerId && !ownIds.has(task.id),
      )
      const tasks = [...foreign, ...own].slice(-200)
      const dir = this.storePath.replace(/[\\/][^\\/]+$/, '')
      fs.mkdirSync(dir, { recursive: true })
      // 直接写目标文件：Windows 上 rename 覆盖已存在文件可能返回 EPERM。
      fs.writeFileSync(this.storePath, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
      fs.chmodSync(this.storePath, 0o600)
    } catch {
      // 持久化只是便利功能；写入失败不影响正在运行的任务。
    }
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
