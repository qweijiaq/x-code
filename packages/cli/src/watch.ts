// @x-code-cli/cli — `xc watch`：文件变化触发一次非交互 agent 运行
//
// 用轮询快照而不是 fs.watch：递归监听在 Linux 上不可用，跨平台行为也不一致；
// 轮询用 mtime+size 比较，语义稳定，缺点是间隔内新建又删除的文件看不到。
// 触发后复用 `runPrintMode`，因此权限、会话、成本统计与 `xc -p` 完全一致。
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { abortPrintMode } from './print-signals.js'
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
  let signalCount = 0
  /** 当前正在等待的定时器；信号到来时提前唤醒它，不必等满一整个间隔。 */
  let wake: (() => void) | null = null

  const onSignal = (): void => {
    signalCount += 1
    stopped = true
    wake?.()
    // 第一次 Ctrl+C 让当前轮自行中止（print 模式注册的 abort handler 会中断
    // agentLoop，收尾后循环看到 stopped 就退出）。但一轮运行可能持续数分钟，
    // 用户不该被锁在里面：第二次 Ctrl+C 直接退出。
    if (signalCount === 1) {
      abortPrintMode()
      return
    }
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  /** 可被信号打断的等待。 */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      // `finish` 只会被定时器或信号触发，那时 `timer` 已赋值。
      const finish = (): void => {
        clearTimeout(timer)
        if (wake === finish) wake = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      wake = finish
    })

  /** 把本轮运行期间出现、但还没进基线的改动折叠进基线。
   *
   *  修复的是「watch 自我触发」：agent 对工作区文件的编辑同样出现在快照里，
   *  若把它当成新的触发条件，「修复这些文件」这类迭代任务会形成
   *  运行 → 改文件 → 触发 → 运行 的正反馈，无需人工干预就持续烧 token。
   *  代价是运行期间用户自己的编辑也会被一并折叠——所以这里明确打印折叠了多少
   *  处改动，而不是静默丢弃。 */
  const foldRunEditsIntoBaseline = async (triggerSnapshot: WatchSnapshot): Promise<void> => {
    const afterRun = await collectSnapshot(paths, cwd)
    const folded = diffSnapshots(triggerSnapshot.files, afterRun.files)
    baseline = afterRun
    const foldedCount = folded.added.length + folded.modified.length + folded.deleted.length
    if (foldedCount > 0) {
      process.stdout.write(
        `[watch] ${foldedCount} change(s) appeared during the run and were folded into the baseline; ` +
          'agent edits do not re-trigger a run.\n',
      )
    }
  }

  try {
    while (!stopped) {
      await wait(intervalMs)
      if (stopped) break

      let next = await collectSnapshot(paths, cwd)
      let changes = diffSnapshots(baseline.files, next.files)
      if (!hasChanges(changes)) continue

      // 等文件稳定后再扫一次，避免编辑器“先删后写”触发两次运行。
      await wait(debounceMs)
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
      // 单轮运行失败不该结束整个 watch 会话：网络异常、工具抛错、序列化失败都会
      // 一路冒泡到 `main().catch` → `gracefulShutdown(1)`，用户必须手动重启（而单次
      // `xc -p` 失败只是退一次码）。这里把单轮异常打到 stderr 后继续监听。
      try {
        const code = await runPrintMode(model, options, formatWatchPrompt(prompt, changes, cwd, next.truncated))
        if (stopped) break
        if (code !== 0) process.stdout.write(`[watch] run exited ${code}; waiting for the next change.\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[watch] run failed: ${message}; waiting for the next change.\n`)
      }
      if (stopped) break
      // 失败路径同样要折叠：抛错前 agent 写过的文件一样会再次触发运行。
      await foldRunEditsIntoBaseline(next)
    }
    return 0
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
