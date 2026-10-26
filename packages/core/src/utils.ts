// @x-code-cli/core — 共享工具函数与常量
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 项目本地配置目录名 */
export const XCODE_DIR = '.x-code'

/** 用户作用域配置目录（~/.x-code）。在模块加载时冻结——需要应用 `X_CODE_HOME`
 *  覆盖时请使用 {@link userXcodeDir}。 */
export const USER_XCODE_DIR = path.join(os.homedir(), '.x-code')

/** 在调用时解析用户作用域配置根目录，遵循 `X_CODE_HOME`。在代码库各处的
 *  路径辅助函数中使用它，让单个环境变量即可把 `~/.x-code/` 下的所有内容
 *  重定向，用于沙箱测试或按用户隔离。回退到冻结的 {@link USER_XCODE_DIR}
 *  使常规情况无需分配。 */
export function userXcodeDir(): string {
  return process.env.X_CODE_HOME ?? USER_XCODE_DIR
}

// ── 调试日志（core + cli 共用）───────────────────────────────────────
// 用 `DEBUG_STDOUT=1` 开启。写入 ~/.x-code/logs/debug.log，这样全局安装的
// CLI 不会污染用户的项目树，而且无论从哪个 cwd 调用，所有记录都会落到一个
// 可 grep 的文件里。
//
// 同步 I/O 是有意为之：调用方都位于热路径（每个流分块、每次工具调用），
// 我们希望磁盘上的顺序与实时事件顺序一致。异步队列在背压下会打乱条目顺序。
//
// 性能：进程生命周期内只保持一个打开的文件描述符（writeSync 约 10μs），
// 而不是 appendFileSync（每次约 100μs——open + write + close）。轮转时关闭再
// 重开。该 fd 在退出时被继承并由内核关闭，因此无需显式清理。
//
// 有界的单行大小：否则读取大文件产生的单个 `stream.tool-result` 就能在一
// 条记录里吃掉几十 KB，几行就耗尽 1MB 预算的大部分。我们把每条记录硬性
// 限制在 MAX_LINE_BYTES，这样即使是很啰嗦的轮次也能提供约 250 行/MB 的
// 可 grep 上下文。
//
// 轮转：双文件方案（debug.log + debug.log.1）。当活动文件达到 MAX_LOG_BYTES
// 时，把它重命名为 .1 并重新开始，把磁盘总占用限制在约 2× MAX_LOG_BYTES。
// 这与 pip / Cargo / npm 在小规模下用于缓存日志的做法同构——足够简单，无需
// logrotate cron。
const DEBUG = process.env.DEBUG_STDOUT === '1'
/** 单文件大小上限。总磁盘占用 = 此值的 2 倍（活动 + 已轮转）。选择 10MB 使
 *  典型的多轮 agent 运行（约 85KB/轮 × 50–100 轮）完全落在活动文件内——
 *  常规调试时 grep/tail 无需跨轮转。合并后的 20MB 也足够小，可以原样附在
 *  缺陷报告里。 */
const MAX_LOG_BYTES = 10 * 1024 * 1024
/** 单条截断上限。约束最坏情况下的行大小——没有它，单个巨大的工具结果就能
 *  在几条记录内吃掉整个预算。1KB 让最坏情况保持在每文件约 5k 行（跨轮转约
 *  10k），同时仍为短堆栈跟踪和小型载荷留下完整空间。典型行小于 200 字节，
 *  因此实际每文件行数在数万级别。 */
const MAX_LINE_BYTES = 1024

