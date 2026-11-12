// @x-code-cli/cli — `xc watch`：文件变化触发一次非交互 agent 运行
//
// 用轮询快照而不是 fs.watch：递归监听在 Linux 上不可用，跨平台行为也不一致；
// 轮询用 mtime+size 比较，语义稳定，缺点是间隔内新建又删除的文件看不到。
// 触发后复用 `runPrintMode`，因此权限、会话、成本统计与 `xc -p` 完全一致。
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { runPrintMode } from './print.js'

/** 递归扫描时跳过的目录名。既避免噪声，也避免扫描 `.x-code/sessions` 时
 *  被自己刚写入的会话文件反复触发。 */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.x-code',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
])

const MAX_FILES = 20_000
const DEFAULT_DEBOUNCE_MS = 800
const DEFAULT_INTERVAL_MS = 1_000

export interface WatchOptions {
  paths: string[]
  prompt: string
  debounceMs: number
  intervalMs: number
  trust: boolean
}

export type ParseWatchResult = WatchOptions | { help: true } | { error: string }

const USAGE = 'Usage: xc watch [paths...] --on-change "<prompt>" [--debounce <ms>] [--interval <ms>] [--trust]'

export function watchUsage(): string {
  return USAGE
}

function parseNumber(raw: string | undefined, name: string, min: number, max: number): number | string {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    return `${name} must be a number between ${min} and ${max}`
  }
  return Math.round(value)
}

export function parseWatchArgs(args: string[]): ParseWatchResult {
  const paths: string[] = []
  let prompt = ''
  let debounceMs = DEFAULT_DEBOUNCE_MS
  let intervalMs = DEFAULT_INTERVAL_MS
  let trust = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--trust' || arg === '-t') {
      trust = true
      continue
    }
    if (arg === '--on-change' || arg.startsWith('--on-change=')) {
      const value = arg.startsWith('--on-change=') ? arg.slice('--on-change='.length) : (args[++index] ?? '')
      if (!value.trim()) return { error: '`--on-change` requires a prompt' }
      prompt = value
      continue
    }
    if (arg === '--debounce' || arg.startsWith('--debounce=')) {
      const raw = arg.startsWith('--debounce=') ? arg.slice('--debounce='.length) : (args[++index] ?? '')
      const parsed = parseNumber(raw, '--debounce', 0, 10_000)
      if (typeof parsed === 'string') return { error: parsed }
      debounceMs = parsed
      continue
    }
    if (arg === '--interval' || arg.startsWith('--interval=')) {
      const raw = arg.startsWith('--interval=') ? arg.slice('--interval='.length) : (args[++index] ?? '')
      const parsed = parseNumber(raw, '--interval', 250, 60_000)
      if (typeof parsed === 'string') return { error: parsed }
      intervalMs = parsed
      continue
    }
    if (arg.startsWith('-')) return { error: `Unknown option: ${arg}` }
    paths.push(arg)
  }

  if (!prompt.trim()) return { error: '`--on-change` is required' }
  return { paths: paths.length > 0 ? paths : ['.'], prompt, debounceMs, intervalMs, trust }
}

export interface WatchSnapshot {
  files: Map<string, string>
  truncated: boolean
}

/** 收集文件快照。值用 `mtimeMs:size` 表示，避免读取内容。 */
export async function collectSnapshot(paths: readonly string[], cwd: string): Promise<WatchSnapshot> {
  const files = new Map<string, string>()
  let truncated = false

  const addFile = async (filePath: string): Promise<void> => {
    if (files.size >= MAX_FILES) {
      truncated = true
      return
    }
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return
      files.set(path.resolve(filePath), `${stat.mtimeMs}:${stat.size}`)
    } catch {
      // 扫描过程中消失的文件直接忽略，下一轮会作为删除出现。
    }
  }

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(target)
      } else if (entry.isFile()) {
        await addFile(target)
      }
    }
  }

  for (const input of paths) {
    const target = path.resolve(cwd, input)
    try {
      const stat = await fs.stat(target)
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(path.basename(target))) continue
        await walk(target)
      } else if (stat.isFile()) {
        await addFile(target)
      }
    } catch {
      continue
    }
  }

  return { files, truncated }
}

export interface WatchChanges {
  added: string[]
  modified: string[]
  deleted: string[]
}

export function diffSnapshots(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): WatchChanges {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const [file, signature] of next) {
    const before = previous.get(file)
    if (before === undefined) added.push(file)
    else if (before !== signature) modified.push(file)
  }
  for (const file of previous.keys()) {
    if (!next.has(file)) deleted.push(file)
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() }
}

export function hasChanges(changes: WatchChanges): boolean {
  return changes.added.length + changes.modified.length + changes.deleted.length > 0
}

export function formatWatchPrompt(prompt: string, changes: WatchChanges, cwd: string, truncated = false): string {
  const relative = (file: string): string => path.relative(cwd, file) || file
  const lines = [prompt, '', '[Watch] Files changed since the previous run:']
  if (changes.modified.length > 0) lines.push(`- modified: ${changes.modified.map(relative).join(', ')}`)
  if (changes.added.length > 0) lines.push(`- added: ${changes.added.map(relative).join(', ')}`)
  if (changes.deleted.length > 0) lines.push(`- deleted: ${changes.deleted.map(relative).join(', ')}`)
  if (truncated) lines.push(`- note: scan stopped at ${MAX_FILES} files; large directories may be incomplete`)
  return lines.join('\n')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface WatchModeDependencies {
  cwd: string
  paths: readonly string[]
  prompt: string
  debounceMs: number
  intervalMs: number
  model: LanguageModel
  options: AgentOptions
}

export async function runWatchMode(deps: WatchModeDependencies): Promise<number> {
  const { cwd, paths, prompt, debounceMs, intervalMs, model, options } = deps
  let baseline = await collectSnapshot(paths, cwd)
  process.stdout.write(`[watch] watching ${paths.join(', ')}; ${baseline.files.size} files; Ctrl+C to stop.\n`)

  let stopped = false
  const onSignal = (): void => {
    stopped = true
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    while (!stopped) {
      await delay(intervalMs)
      if (stopped) break

      let next = await collectSnapshot(paths, cwd)
      let changes = diffSnapshots(baseline.files, next.files)
      if (!hasChanges(changes)) continue

      // 等文件稳定后再扫一次，避免编辑器“先删后写”触发两次运行。
      await delay(debounceMs)
      next = await collectSnapshot(paths, cwd)
      changes = diffSnapshots(baseline.files, next.files)
      if (!hasChanges(changes)) {
        baseline = next
        continue
      }

      // 先把基线推进到触发快照：运行期间的新改动会在下一轮被检测到。
      baseline = next
      const total = changes.added.length + changes.modified.length + changes.deleted.length
      process.stdout.write(`\n[watch] ${total} change(s); running…\n`)
      const code = await runPrintMode(model, options, formatWatchPrompt(prompt, changes, cwd, next.truncated))
      if (stopped) break
      if (code !== 0) process.stdout.write(`[watch] run exited ${code}; waiting for the next change.\n`)
    }
    return 0
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
