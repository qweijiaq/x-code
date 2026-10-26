import type { ModelMessage } from 'ai'

import { classifyApiError } from './api-errors.js'

const INITIAL_STREAM_RETRY_DELAY_MS = 1000
const MAX_STREAM_RETRY_DELAY_MS = 30_000
const STREAM_WATCHDOG_POLL_MS = 1000

export type StreamRetryReason = 'network' | 'idle-timeout'

export interface StreamAttemptControl {
  signal: AbortSignal | undefined
  touch: () => void
  dispose: () => void
  didIdleTimeout: () => boolean
}

/** 单个提供方流的活动看门狗。基于墙钟的活动跟踪能在系统恢复后抓住超期的流，
 *  而不把较短的事件循环卡顿误判为断连。 */
export function createStreamAttemptControl(
  externalSignal: AbortSignal | undefined,
  idleTimeoutMs: number,
): StreamAttemptControl {
  if (idleTimeoutMs <= 0) {
    return {
      signal: externalSignal,
      touch: () => {},
      dispose: () => {},
      didIdleTimeout: () => false,
    }
  }

  const idleController = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, idleController.signal]) : idleController.signal
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleTimedOut = false
  let lastActivityAt = Date.now()

  const poll = () => {
    if (signal.aborted) return
    const now = Date.now()
    const idle = now - lastActivityAt >= idleTimeoutMs
    if (idle) {
      idleTimedOut = true
      idleController.abort(new Error(`Streaming response timed out after ${idleTimeoutMs}ms without data`))
      return
    }
    timer = setTimeout(poll, Math.min(STREAM_WATCHDOG_POLL_MS, idleTimeoutMs))
  }

  timer = setTimeout(poll, Math.min(STREAM_WATCHDOG_POLL_MS, idleTimeoutMs))
  return {
    signal,
    touch: () => {
      lastActivityAt = Date.now()
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    didIdleTimeout: () => idleTimedOut,
  }
}

export function streamRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(INITIAL_STREAM_RETRY_DELAY_MS * 2 ** exponent, MAX_STREAM_RETRY_DELAY_MS)
}

/** 等待重连退避，同时不让 Esc/Ctrl+C 一起等计时器。 */
export function waitForStreamRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (delayMs <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const timer = setTimeout(() => finish(true), delayMs)
    const onAbort = () => finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** AI SDK 已经会重试 429/5xx 之类的 HTTP 状态。外层重连循环有意只处理传输失败，
 *  这样被耗尽的速率限制不会成倍放大 SDK 的请求预算。 */
export function isRetryableStreamTransportError(error: unknown): boolean {
  const classified = classifyApiError(error)
  return classified.retryable && classified.message.startsWith('Network connection failed')
}

const RECOVERY_PROMPT =
  'The previous assistant response was interrupted by a network disconnect. Continue directly from the exact point where it stopped. Do not repeat any text already emitted, do not mention the interruption, and preserve the original task and formatting.'

/** 添加仅用于请求的恢复上下文。这些消息绝不会提交到 LoopState，
 *  因此中止另一次尝试也不会在规范会话里留下不成对的合成用户轮次。 */
export function appendStreamRecoveryContext(messages: ModelMessage[], visibleText: string): ModelMessage[] {
  if (!visibleText) return messages
  return [...messages, { role: 'assistant', content: visibleText }, { role: 'user', content: RECOVERY_PROMPT }]
}

/** 在持久化之前，把重连之前已显示过的文本并入成功响应。UI 只收到续写部分，
 *  而下一轮模型看到的是一个完整的 assistant 回答。 */
export function prependRecoveredText(messages: ModelMessage[], visibleText: string): void {
  if (!visibleText) return
  const assistant = messages.find((message) => message.role === 'assistant')
  if (!assistant) {
    messages.unshift({ role: 'assistant', content: visibleText })
    return
  }

  if (typeof assistant.content === 'string') {
    assistant.content = visibleText + assistant.content
    return
  }
  if (!Array.isArray(assistant.content)) return

  const content = assistant.content as Array<{ type: string; text?: string }>
  const textPart = content.find((part) => part.type === 'text' && typeof part.text === 'string')
  if (textPart) {
    textPart.text = visibleText + textPart.text
    return
  }

  const firstNonReasoning = content.findIndex((part) => part.type !== 'reasoning')
  content.splice(firstNonReasoning < 0 ? content.length : firstNonReasoning, 0, {
    type: 'text',
    text: visibleText,
  })
}

/** 提供方偶尔会忽略续写指令，重放完整前缀。只保留有歧义的开头字节：
 *  完全重放会被丢弃，而真正的续写一旦出现差异就立即放行。 */
export class StreamReplayFilter {
  private candidate = ''
  private decided = false
  private replaySuppressed = false

  constructor(
    private readonly replayPrefix: string,
    private readonly emit: (text: string) => void,
  ) {
    this.decided = replayPrefix.length === 0
  }

  push(text: string): void {
    if (!text) return
    if (this.decided) {
      this.emit(text)
      return
    }

    this.candidate += text
    if (this.replayPrefix.startsWith(this.candidate)) return

    if (this.candidate.startsWith(this.replayPrefix)) {
      const remainder = this.candidate.slice(this.replayPrefix.length)
      this.candidate = ''
      this.decided = true
      this.replaySuppressed = true
      if (remainder) this.emit(remainder)
      return
    }

    const candidate = this.candidate
    this.candidate = ''
    this.decided = true
    this.emit(candidate)
  }

  finish(): void {
    if (this.decided || !this.candidate) return
    const candidate = this.candidate
    this.candidate = ''
    this.decided = true
    if (candidate === this.replayPrefix) this.replaySuppressed = true
    else this.emit(candidate)
  }

  suppressedReplay(): boolean {
    return this.replaySuppressed
  }
}