const LOG_DIR = path.join(USER_XCODE_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'debug.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'debug.log.1')

/** 活动文件的内存字节计数器。避免每次热路径 debugLog 调用都 statSync——
 *  仅在初始化或轮转时才访问磁盘。 */
let currentLogBytes = -1
let logFd: number | null = null

function ensureLogReady(): void {
  if (logFd !== null) return
  fsSync.mkdirSync(LOG_DIR, { recursive: true })
  if (currentLogBytes < 0) {
    try {
      currentLogBytes = fsSync.statSync(LOG_FILE).size
    } catch {
      // 文件尚不存在——以 'a' 模式 open() 时会创建它。
      currentLogBytes = 0
    }
  }
  logFd = fsSync.openSync(LOG_FILE, 'a')
}

function rotateIfNeeded(nextWriteBytes: number): void {
  if (currentLogBytes + nextWriteBytes < MAX_LOG_BYTES) return
  try {
    if (logFd !== null) {
      fsSync.closeSync(logFd)
      logFd = null
    }
    // 在 POSIX 上 rename 会静默覆盖先前的 .1。在 Windows 上若目标存在
    // rename 会失败，因此先 unlink；.1 缺失没关系（没有先前的轮转）。
    try {
      fsSync.unlinkSync(LOG_FILE_OLD)
    } catch {
      /* 没有先前的轮转——没关系 */
    }
    fsSync.renameSync(LOG_FILE, LOG_FILE_OLD)
    // rename 成功——活动文件已消失，新的文件将由 ensureLogReady() 以字节
    // 计数 0 重新打开。
    currentLogBytes = 0
  } catch {
    // 轮转失败（Windows 上文件被锁、文件系统满、权限错误等）。活动文件仍以
    // 旧大小留在磁盘上——这里若把 `currentLogBytes = 0` 重置，会让内存计数器
    // 与实际脱节，下一次轮转要等到又追加了 ANOTHER MAX_LOG_BYTES 才会触发
    // （文件在我们重试前约达到上限的 2 倍）。使用 -1 哨兵让 ensureLogReady()
    // 重新 stat 文件并恢复准确计数。
    currentLogBytes = -1
  }
}

/** 把 `s` 截断到至多 `maxBytes` 个 UTF-8 字节，并追加一个标记说明丢弃了多少
 *  字节。廉价的 `length * 4` 上界为常见 ASCII 场景（大多数调试内容）提供
 *  短路，无需每行都付出 Buffer.byteLength 的代价。
 *
 *  切片按字节而非 JS 字符进行：`s.slice(0, n)` 会遍历 UTF-16 码元，因此对于
 *  CJK/emoji 内容会返回约 3-4 倍于预期字节预算的结果——混有中文/日文/emoji
 *  的调试行会经常溢出 MAX_LINE_BYTES。我们先编码一次、按字节切片、再重新
 *  解码（TextDecoder 会把从中途切断的码点尾部转成 U+FFFD，由截断标记吸收）。
 */
export function truncateForLog(s: string, maxBytes: number): string {
  if (s.length * 4 <= maxBytes) return s
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  const sliceLen = Math.max(0, maxBytes - 64)
  const truncated = new TextDecoder('utf-8').decode(buf.subarray(0, sliceLen))
  const droppedBytes = buf.length - sliceLen
  return `${truncated}…<+${droppedBytes}b truncated>`
}

/** 窄范围的可选开关：由 CLI 的 `--plugin-debug` 标志（或 `XC_PLUGIN_DEBUG=1`）
 *  设置后，debugLog 也会把带插件相关前缀标签的行镜像到 stderr，让用户可以
 *  实时观察插件/hook/市场活动，而不必忍受 `DEBUG_STDOUT=1` 的洪流。它保持为
 *  模块状态而非 debugLog 的参数，以免改动现有调用点。 */
let pluginDebugMirror = false
const PLUGIN_DEBUG_TAG_PREFIXES = ['plugins.', 'plugin.', 'hooks.', 'marketplace.']

export function setPluginDebugMirror(enabled: boolean): void {
  pluginDebugMirror = enabled
}

function isPluginRelatedTag(tag: string): boolean {
  for (const p of PLUGIN_DEBUG_TAG_PREFIXES) {
    if (tag.startsWith(p)) return true
  }
  return false
}

export function debugLog(tag: string, content: string): void {
  const mirrorToStderr = pluginDebugMirror && isPluginRelatedTag(tag)
  if (!DEBUG && !mirrorToStderr) return
  try {
    const safeContent = truncateForLog(content, MAX_LINE_BYTES)
    const ts = new Date().toISOString()
    // `JSON.stringify(content)` 会转义换行/制表符，让完整载荷落在日志的一行
    // 里——跨轮次 grep 更容易，多行文本差异也不会与相邻记录视觉上混在一起。
    const line = `[${ts}] ${tag} ${JSON.stringify(safeContent)}\n`
    if (DEBUG) {
      const bytes = Buffer.byteLength(line, 'utf8')
      rotateIfNeeded(bytes)
      ensureLogReady()
      if (logFd !== null) {
        fsSync.writeSync(logFd, line)
        currentLogBytes += bytes
      }
    }
    if (mirrorToStderr) {
      // 使用原始 fd 以避免 Node 的 stderr 流缓冲——我们希望每一行都立即出现，
      // 即使 agent 循环正忙。
      try {
        fsSync.writeSync(2, line)
      } catch {
        // stderr 写入失败不应导致 agent 崩溃
      }
    }
  } catch {
    // 尽力而为——绝不要因为无法记录日志就导致 agent 崩溃
  }
}

/** 检测来自 streamText / fetch / execa 的 AbortError。当信号已经被置位时也
 *  返回 true——有些提供商会把底层 AbortError 包装成自己的类，但仍会先置位
 *  信号。 */
export function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 从未知的抛出值中提取人类可读的消息。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** 检查路径是否为目录（出错时返回 false） */
export async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** 检查路径是否为普通文件（出错时返回 false） */
export async function isFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

/** 安全地读取文件，出错时返回空字符串 */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** 本地时间的 YYYYMMDD-HHMMSS-mmm 时间戳，适用于会话 ID、检查点 ID，以及
 *  按时间顺序排序的目录列表。 */
export function generateTimestampId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

/** 截断到至多 `maxBytes` 个 UTF-8 字节，且不切断任何码点。 */
export function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf-8')
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return result
}
