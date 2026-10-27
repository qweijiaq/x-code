import type { TokenUsage } from '../types/index.js'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'aborted'

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
}

/** 跟踪后台子代理。注册表只保存状态和停止句柄；实际运行由 agent loop
 *  的 `runSubAgent` 完成，因此 CLI 不配置注册表时仍走原来的同步路径。 */
export class BackgroundTaskRegistry {
  private entries = new Map<string, Entry>()
  private seq = 0

  start(input: BackgroundTaskStartInput): { task: BackgroundTaskSnapshot; signal: AbortSignal } {
    const controller = new AbortController()
    const id = `bg-${Date.now().toString(36)}-${++this.seq}`
    const task: BackgroundTaskSnapshot = {
      id,
      toolCallId: input.toolCallId,
      agentName: input.agentName,
      description: input.description,
      status: 'running',
      startedAt: Date.now(),
    }
    this.entries.set(id, { task, controller })
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
    }
    return { ...entry.task }
  }

  get(id: string): BackgroundTaskSnapshot | null {
    const entry = this.entries.get(id)
    return entry ? { ...entry.task } : null
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.task })).sort((a, b) => a.startedAt - b.startedAt)
  }

  abort(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.task.status !== 'running') return false
    entry.controller.abort()
    return true
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.task.status === 'running') entry.controller.abort()
    }
    this.entries.clear()
  }
}
