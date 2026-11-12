// @x-code-cli/desktop — 代码索引自动增量
//
// macOS/Windows 使用递归 fs.watch；Linux 不支持 recursive，退化为低频率轮询
// （indexCode 自身是增量的，未改文件只 stat 后跳过）。监听只负责去抖和过滤，
// 真正的索引逻辑仍在 core。
import fs from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'

import { CODE_INDEX_SKIP_DIRS, isCodeIndexFile } from '@x-code-cli/core'

const DEBOUNCE_MS = 1_500
const LINUX_POLL_MS = 15_000

export function isWatchedCodePath(filePath: string | undefined): boolean {
  if (!filePath) return true
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  if (parts.some((part) => part.startsWith('.') || CODE_INDEX_SKIP_DIRS.has(part))) return false
  return isCodeIndexFile(filePath)
}

export interface CodeIndexWatcherOptions {
  root: string
  onIndex: () => Promise<void>
}

export class CodeIndexWatcher {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private running = false
  private disposed = false

  constructor(private readonly options: CodeIndexWatcherOptions) {}

  start(): void {
    this.stop()
    this.disposed = false
    if (process.platform === 'linux') {
      // Linux 的 fs.watch 不支持 recursive；轮询依赖 indexCode 的增量跳过。
      this.poller = setInterval(() => this.schedule(), LINUX_POLL_MS)
      return
    }
    try {
      this.watcher = fs.watch(this.options.root, { recursive: true }, (_event, filename) => {
        if (isWatchedCodePath(filename?.toString())) this.schedule()
      })
      this.watcher.on('error', () => undefined)
    } catch {
      this.watcher = null
    }
  }

  stop(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    this.watcher?.close()
    this.watcher = null
  }

  private schedule(): void {
    if (this.disposed || this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, DEBOUNCE_MS)
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running) return
    this.running = true
    try {
      await this.options.onIndex()
    } catch {
      // 自动索引失败不打断应用；下一次文件变更会重试。
    } finally {
      this.running = false
    }
  }
}

/** 仅用于测试/诊断：返回监听根路径（保证是绝对路径）。 */
export function watcherRoot(root: string): string {
  return path.resolve(root)
}
