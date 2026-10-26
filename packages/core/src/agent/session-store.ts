// @x-code-cli/core — 按会话的 JSONL 转录存储。
//
// 每个会话一个文件：`.x-code/sessions/<sessionId>.jsonl`。
// 文件只追加；我们记录会话的所有内容——文件头、每条 ModelMessage、
// 周期性的 token 用量快照、压缩边界、中止标记——都以每行一个 JSON 对象的形式存在。
//
// 为什么用 JSONL 而不是重写单个 JSON 文档：
//   - 崩溃安全。进程被杀死或磁盘写满错误，最多丢失正在写入的那一行；
//     它之前的所有内容都完好无损。
//   - 追加成本低。每一轮只追加几百字节；从不重写。
//   - 与 Claude Code 的 `~/.claude/<project>/<uuid>.jsonl` 完全一致，
//     包括 `compact_boundary` 语义（见下方 `loadSession`）。
//
// 本模块取代旧的按会话的 `<id>.usage.json` 和 `<id>.json`（LLM 摘要）文件
// ——两者现在都成了 jsonl 内部的 meta 条目。/usage 历史与 /resume 都从同一个文件读取。
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { resetMemoryRecallWindow } from '../knowledge/memory/recall-state.js'
import type { MemoryRecallAttachment, MemoryRecallTombstone } from '../knowledge/memory/types.js'
import { ensureProjectStorageDir } from '../project-storage.js'
import { BROWSER_VISUAL_CHECK_TOOL_NAME } from '../tools/browser-visual-check.js'
import type {
  ContextSecurityState,
  MessageProvenance,
  PermissionMode,
  TokenUsage,
  TrackedModelMessage,
} from '../types/index.js'
import { XCODE_DIR, generateTimestampId } from '../utils.js'
import { extractText } from '../utils/message-helpers.js'
import { scanCacheMisses } from './cache-stats.js'
import type { CacheMissSummary, ProviderTurnUsage } from './cache-stats.js'
import type { GoalInput, GoalState, GoalVerificationResult } from './goal/types.js'
import { createLoopState } from './loop-state.js'
import type { LoopState, StepStats } from './loop-state.js'
import {
  canonicalSecurityJson,
  canonicalTranscriptDigest,
  createTrackedMessage,
  deriveContextSecurity,
  effectiveExecutionAuthority,
  isValidContextSecurity,
  isValidProvenance,
} from './provenance.js'
import type { CheckpointEntry } from './snapshot.js'
import { setTrackedTranscript } from './tracked-messages.js'
import { cloneUsageBreakdown, createUsageBreakdown } from './usage.js'
import type { UsageBreakdown } from './usage.js'

const SESSIONS_SUBDIR = 'sessions'
const OMITTED_VISUAL_CHECK_IMAGE = '[browserVisualCheck screenshot omitted from session storage]'
const BINARY_TOOL_OUTPUT_TYPES = new Set(['file', 'file-data', 'image', 'image-data', 'media'])

function sessionsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, XCODE_DIR, SESSIONS_SUBDIR)
}

/** 构造会话在磁盘上的文件名。新会话只使用其时间戳形状的 id。恢复的会话固定
 *  `sessionFilePath`，这样升级后旧版 slug 前缀文件仍能就地继续追加。 */
export function getSessionFilePath(
  state: { sessionId: string; sessionFilePath?: string | null },
  cwd: string = process.cwd(),
): string {
  return state.sessionFilePath ?? path.join(sessionsDir(cwd), `${state.sessionId}.jsonl`)
}

// ── 写入 jsonl 的条目类型 ────────────────────────────────────────────────────

interface HeaderEntry {
  t: 'meta'
  kind: 'header'
  cwd: string
  gitBranch?: string
  modelId: string
  startedAt: string
  /** 截断到约 500 字符——足够让选择器显示可识别的预览，而无需从磁盘读取整条
   *  首条用户消息。 */
  firstPrompt: string
  taskSlug: string
  /** 可选的自定义显示名，目前仅由 `/fork <name>` 设置。 */
  name?: string
  sessionId: string
  firstPromptProvenance?: MessageProvenance
}

interface MsgEntry {
  t: 'msg'
  epochId?: string
  entryId?: string
  message: ModelMessage
  provenance?: MessageProvenance
  ts: string
}

interface TranscriptEpochStartEntry {
  t: 'meta'
  kind: 'transcript-epoch-start'
  epochId: string
  parentEpochId?: string
  mode: 'snapshot' | 'delta'
  ts: string
}

interface ContextSecurityBoundaryEntry {
  t: 'meta'
  kind: 'context-security-boundary'
  epochId: string
  state: ContextSecurityState
  resultEntryCount: number
  resultTranscriptDigest: string
  ts: string
}

interface TranscriptEpochCommitEntry {
  t: 'meta'
  kind: 'transcript-epoch-commit'
  epochId: string
  boundaryDigest: string
  ts: string
}

interface UsageEntry {
  t: 'meta'
  kind: 'usage'
  usage: TokenUsage
  /** 为了与引入用量归因之前写入的会话向后兼容而可选。这是一个累计快照。 */
  breakdown?: UsageBreakdown
  /** 仅主提供方请求才有。 */
  turn?: ProviderTurnUsage
  /** 累计诊断快照，这样尾部扫描无需读取每一轮。 */
  cacheMissSummary?: CacheMissSummary
  modelId: string
  ts: string
}

interface CompactBoundaryEntry {
  t: 'meta'
  kind: 'compact-boundary'
  /** 深度（LLM 摘要）压缩时存在；轻度压缩（循环护栏修剪）时省略。摘要文本还会
   *  嵌入到接下来被重新刷写的 msg 行中，所以这只是信息性的——供 `listSessions`
   *  在选择器中显示“已压缩”提示，而无需重读边界之后的消息。 */
  summary?: string
  memoryGeneration?: number
  ts: string
}

interface InterruptedEntry {
  t: 'meta'
  kind: 'interrupted'
  ts: string
}

interface ForkEntry {
  t: 'meta'
  kind: 'fork'
  parentSessionId: string
  messageCount: number
  ts: string
}

/** 回退检查点指针。由 `loadSession` 暴露，这样 /resume 能接续相同的 /rewind 历史。
 *  实际的文件备份单独存放在 `.x-code/file-history/<sessionId>/` 下。 */
interface CheckpointJsonlEntry {
  t: 'meta'
  kind: 'checkpoint'
  ckptId: string
  messageCount: number
  ts: string
  userPrompt: string
}

interface GoalEntry {
  t: 'meta'
  kind: 'goal'
  goal: GoalState | null
  ts: string
}

interface GoalInputEntry {
  t: 'meta'
  kind: 'goal-input'
  goalId: string
  input: GoalInput
  ts: string
}

interface GoalVerificationEntry {
  t: 'meta'
  kind: 'goal-verification'
  goalId: string
  result: GoalVerificationResult
  ts: string
}

interface StepStatsEntry {
  t: 'meta'
  kind: 'step-stats'
  step: StepStats
  ts: string
}

interface MemoryRecallEntry {
  t: 'meta'
  kind: 'memory-recall'
  attachment: MemoryRecallAttachment
  memoryGeneration?: number
  ts: string
}

interface MemoryRecallDeleteEntry {
  t: 'meta'
  kind: 'memory-recall-delete'
  tombstone: MemoryRecallTombstone
  ts: string
}

type Entry =
  | HeaderEntry
  | MsgEntry
  | UsageEntry
  | CompactBoundaryEntry
  | InterruptedEntry
  | ForkEntry
  | CheckpointJsonlEntry
  | GoalEntry
  | GoalInputEntry
  | GoalVerificationEntry
  | StepStatsEntry
  | MemoryRecallEntry
  | MemoryRecallDeleteEntry
  | TranscriptEpochStartEntry
  | ContextSecurityBoundaryEntry
  | TranscriptEpochCommitEntry

interface PersistedToolResultPart {
  type?: string
  toolName?: string
  output?: {
    type?: string
    value?: unknown
  }
}

/** 把实时截图保留在内存中供模型下一次请求使用，但绝不把它的 base64 负载
 *  拷贝进项目可恢复的 JSONL 转录里。 */
function persistenceSafeMessage(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return message
  let changed = false
  const content = (message.content as PersistedToolResultPart[]).map((part) => {
    if (
      part?.type !== 'tool-result' ||
      part.toolName !== BROWSER_VISUAL_CHECK_TOOL_NAME ||
      part.output?.type !== 'content' ||
      !Array.isArray(part.output.value)
    ) {
      return part
    }
    const retained = (part.output.value as Array<{ type?: string }>).filter(
      (entry) => !entry?.type || !BINARY_TOOL_OUTPUT_TYPES.has(entry.type),
    )
    if (retained.length === part.output.value.length) return part
    changed = true
    return {
      ...part,
      output: {
        ...part.output,
        value: [...retained, { type: 'text', text: OMITTED_VISUAL_CHECK_IMAGE }],
      },
    }
  })
  return changed ? ({ ...message, content } as ModelMessage) : message
}

// ── 追加辅助（发后即忘；绝不抛错）────────────────────────────────────────

async function appendLine(filePath: string, entry: Entry): Promise<void> {
  await appendRawLines(filePath, [JSON.stringify(entry)])
}

/** 同一会话的每次追加与原子快照共享这条操作链。因此快照重命名绝不会与之竞态，
 *  并丢弃一个已经确认的 usage、checkpoint、goal 或 memory 追加。 */
const fileOperations = new Map<string, Promise<void>>()
/** 本进程已经 chmod 过的文件——避免每次追加都做一次冗余的系统调用。 */
const chmodDone = new Set<string>()

function enqueueFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperations.get(filePath) ?? Promise.resolve()
  let resolveTail!: () => void
  const tail = new Promise<void>((resolve) => {
    resolveTail = resolve
  })
  fileOperations.set(filePath, tail)
  return previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      resolveTail()
      if (fileOperations.get(filePath) === tail) fileOperations.delete(filePath)
    })
}

async function appendRawLinesNow(filePath: string, lines: string[]): Promise<boolean> {
  try {
    await ensureProjectStorageDir(path.dirname(filePath))
    const handle = await fs.open(filePath, 'a', 0o600)
    try {
      await handle.writeFile(lines.join('\n') + '\n', 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!chmodDone.has(filePath)) {
      chmodDone.add(filePath)
      await fs.chmod(filePath, 0o600).catch(() => {})
    }
    return true
  } catch {
    return false
  }
}

function appendRawLines(filePath: string, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return Promise.resolve(true)
  return enqueueFileOperation(filePath, () => appendRawLinesNow(filePath, lines))
}

/** 尝试从 `.git/HEAD` 读取当前 git 分支。成本低，完全同步于调用方的 promise；
 *  不存在 / 分离 HEAD / 非 git 仓库都静默映射为 undefined。 */
async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const head = await readFile(path.join(cwd, '.git', 'HEAD'), 'utf-8')
    const m = head.match(/^ref: refs\/heads\/(.+)$/m)
    return m ? m[1].trim() : undefined
  } catch {
    return undefined
  }
}

function persistenceSafeTrackedMessage(entry: TrackedModelMessage): TrackedModelMessage {
  return {
    entryId: entry.entryId,
    message: persistenceSafeMessage(entry.message),
    provenance: structuredClone(entry.provenance),
  }
}

function epochLines(
  entries: readonly TrackedModelMessage[],
  mode: 'snapshot' | 'delta',
  resultingTranscript: readonly TrackedModelMessage[],
  parentEpochId?: string,
): { epochId: string; lines: string[] } {
  const epochId = randomUUID()
  const ts = new Date().toISOString()
  const start: TranscriptEpochStartEntry = {
    t: 'meta',
    kind: 'transcript-epoch-start',
    epochId,
    ...(parentEpochId ? { parentEpochId } : {}),
    mode,
    ts,
  }
  const projectedEntries = entries.map(persistenceSafeTrackedMessage)
  const projectedResult = resultingTranscript.map(persistenceSafeTrackedMessage)
  const boundary: ContextSecurityBoundaryEntry = {
    t: 'meta',
    kind: 'context-security-boundary',
    epochId,
    state: deriveContextSecurity(projectedResult),
    resultEntryCount: projectedResult.length,
    resultTranscriptDigest: canonicalTranscriptDigest(projectedResult),
    ts,
  }
  const commit: TranscriptEpochCommitEntry = {
    t: 'meta',
    kind: 'transcript-epoch-commit',
    epochId,
    boundaryDigest: createHash('sha256').update(canonicalSecurityJson(boundary)).digest('hex'),
    ts,
  }
  return {
    epochId,
    lines: [
      JSON.stringify(start),
      ...projectedEntries.map((entry) =>
        JSON.stringify({
          t: 'msg',
          epochId,
          entryId: entry.entryId,
          message: entry.message,
          provenance: entry.provenance,
          ts,
        } satisfies MsgEntry),
      ),
      JSON.stringify(boundary),
      JSON.stringify(commit),
    ],
  }
}

function isTranscriptLine(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as { t?: string; kind?: string }
  return (
    entry.t === 'msg' ||
    (entry.t === 'meta' &&
      ['compact-boundary', 'transcript-epoch-start', 'context-security-boundary', 'transcript-epoch-commit'].includes(
        entry.kind ?? '',
      ))
  )
}

async function retainedMetadataLines(
  filePath: string,
  options: {
    dropCheckpoints?: boolean
    checkpointMessageCountAtMost?: number
    dropMemoryRecall?: boolean
  } = {},
): Promise<string[]> {
  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const metadata = entry as { t?: string; kind?: string; messageCount?: number }
    if (metadata.t === 'meta' && metadata.kind === 'checkpoint') {
      if (options.dropCheckpoints) continue
      if (
        options.checkpointMessageCountAtMost !== undefined &&
        (typeof metadata.messageCount !== 'number' || metadata.messageCount > options.checkpointMessageCountAtMost)
      ) {
        continue
      }
    }
    if (
      options.dropMemoryRecall &&
      metadata.t === 'meta' &&
      (metadata.kind === 'memory-recall' || metadata.kind === 'memory-recall-delete')
    ) {
      continue
    }
    if (!isTranscriptLine(entry)) lines.push(JSON.stringify(entry))
  }
  return lines
}

/** 把负载写入一个全新的临时文件（0600，已 fsync），这样后续的 rename/link
 *  安装的就是完全持久化的内容。失败时清理临时文件。 */
async function writeTempSnapshot(tempPath: string, payload: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(payload, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

/** Windows 无法刷写目录句柄（fsync 返回 EPERM）。已安装的文件本身已刷写；
 *  在支持目录持久化屏障的平台上保留该屏障。 */
async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await fs.open(path.dirname(filePath), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function replaceWithSnapshot(filePath: string, lines: readonly string[]): Promise<void> {
  await ensureProjectStorageDir(path.dirname(filePath))
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeTempSnapshot(tempPath, lines.join('\n') + '\n')
    await fs.rename(tempPath, filePath)
    await syncParentDirectory(filePath)
    chmodDone.add(filePath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

const UNSUPPORTED_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])

function isUnsupportedHardLinkError(error: unknown): boolean {
  return UNSUPPORTED_HARD_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

async function writeSnapshotExclusively(filePath: string, payload: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  let created = false
  try {
    handle = await fs.open(filePath, 'wx', 0o600)
    created = true
    await handle.chmod(0o600)
    await handle.writeFile(payload, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => {})
    if (created) await fs.unlink(filePath).catch(() => {})
    throw error
  }
}

/** 安装一个全新的快照，绝不替换已有会话。硬链接在临时 inode 刷写后提供原子安装。
 *  部分文件系统不支持硬链接，因此回退路径用 `wx` 声明目标并保持同样的不覆盖保证。 */
async function createWithSnapshot(filePath: string, lines: readonly string[]): Promise<void> {
  await ensureProjectStorageDir(path.dirname(filePath))
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  const payload = lines.join('\n') + '\n'
  try {
    await writeTempSnapshot(tempPath, payload)
    try {
      await fs.link(tempPath, filePath)
    } catch (error) {
      if (!isUnsupportedHardLinkError(error)) throw error
      await writeSnapshotExclusively(filePath, payload)
    }
    await fs.unlink(tempPath)
    await syncParentDirectory(filePath)
    chmodDone.add(filePath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}

interface TranscriptSnapshotOptions {
  allowIntegrityRepair?: boolean
  dropCheckpoints?: boolean
  checkpointMessageCountAtMost?: number
  dropMemoryRecall?: boolean
}

export interface SessionForkOrigin {
  sessionId: string
  messageCount: number
  forkedAt: string
}

export interface ForkedSession {
  sessionId: string
  filePath: string
  messageCount: number
  name?: string
  forkedFrom: SessionForkOrigin
}

/** 用于在源会话继续运行的同时创建分支的、脱离的、某个时间点的状态。捕获期间
 *  克隆每个可变值，这样后续的工具轮次、压缩、goal 更新与记忆召回都无法移动
 *  分支边界。 */
export interface SessionForkSnapshot {
  sourceSessionId: string
  trackedMessages: TrackedModelMessage[]
  contextSecurity: ContextSecurityState
  sourceIntegrityValid: boolean
  taskSlug: string
  tokenUsageTotal: number
  goal: GoalState | null
  goalInputs: GoalInput[]
  memoryRecallAttachments: MemoryRecallAttachment[]
  memoryRecallTombstones: MemoryRecallTombstone[]
  memoryGeneration: number
}

function cloneTrackedTranscript(entries: readonly TrackedModelMessage[]): TrackedModelMessage[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    message: structuredClone(entry.message),
    provenance: structuredClone(entry.provenance),
  }))
}

function clonePersistenceSafeTranscript(entries: readonly TrackedModelMessage[]): TrackedModelMessage[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    message: structuredClone(persistenceSafeMessage(entry.message)),
    provenance: structuredClone(entry.provenance),
  }))
}

function enqueueTranscriptOperation(state: LoopState, operation: () => Promise<void>): Promise<void> {
  const previous = state.pendingFlush ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  state.pendingFlush = current
  void current.then(
    () => {
      if (state.pendingFlush === current) state.pendingFlush = null
    },
    () => {
      if (state.pendingFlush === current) state.pendingFlush = null
    },
  )
  return current
}

async function commitTranscriptSnapshotNow(
  state: LoopState,
  candidate: readonly TrackedModelMessage[],
  options: TranscriptSnapshotOptions,
  replaceInMemory: boolean,
): Promise<void> {
  try {
    if (state.transcriptIntegrity === 'failed' && !options.allowIntegrityRepair) {
      throw new Error('Transcript integrity failed; refusing a decontaminating snapshot')
    }
    const filePath = getSessionFilePath(state)
    const projected = candidate.map(persistenceSafeTrackedMessage)
    const epoch = epochLines(projected, 'snapshot', projected)
    await enqueueFileOperation(filePath, async () => {
      const metadata = await retainedMetadataLines(filePath, options)
      await replaceWithSnapshot(filePath, [...metadata, ...epoch.lines])
    })
    if (replaceInMemory) setTrackedTranscript(state, candidate)
    state.committedTranscriptEpochId = epoch.epochId
    state.transcriptIntegrity = 'clean'
    state.transcriptRequiresSnapshot = false
    state.persistedMessageCount = candidate.length
  } catch (error) {
    // rename 可能在目录 fsync 报错之前就已经替换了持久文件。此时内存中的父级
    // 不再适合做 delta；每次快照失败都迫使下一次操作从当前已追踪转录重写一个
    // 全新的根快照。
    state.transcriptRequiresSnapshot = true
    throw error
  }
}

/** 提交一个完整的根快照。只有在临时文件 fsync、原子 rename 与目录 fsync 全部
 *  成功后，实时转录才会改变。状态推导与 I/O 共享 LoopState 转录链，而不仅是
 *  每个文件的写队列。 */
export function commitTranscriptSnapshot(
  state: LoopState,
  candidate?: readonly TrackedModelMessage[],
  options: TranscriptSnapshotOptions = {},
): Promise<void> {
  const requestedCandidate = candidate === undefined ? undefined : cloneTrackedTranscript(candidate)
  return enqueueTranscriptOperation(state, async () => {
    const selected = requestedCandidate ?? cloneTrackedTranscript(state.trackedMessages)
    await commitTranscriptSnapshotNow(state, selected, options, requestedCandidate !== undefined)
  })
}

async function reserveForkTarget(
  cwd: string,
  sourceSessionId: string,
  excludedSessionIds: ReadonlySet<string>,
): Promise<{ sessionId: string; filePath: string; lockPath: string }> {
  const now = Date.now()
  await ensureProjectStorageDir(sessionsDir(cwd))
  for (let offset = 0; offset < 1_000; offset++) {
    const sessionId = generateTimestampId(new Date(now + offset))
    if (sessionId === sourceSessionId || excludedSessionIds.has(sessionId)) continue
    const filePath = path.join(sessionsDir(cwd), `${sessionId}.jsonl`)
    const lockPath = path.join(sessionsDir(cwd), `.${sessionId}.fork.lock`)
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.close()
      handle = undefined
      await fs.access(filePath)
    } catch (error) {
      await handle?.close().catch(() => {})
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      if (code === 'ENOENT') return { sessionId, filePath, lockPath }
      await fs.unlink(lockPath).catch(() => {})
      throw error
    }
    await fs.unlink(lockPath).catch(() => {})
  }
  throw new Error('Unable to allocate a unique fork session id')
}

/** 捕获属于某个会话边界的每一个持久值。此函数有意不做任何 I/O，并在返回前
 *  完成克隆，这样调用方可以在源继续运行的同时保留结果。 */
export function captureSessionForkSnapshot(
  source: LoopState,
  options: { messageCount?: number } = {},
): SessionForkSnapshot {
  const requestedCount = options.messageCount ?? source.trackedMessages.length
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 0 || requestedCount > source.trackedMessages.length) {
    throw new Error(`Invalid fork message count: ${requestedCount}`)
  }

  const selected = clonePersistenceSafeTranscript(
    sanitizeTrackedMessageTail(source.trackedMessages.slice(0, requestedCount)),
  )
  const completedGoalInputIds = new Set(source.goal?.attempts.map((attempt) => attempt.id) ?? [])
  const goalInputs = source.goalInputs.map((input) => {
    const cloned = structuredClone(input)
    if (cloned.goalId === source.goal?.id && cloned.promotedAt && !completedGoalInputIds.has(cloned.id)) {
      delete cloned.promotedAt
    }
    return cloned
  })
  return {
    sourceSessionId: source.sessionId,
    trackedMessages: selected,
    contextSecurity: deriveContextSecurity(selected),
    sourceIntegrityValid:
      source.transcriptIntegrity !== 'failed' &&
      source.contextSecurity.integrityFailure !== true &&
      isValidContextSecurity(source.contextSecurity, source.trackedMessages),
    taskSlug: source.taskSlug,
    tokenUsageTotal: source.tokenUsage.totalTokens,
    goal: source.goal ? structuredClone(source.goal) : null,
    goalInputs,
    memoryRecallAttachments: source.memoryRecallAttachments
      .filter((attachment) => attachment.anchorMessageIndex < selected.length)
      .map((attachment) => structuredClone(attachment)),
    memoryRecallTombstones: source.memoryRecallTombstones.map((tombstone) => structuredClone(tombstone)),
    memoryGeneration: source.memoryGeneration,
  }
}

/** 从先前捕获的某个时间点边界创建一个独立会话。回退副产物与累计用量刻意从零开始：
 *  它们描述的是分支本地的文件历史与提供方工作，而不是模型上下文。 */
export async function forkSession(
  snapshot: SessionForkSnapshot,
  modelId: string,
  options: { cwd?: string; name?: string } = {},
): Promise<ForkedSession> {
  if (!snapshot.sourceIntegrityValid) {
    throw new Error('Transcript integrity failed; repair or clear the unsafe context before forking')
  }
  if (!isValidContextSecurity(snapshot.contextSecurity, snapshot.trackedMessages)) {
    throw new Error('Stored context-security boundary does not match the captured transcript')
  }

  const selected = cloneTrackedTranscript(snapshot.trackedMessages)
  const forkedAt = new Date().toISOString()
  const firstUser = selected.find((entry) => entry.message.role === 'user')
  const firstPrompt = firstUser ? extractText(firstUser.message.content).slice(0, 500) : ''
  // 文件头必须连同 500 字符的 firstPrompt 一起，稳稳落在 listSessions 的 8KB 头部读取
  // 范围内，否则该会话会静默地从选择器和 `--resume <name>` 中消失。
  const name = options.name?.trim().slice(0, 200) || undefined

  const goal = snapshot.goal ? structuredClone(snapshot.goal) : null
  if (goal) {
    const usedGoalTokens = Math.max(0, snapshot.tokenUsageTotal - goal.baselineTokens)
    if (goal.tokenBudget !== undefined) {
      const remaining = goal.tokenBudget - usedGoalTokens
      if (remaining <= 0 && ['active', 'paused', 'blocked', 'max_turns'].includes(goal.status)) {
        goal.status = 'budget_limited'
      } else {
        goal.tokenBudget = Math.max(0, remaining)
        if (goal.status === 'active') goal.status = 'paused'
      }
    } else if (goal.status === 'active') {
      goal.status = 'paused'
    }
    goal.baselineTokens = 0
    goal.updatedAt = forkedAt
    if (snapshot.goal?.status === 'active') delete goal.pendingTransition
  }
  const goalInputs = goal
    ? snapshot.goalInputs.filter((input) => input.goalId === goal.id).map((input) => structuredClone(input))
    : []
  const memoryRecallAttachments = snapshot.memoryRecallAttachments.map((attachment) => structuredClone(attachment))
  const memoryRecallTombstones = snapshot.memoryRecallTombstones.map((tombstone) => structuredClone(tombstone))

  const cwd = options.cwd ?? process.cwd()
  const gitBranch = await readGitBranch(cwd)
  const attemptedSessionIds = new Set<string>()
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const target = await reserveForkTarget(cwd, snapshot.sourceSessionId, attemptedSessionIds)
    attemptedSessionIds.add(target.sessionId)
    try {
      const header: HeaderEntry = {
        t: 'meta',
        kind: 'header',
        cwd,
        gitBranch,
        modelId,
        startedAt: forkedAt,
        firstPrompt,
        taskSlug: snapshot.taskSlug,
        name,
        sessionId: target.sessionId,
        firstPromptProvenance: firstUser?.provenance,
      }
      const fork: ForkEntry = {
        t: 'meta',
        kind: 'fork',
        parentSessionId: snapshot.sourceSessionId,
        messageCount: selected.length,
        ts: forkedAt,
      }
      const metadata: Entry[] = [header, fork]
      if (goal) metadata.push({ t: 'meta', kind: 'goal', goal, ts: forkedAt })
      for (const input of goalInputs) {
        metadata.push({ t: 'meta', kind: 'goal-input', goalId: goal!.id, input, ts: forkedAt })
      }
      for (const attachment of memoryRecallAttachments) {
        metadata.push({
          t: 'meta',
          kind: 'memory-recall',
          attachment,
          memoryGeneration: snapshot.memoryGeneration,
          ts: forkedAt,
        })
      }
      for (const tombstone of memoryRecallTombstones) {
        metadata.push({ t: 'meta', kind: 'memory-recall-delete', tombstone, ts: forkedAt })
      }

      const epoch = epochLines(selected, 'snapshot', selected)
      await enqueueFileOperation(target.filePath, () =>
        createWithSnapshot(target.filePath, [...metadata.map((entry) => JSON.stringify(entry)), ...epoch.lines]),
      )
      return {
        sessionId: target.sessionId,
        filePath: target.filePath,
        messageCount: selected.length,
        name,
        forkedFrom: {
          sessionId: snapshot.sourceSessionId,
          messageCount: selected.length,
          forkedAt,
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await fs.unlink(target.lockPath).catch(() => {})
    }
  }
  throw new Error('Unable to allocate a unique fork session id')
}

async function appendHeaderNow(state: LoopState, modelId: string, firstPrompt: string, cwd: string): Promise<void> {
  const gitBranch = await readGitBranch(cwd)
  const makeEntry = (sessionId: string): HeaderEntry => ({
    t: 'meta',
    kind: 'header',
    cwd,
    gitBranch,
    modelId,
    startedAt: state.startedAt,
    firstPrompt: firstPrompt.slice(0, 500),
    taskSlug: state.taskSlug,
    sessionId,
    firstPromptProvenance: state.trackedMessages[0]?.provenance,
  })

  // 恢复的会话固定其确切文件路径。已存在的文件是原始文件头；缺失的会在同一路径重建。
  if (state.sessionFilePath) {
    try {
      await fs.access(state.sessionFilePath)
      return
    } catch {
      // 继续往下走，重建缺失的固定文件。
    }
    try {
      await createWithSnapshot(state.sessionFilePath, [JSON.stringify(makeEntry(state.sessionId))])
      // 旧转录链曾存在于已删除的文件里。保留它的 epoch 会让下一次刷写追加一个
      // 其父级已不存在的 delta。
      state.committedTranscriptEpochId = undefined
      state.persistedMessageCount = 0
      state.transcriptRequiresSnapshot = true
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
      throw new Error('Failed to persist session header', { cause: error })
    }
  }

  // 新会话独占其路径。如果另一进程创建了相同的毫秒 id，就把本状态移到下一个
  // 时间戳，而不是把那个无关文件当成可恢复会话。
  const initialSessionId = state.sessionId
  const now = Date.now()
  const attemptedSessionIds = new Set<string>()
  for (let offset = 0; offset < 1_000; offset++) {
    const sessionId = offset === 0 ? initialSessionId : generateTimestampId(new Date(now + offset))
    if (attemptedSessionIds.has(sessionId)) continue
    attemptedSessionIds.add(sessionId)
    const filePath = path.join(sessionsDir(cwd), `${sessionId}.jsonl`)
    try {
      await createWithSnapshot(filePath, [JSON.stringify(makeEntry(sessionId))])
      state.sessionId = sessionId
      state.sessionFilePath = filePath
      // 一个全新文件无法从另一个路径续接 epoch 链。
      state.committedTranscriptEpochId = undefined
      state.persistedMessageCount = 0
      state.transcriptRequiresSnapshot = true
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new Error('Failed to persist session header', { cause: error })
    }
  }
  throw new Error('Unable to allocate a unique session id')
}

/** 写入会话文件头。对已恢复与已启动的状态幂等；新会话在不覆盖另一进程的前提下
 *  独占其路径。转录链还会对同一状态上的重复调用做串行化。 */
export function appendHeader(
  state: LoopState,
  modelId: string,
  firstPrompt: string,
  cwd: string = process.cwd(),
): Promise<void> {
  return enqueueTranscriptOperation(state, () => appendHeaderNow(state, modelId, firstPrompt, cwd))
}

/** 把 `state.messages` 中越过 `state.persistedMessageCount` 的每条消息刷写到
 *  jsonl 文件。基于差量的设计使写入器与 agent loop 中直接改动 state.messages
 *  的众多位置（collectTurnResponse、processToolCalls、长度收尾 nudge 等）解耦
 *  ——我们通过在轮次边界做一次整体扫描把它们全部捕获。
 *
 *  深度 / 轻度压缩之后，内存中的数组会缩小。调用方必须改调用下方的
 *  `markBoundaryAndReflush`——那条路径会写一个 compact-boundary 标记，使加载器
 *  能正确地在加载时截断，然后再重新追加被裁掉的消息，让边界之后的 jsonl 内容
 *  与新内存状态一致。 */
export function flushPendingMessages(state: LoopState): Promise<void> {
  return enqueueTranscriptOperation(state, async () => {
    if (state.transcriptIntegrity === 'failed') {
      throw new Error('Transcript integrity failed; automatic permission remains disabled')
    }
    if (
      state.transcriptRequiresSnapshot ||
      state.transcriptIntegrity !== 'clean' ||
      !state.committedTranscriptEpochId
    ) {
      const selected = cloneTrackedTranscript(state.trackedMessages)
      await commitTranscriptSnapshotNow(state, selected, {}, false)
      return
    }
    if (state.persistedMessageCount >= state.trackedMessages.length) return
    const filePath = getSessionFilePath(state)
    const flushEnd = state.trackedMessages.length
    const resultingTranscript = state.trackedMessages.slice(0, flushEnd)
    const pending = resultingTranscript.slice(state.persistedMessageCount)
    if (pending.length === 0) return
    const epoch = epochLines(pending, 'delta', resultingTranscript, state.committedTranscriptEpochId)
    if (!(await appendRawLines(filePath, epoch.lines))) {
      // 追加模式在报告 I/O 失败之前，可能在磁盘上留下任意字节前缀。再试一次 delta
      // 会跨过那段未经验证的尾部串接，因此下一次操作必须用快照原子替换它。
      state.transcriptRequiresSnapshot = true
      throw new Error('Failed to commit transcript delta')
    }
    state.persistedMessageCount = flushEnd
    state.committedTranscriptEpochId = epoch.epochId
  })
}

/** 为当前轮次追加一个用量快照。在 `collectTurnResponse` 接受提供方的 `usage`
 *  对象后由 agent loop 调用。选择器只读最后一条 usage 行（尾部扫描）来显示
 *  每个会话的总量——无需更高效地保留旧快照。 */
export async function appendUsage(state: LoopState, modelId: string, turn?: ProviderTurnUsage): Promise<void> {
  const filePath = getSessionFilePath(state)
  // 完整加载会从已持久化的各轮重建单独估算值。这里只保留累计总量，避免在每个
  // 用量快照里复制整段轮次历史，同时为选择器保留廉价的尾部读取。
  const entry: UsageEntry = {
    t: 'meta',
    kind: 'usage',
    usage: { ...state.tokenUsage },
    breakdown: cloneUsageBreakdown(state.usageBreakdown),
    turn,
    cacheMissSummary: { ...state.cacheMissSummary, estimates: [] },
    modelId,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** 追加一个每步用量快照。每次用户提交完成后由 agentLoop 调用。跨会话累计
 *  ——loadSession 收集每个条目，以便在恢复时重建完整的步骤历史。 */
export async function appendStepStats(state: LoopState, step: StepStats): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: StepStatsEntry = {
    t: 'meta',
    kind: 'step-stats',
    step,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

/** 标记一次压缩事件，并重新刷写（刚刚缩小的）消息数组。此函数返回后，jsonl
 *  最后一条边界之后的内容与 `state.messages` 完全一致——`loadSession` 在恢复时
 *  重建相同的内存状态。
 *
 *  为什么我们重新追加，而不是依赖边界之前的消息：我们的 `compressMessages`
 *  会逐字保留一个 `recent N` 切片，但这些切片在边界之前就已经持久化了；
 *  加载器的“最后边界之后的所有内容优先”规则否则会把它们丢弃。在磁盘上复制
 *  大约 6 条消息成本很低，还能让加载逻辑保持简单。
 *
 *  轻度压缩（循环护栏修剪）以 `summary=undefined` 调用本函数——被裁掉的消息仍
 *  需要一条边界，这样加载器就不会把被丢弃的循环护栏对复活。 */
export async function markBoundaryAndReflush(
  state: LoopState,
  summary?: string,
  candidate: readonly TrackedModelMessage[] = state.trackedMessages,
): Promise<void> {
  void summary
  await commitTranscriptSnapshot(state, candidate, { dropCheckpoints: true, dropMemoryRecall: true })
  // 压缩会缩小/重写消息数组——此前每个 checkpoint 的 `messageCount` 现在都指向
  // 末尾之后。清空内存列表以对齐加载器的行为（它在恢复时会丢弃边界之前的
  // checkpoint 行）。
  state.checkpoints = []
  resetMemoryRecallWindow(state)
}

export async function clearPeerContext(state: LoopState): Promise<number> {
  if (state.transcriptIntegrity !== 'clean' || state.contextSecurity.integrityFailure) {
    throw new Error('Transcript integrity must be repaired before peer context can be cleared')
  }
  if (!isValidContextSecurity(state.contextSecurity, state.trackedMessages)) {
    throw new Error('Stored context-security boundary does not match the tracked transcript')
  }
  const derived = deriveContextSecurity(state.trackedMessages)
  const firstTaintedEntryId = derived.firstTaintedEntryId
  if (!derived.peerInfluenceActive || !firstTaintedEntryId) return 0
  const firstTaintedIndex = state.trackedMessages.findIndex((entry) => entry.entryId === firstTaintedEntryId)
  if (
    firstTaintedIndex < 0 ||
    state.trackedMessages.slice(0, firstTaintedIndex).some((entry) => entry.provenance.derivedFromPeer)
  ) {
    throw new Error('The first tainted transcript entry cannot be located safely')
  }
  const removed = state.trackedMessages.length - firstTaintedIndex
  const safePrefix = state.trackedMessages.slice(0, firstTaintedIndex)
  await commitTranscriptSnapshot(state, safePrefix, {
    checkpointMessageCountAtMost: safePrefix.length,
    dropMemoryRecall: true,
  })
  state.checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.messageCount <= safePrefix.length)
  resetMemoryRecallWindow(state)
  return removed
}

/** 追加一个回退检查点标记。与其他追加辅助一样是发后即忘。恢复时 `loadSession`
 *  把这些收集进 `LoadedSession.checkpoints`，这样选择器可以在 CLI 重启之间提供
 *  相同的回退点。“最后边界之后的所有内容优先”这一加载器规则会自然地丢弃那些
 *  `messageCount` 已被压缩作废的 checkpoint。 */
export async function appendCheckpoint(state: LoopState, entry: CheckpointEntry): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const jsonl: CheckpointJsonlEntry = {
    t: 'meta',
    kind: 'checkpoint',
    ckptId: entry.ckptId,
    messageCount: entry.messageCount,
    ts: entry.ts,
    userPrompt: entry.userPrompt,
  }
  await appendLine(filePath, jsonl)
}

/** 追加一个 `interrupted` 标记。纯粹是信息性的——加载器在状态重建时忽略它；
 *  选择器可以在轮次中途结束的会话旁显示“interrupted”，让用户知道恢复的是什么。 */
export async function appendInterrupted(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: InterruptedEntry = { t: 'meta', kind: 'interrupted', ts: new Date().toISOString() }
  await appendLine(filePath, entry)
}

export async function appendGoalState(state: LoopState): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalEntry = {
    t: 'meta',
    kind: 'goal',
    goal: state.goal ? structuredClone(state.goal) : null,
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendGoalInput(state: LoopState, input: GoalInput): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalInputEntry = {
    t: 'meta',
    kind: 'goal-input',
    goalId: input.goalId,
    input: structuredClone(input),
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendGoalVerification(
  state: LoopState,
  goalId: string,
  result: GoalVerificationResult,
): Promise<void> {
  if (!state.sessionId) return
  const filePath = getSessionFilePath(state)
  const entry: GoalVerificationEntry = {
    t: 'meta',
    kind: 'goal-verification',
    goalId,
    result: structuredClone(result),
    ts: new Date().toISOString(),
  }
  await appendLine(filePath, entry)
}

export async function appendMemoryRecall(state: LoopState, attachment: MemoryRecallAttachment): Promise<void> {
  if (!state.sessionId) return
  const entry: MemoryRecallEntry = {
    t: 'meta',
    kind: 'memory-recall',
    attachment: structuredClone(attachment),
    memoryGeneration: state.memoryGeneration,
    ts: new Date().toISOString(),
  }
  await appendLine(getSessionFilePath(state), entry)
}

export async function appendMemoryRecallDelete(state: LoopState, tombstone: MemoryRecallTombstone): Promise<void> {
  if (!state.sessionId) return
  const entry: MemoryRecallDeleteEntry = {
    t: 'meta',
    kind: 'memory-recall-delete',
    tombstone: structuredClone(tombstone),
    ts: new Date().toISOString(),
  }
  await appendLine(getSessionFilePath(state), entry)
}

// ── 读取路径：load + list ──────────────────────────────────────────────

export interface LoadedSession {
  sessionId: string
  taskSlug: string
  name?: string
  startedAt: string
  modelId: string
  cwd: string
  gitBranch?: string
  firstPrompt: string
  messages: ModelMessage[]
  trackedMessages: TrackedModelMessage[]
  contextSecurity: ContextSecurityState
  committedTranscriptEpochId?: string
  transcriptIntegrity: 'clean' | 'legacy' | 'failed'
  /** 已加载的内存转录与最后一次持久提交不同，或丢弃了一个不完整的尾部。第一次
   *   追加必须原子替换转录，而不是在过期/损坏的 epoch 链上续接。 */
  transcriptRequiresSnapshot: boolean
  tokenUsage: TokenUsage
  usageBreakdown?: UsageBreakdown
  providerTurns?: ProviderTurnUsage[]
  cacheMissSummary?: CacheMissSummary
  goal: GoalState | null
  goalInputs: GoalInput[]
  /** 存活过最后一条 compact-boundary 的回退检查点（如果有）。背后的文件清单
   *   存放在 `.x-code/file-history/<sid>/` 下。 */
  checkpoints: CheckpointEntry[]
  /** 跨会话累计的每步 token 用量快照。 */
  stepStats: StepStats[]
  memoryRecallAttachments: MemoryRecallAttachment[]
  memoryRecallTombstones: MemoryRecallTombstone[]
  memoryGeneration: number
  forkedFrom?: SessionForkOrigin
  /** jsonl 文件的路径，这样 agent loop 能在用户恢复时继续向同一文件追加。 */
  filePath: string
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  currentContextTokens: 0,
}

/** 遍历会话 jsonl 并重建 LoadedSession。
 *
 *  compact-boundary 语义（与 Claude Code 一致）：每次看到一条 `compact-boundary` 行，
 *  消息累加器就被清空。因此返回的 `messages` 只反映最后一条边界之后的内容——
 *  按构造，它等于压缩那一刻的内存状态（见 `markBoundaryAndReflush`）。
 *
 *  尾部的 tool_call / tool_result 孤儿会被裁掉（否则下一次 API 请求会拒绝
 *  这个消息数组）——精确规则见 `sanitizeMessageTail`。 */
export interface SalvagedSession {
  filePath: string
  sessionId: string
  messageCount: number
}

/** 对完整性链已损坏的转录做尽力恢复。读取每条可解析的消息，按 entry id 去重，
 *  丢弃孤儿工具尾部，并写出一个全新的干净会话。源文件绝不被修改。仅在用户明确
 *  的恢复操作之后调用。 */
export async function salvageSession(filePath: string): Promise<SalvagedSession> {
  if (!filePath.endsWith('.jsonl')) throw new Error('Not a session file')
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    throw new Error('Session file is unreadable')
  }

  let header: HeaderEntry | null = null
  const byEntryId = new Map<
    string,
    { entryId: string; message: ModelMessage; provenance?: MessageProvenance; order: number }
  >()
  let order = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (entry.t === 'meta' && entry.kind === 'header') {
      header = entry
      continue
    }
    if (entry.t !== 'msg' || !entry.entryId || !entry.message) continue
    const role = (entry.message as { role?: unknown }).role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') continue
    const message = persistenceSafeMessage(entry.message)
    const existing = byEntryId.get(entry.entryId)
    if (existing) {
      existing.message = message
      if (isValidProvenance(entry.provenance)) existing.provenance = entry.provenance
    } else {
      byEntryId.set(entry.entryId, {
        entryId: entry.entryId,
        message,
        provenance: isValidProvenance(entry.provenance) ? entry.provenance : undefined,
        order: order++,
      })
    }
  }
  if (!header) throw new Error('Session file has no readable header')
  if (typeof header.modelId !== 'string' || !header.modelId.trim()) {
    throw new Error('Session header is incomplete')
  }
  const cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : process.cwd()
  const headerSessionId = typeof header.sessionId === 'string' ? header.sessionId : 'unknown'
  const firstPrompt = typeof header.firstPrompt === 'string' ? header.firstPrompt : ''

  const tracked = [...byEntryId.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) =>
      createTrackedMessage(
        entry.message,
        entry.provenance ?? { authority: 'user', derivedFromPeer: false },
        createHash('sha256')
          .update(`${headerSessionId}\u0000salvage\u0000${entry.entryId}\u0000${canonicalSecurityJson(entry.message)}`)
          .digest('hex'),
      ),
    )
  const sanitized = sanitizeTrackedMessageTail(tracked)
  if (sanitized.length === 0) throw new Error('No recoverable messages were found')

  const state = createLoopState('default', { projectCwd: cwd })
  state.taskSlug = typeof header.taskSlug === 'string' ? header.taskSlug : ''
  state.startedAt = typeof header.startedAt === 'string' ? header.startedAt : new Date().toISOString()
  state.contextSecurity = { peerInfluenceActive: false }
  setTrackedTranscript(state, sanitized)
  state.executionAuthority = effectiveExecutionAuthority({ source: 'user', peerTainted: false }, state.contextSecurity)
  state.transcriptIntegrity = 'clean'
  state.transcriptRequiresSnapshot = true
  state.persistedMessageCount = 0
  state.committedTranscriptEpochId = undefined

  await appendHeader(state, header.modelId, firstPrompt, cwd)
  await flushPendingMessages(state)
  const rescuedPath = getSessionFilePath(state)
  const name = header.name?.trim()
    ? `恢复：${header.name.trim()}`.slice(0, 200)
    : `恢复：${firstPrompt.trim().slice(0, 60) || '会话'}`.slice(0, 200)
  await renameSession(rescuedPath, name).catch(() => undefined)
  return { filePath: rescuedPath, sessionId: state.sessionId, messageCount: sanitized.length }
}

export async function loadSession(filePath: string): Promise<LoadedSession | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  const rawLines = raw.split('\n').filter((line) => line.trim())
  const parsedLines = rawLines.map((line) => {
    try {
      return { ok: true as const, entry: JSON.parse(line) as Entry }
    } catch {
      return { ok: false as const }
    }
  })
  const hasEpoch = parsedLines.some(
    (line) =>
      line.ok &&
      line.entry.t === 'meta' &&
      ['transcript-epoch-start', 'context-security-boundary', 'transcript-epoch-commit'].includes(line.entry.kind),
  )
  const hasLegacyMessages = parsedLines.some(
    (line) => line.ok && line.entry.t === 'msg' && !(line.entry as MsgEntry).epochId,
  )

  let header: HeaderEntry | null = null
  let lastUsage: UsageEntry | null = null
  const providerTurns: ProviderTurnUsage[] = []
  let legacyMessages: ModelMessage[] = []
  let checkpoints: CheckpointEntry[] = []
  let goal: GoalState | null = null
  const goalInputs: GoalInput[] = []
  const stepStats: StepStats[] = []
  let memoryRecallAttachments: MemoryRecallAttachment[] = []
  let memoryRecallTombstones: MemoryRecallTombstone[] = []
  let memoryGeneration = 0
  let forkedFrom: SessionForkOrigin | undefined

  for (const parsed of parsedLines) {
    if (!parsed.ok) continue
    const entry = parsed.entry
    if (entry.t === 'meta') {
      if (entry.kind === 'header') {
        header = entry
      } else if (entry.kind === 'usage') {
        lastUsage = entry
        if (entry.turn) providerTurns.push(entry.turn)
      } else if (entry.kind === 'compact-boundary' && !hasEpoch) {
        legacyMessages = []
        // 锚定在压缩前消息计数上的 checkpoint 现在已无意义——数组在它们之下缩小了。
        // 随消息一起丢弃。
        checkpoints = []
        memoryRecallAttachments = []
        memoryRecallTombstones = []
        memoryGeneration = entry.memoryGeneration ?? 0
      } else if (entry.kind === 'checkpoint') {
        checkpoints.push({
          ckptId: entry.ckptId,
          messageCount: entry.messageCount,
          ts: entry.ts,
          userPrompt: entry.userPrompt,
        })
      } else if (entry.kind === 'goal') {
        goal = entry.goal
      } else if (entry.kind === 'goal-input') {
        const idx = goalInputs.findIndex((input) => input.id === entry.input.id)
        if (idx >= 0) goalInputs[idx] = entry.input
        else goalInputs.push(entry.input)
      } else if (entry.kind === 'goal-verification' && goal && goal.id === entry.goalId) {
        if (!goal.verificationResults.some((result) => result.ts === entry.result.ts)) {
          goal.verificationResults.push(entry.result)
        }
      } else if (entry.kind === 'step-stats') {
        stepStats.push(entry.step)
      } else if (entry.kind === 'memory-recall') {
        memoryRecallAttachments.push(entry.attachment)
        memoryGeneration = Math.max(memoryGeneration, entry.memoryGeneration ?? 0)
      } else if (entry.kind === 'memory-recall-delete') {
        memoryRecallTombstones.push(entry.tombstone)
        memoryGeneration = Math.max(memoryGeneration, entry.tombstone.generation)
      } else if (entry.kind === 'fork') {
        forkedFrom = {
          sessionId: entry.parentSessionId,
          messageCount: entry.messageCount,
          forkedAt: entry.ts,
        }
      }
      // 'interrupted' 只是信息性的——不影响状态
    } else if (entry.t === 'msg' && !hasEpoch) {
      // 也保护旧版本创建的恢复会话。这不重写它们只追加的文件，但会在恢复后把
      // 旧版截图挡在新提供方请求之外。
      legacyMessages.push(persistenceSafeMessage(entry.message))
    }
  }
  if (!header) return null

  let trackedMessages: TrackedModelMessage[] = []
  let committedTranscriptEpochId: string | undefined
  let transcriptIntegrity: 'clean' | 'legacy' | 'failed' = hasEpoch ? 'clean' : 'legacy'
  let transcriptPrefixNeedsReplacement = false

  if (!hasEpoch) {
    trackedMessages = legacyMessages.map((message, index) =>
      createTrackedMessage(
        message,
        { authority: 'user', derivedFromPeer: false },
        createHash('sha256')
          .update(`${header!.sessionId}\u0000${index}\u0000${canonicalSecurityJson(message)}`)
          .digest('hex'),
      ),
    )
  } else if (hasLegacyMessages) {
    transcriptIntegrity = 'failed'
  } else {
    interface PendingEpoch {
      start: TranscriptEpochStartEntry
      entries: TrackedModelMessage[]
      boundary?: ContextSecurityBoundaryEntry
    }
    let active: PendingEpoch | undefined
    let validTranscript: TrackedModelMessage[] = []
    let sawCommittedSnapshot = false
    const seenEntryIds = new Set<string>()

    for (let index = 0; index < parsedLines.length; index++) {
      const parsed = parsedLines[index]!
      if (!parsed.ok) {
        const laterTranscriptLine = parsedLines
          .slice(index + 1)
          .some((later) => later.ok && isTranscriptLine(later.entry))
        // 一行格式错误会终止连续的转录前缀。尾部的部分写入可从最后一次提交恢复，
        // 但绝不能在缺口之上接受更晚的 epoch：它的父级关系以及被错误行掩盖的字节
        // 无法被认证。
        transcriptPrefixNeedsReplacement = true
        if (laterTranscriptLine) transcriptIntegrity = 'failed'
        break
      }
      const entry = parsed.entry
      if (!isTranscriptLine(entry)) continue
      if (entry.t === 'msg') {
        if (
          !active ||
          entry.epochId !== active.start.epochId ||
          active.boundary ||
          typeof entry.entryId !== 'string' ||
          !isValidProvenance(entry.provenance) ||
          seenEntryIds.has(entry.entryId)
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        active.entries.push(
          createTrackedMessage(persistenceSafeMessage(entry.message), entry.provenance, entry.entryId),
        )
        continue
      }
      if (entry.kind === 'compact-boundary') {
        transcriptIntegrity = 'failed'
        break
      }
      if (entry.kind === 'transcript-epoch-start') {
        if (
          active ||
          (entry.mode === 'snapshot' && (entry.parentEpochId !== undefined || sawCommittedSnapshot)) ||
          (entry.mode === 'delta' && (!sawCommittedSnapshot || entry.parentEpochId !== committedTranscriptEpochId))
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        active = { start: entry, entries: [] }
        continue
      }
      if (entry.kind === 'context-security-boundary') {
        if (!active || active.boundary || entry.epochId !== active.start.epochId) {
          transcriptIntegrity = 'failed'
          break
        }
        active.boundary = entry
        continue
      }
      if (entry.kind === 'transcript-epoch-commit') {
        if (!active || !active.boundary || entry.epochId !== active.start.epochId) {
          transcriptIntegrity = 'failed'
          break
        }
        const candidate = active.start.mode === 'snapshot' ? active.entries : [...validTranscript, ...active.entries]
        const boundary = active.boundary
        const boundaryHash = createHash('sha256').update(canonicalSecurityJson(boundary)).digest('hex')
        if (
          entry.boundaryDigest !== boundaryHash ||
          boundary.resultEntryCount !== candidate.length ||
          boundary.resultTranscriptDigest !== canonicalTranscriptDigest(candidate) ||
          !isValidContextSecurity(boundary.state, candidate)
        ) {
          transcriptIntegrity = 'failed'
          break
        }
        validTranscript = candidate
        for (const tracked of active.entries) seenEntryIds.add(tracked.entryId)
        committedTranscriptEpochId = entry.epochId
        sawCommittedSnapshot = true
        active = undefined
      }
    }
    if (active) transcriptPrefixNeedsReplacement = true
    trackedMessages = validTranscript
    if (!sawCommittedSnapshot) transcriptIntegrity = 'failed'
  }

  const committedDigestBeforeRepair = canonicalTranscriptDigest(trackedMessages)
  // 修复旧版本以 JSON 序列化 Buffer 形式持久化的二进制片段——不做这一步，恢复的
  // 转录会在第一次请求时就无法通过 SDK 的 ModelMessage schema。
  normalizeSerializedBinaryParts(trackedMessages.map((entry) => entry.message))

  trackedMessages = sanitizeTrackedMessageTail(trackedMessages)
  const transcriptRequiresSnapshot =
    transcriptIntegrity !== 'clean' ||
    transcriptPrefixNeedsReplacement ||
    canonicalTranscriptDigest(trackedMessages) !== committedDigestBeforeRepair
  const derivedSecurity = deriveContextSecurity(trackedMessages)
  const contextSecurity: ContextSecurityState =
    transcriptIntegrity === 'failed'
      ? { ...derivedSecurity, peerInfluenceActive: true, integrityFailure: true }
      : derivedSecurity
  const scannedCacheMissSummary = scanCacheMisses(providerTurns)

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    name: header.name,
    startedAt: header.startedAt,
    modelId: lastUsage?.modelId ?? header.modelId,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstPrompt,
    messages: trackedMessages.map((entry) => entry.message),
    trackedMessages,
    contextSecurity,
    committedTranscriptEpochId,
    transcriptIntegrity,
    transcriptRequiresSnapshot,
    tokenUsage: lastUsage?.usage ?? EMPTY_USAGE,
    usageBreakdown: lastUsage?.breakdown ?? createUsageBreakdown(),
    providerTurns,
    cacheMissSummary: lastUsage?.cacheMissSummary
      ? {
          ...lastUsage.cacheMissSummary,
          estimatedReusableTokens: scannedCacheMissSummary.estimatedReusableTokens,
          estimatedReusedTokens: scannedCacheMissSummary.estimatedReusedTokens,
          comparableTurnCount: scannedCacheMissSummary.comparableTurnCount,
          estimates: scannedCacheMissSummary.estimates,
        }
      : scannedCacheMissSummary,
    goal,
    goalInputs,
    checkpoints,
    stepStats,
    memoryRecallAttachments,
    memoryRecallTombstones,
    memoryGeneration,
    forkedFrom,
    filePath,
  }
}

type ToolCallPart = { type?: string; toolCallId?: string }

/** 把以 JSON 序列化 Buffer / Uint8Array 形式持久化的二进制负载恢复成 base64 字符串。
 *  旧版本把原始 Buffer 实例放进 image/file 片段；JSON.stringify 会把它们变成
 *  `{"type":"Buffer","data":[...]}`（Buffer）或 `{"0":137,"1":80,...}`
 *  （Uint8Array）——两者都会在恢复时无法通过 SDK 的 ModelMessage schema，
 *  杀死恢复会话中的每一次请求。当形状不是可识别的序列化二进制时返回 undefined。 */
function serializedBinaryToBase64(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return Buffer.from(obj.data as number[]).toString('base64')
  }
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return Buffer.from(keys.sort((a, b) => Number(a) - Number(b)).map((k) => obj[k] as number)).toString('base64')
  }
  return undefined
}

/** 就地遍历已加载的消息，修复被 JSON 序列化破坏的二进制片段（见
 *  serializedBinaryToBase64）。覆盖 user/assistant 的 image 与 file 片段，
 *  以及 tool-result 的 `content` 条目。 */
function normalizeSerializedBinaryParts(messages: ModelMessage[]): void {
  const fixPart = (part: unknown): void => {
    if (!part || typeof part !== 'object') return
    const p = part as Record<string, unknown>
    if (p.type === 'image' && typeof p.image !== 'string') {
      const restored = serializedBinaryToBase64(p.image)
      if (restored !== undefined) p.image = restored
    } else if (p.type === 'file' && typeof p.data !== 'string') {
      const restored = serializedBinaryToBase64(p.data)
      if (restored !== undefined) p.data = restored
    }
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'user' || msg.role === 'assistant') {
      for (const part of msg.content) fixPart(part)
    } else if (msg.role === 'tool') {
      for (const part of msg.content as Array<{ type?: string; output?: { type?: string; value?: unknown } }>) {
        if (part?.type !== 'tool-result') continue
        const output = part.output
        if (output?.type !== 'content' || !Array.isArray(output.value)) continue
        for (const entry of output.value as Array<{ type?: string; data?: unknown }>) {
          if (
            (entry?.type === 'media' || entry?.type === 'image-data' || entry?.type === 'file-data') &&
            typeof entry.data !== 'string'
          ) {
            const restored = serializedBinaryToBase64(entry.data)
            if (restored !== undefined) entry.data = restored
          }
        }
      }
    }
  }
}

/** 丢弃数组后面没有匹配 tool_result 的尾部 assistant tool_call。提供方会以
 *  "tool_use without tool_result" 拒绝任何孤儿，因此恢复一个在工具执行中途结束的
 *  会话时，必须裁回到最后一个完全解析的边界。
 *
 *  算法：收集每个在别处有 tool_result 的 toolCallId，然后从末尾往回走，丢弃
 *  任何其 tool_call 片段包含未解析 id 的 assistant 消息。在第一条干净消息
 *  （纯文本 assistant，或其每个 tool_call 都已解析的 assistant）处停下。 */
function sanitizeMessageTail(messages: ModelMessage[]): ModelMessage[] {
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ToolCallPart[]) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        resolvedIds.add(part.toolCallId)
      }
    }
  }
  let cutAt = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      cutAt = i
      continue
    }
    if (msg.role !== 'assistant') {
      // 尾部没有上游 tool_call 的裸 'tool' 或 'user' 是合法的——继续往回走；
      // 裁剪只由孤儿 tool_call 驱动。
      break
    }
    const content = msg.content
    if (typeof content === 'string') break // 纯文本 assistant——干净的尾部
    if (!Array.isArray(content)) break
    const hasOrphan = (content as ToolCallPart[]).some(
      (p) => p?.type === 'tool-call' && typeof p.toolCallId === 'string' && !resolvedIds.has(p.toolCallId),
    )
    if (hasOrphan) {
      cutAt = i
      continue
    }
    break
  }
  return cutAt < messages.length ? messages.slice(0, cutAt) : messages
}

export function sanitizeTrackedMessageTail(entries: readonly TrackedModelMessage[]): TrackedModelMessage[] {
  const sanitizedMessages = sanitizeMessageTail(entries.map((entry) => entry.message))
  if (sanitizedMessages.length === entries.length) return entries.slice()
  return entries.slice(0, sanitizedMessages.length)
}

// ── 供选择器列出 ─────────────────────────────────────────────────────

export interface SessionListEntry {
  filePath: string
  sessionId: string
  taskSlug: string
  /** 由 `/fork <name>` 写入的自定义显示名；其他地方没有。 */
  name?: string
  firstPrompt: string
  /** 当会话由 `/fork` 创建时存在（从紧跟在文件头之后、位于头部读取范围内的
   *   fork meta 行解析而来）。 */
  forkedFrom?: SessionForkOrigin
  startedAt: string
  modelId: string
  /** 文件的 mtime（epoch 毫秒）——选择器的排序键。 */
  mtime: number
  tokenUsage: TokenUsage | null
  usageBreakdown?: UsageBreakdown | null
  cacheMissSummary?: CacheMissSummary | null
}

/** 按从新到旧枚举当前项目里的每个会话 jsonl。只读每个文件的头部（约 8KB，取文件头行）
 *  和尾部（约 4KB，取最后一条 usage 行）——不做全文件加载——这样即使有数百个历史会话，
 *  选择器也能保持响应。没有可解析文件头的文件会被静默丢弃。 */
/** 通过重写文件头行来重命名会话。转录正文逐字节保留；重写走与压缩快照相同的
 *  临时文件 + fsync + rename 路径。 */
export async function renameSession(filePath: string, name: string): Promise<string> {
  if (!filePath.endsWith('.jsonl')) throw new Error('Not a session file')
  const trimmed = name.trim().slice(0, 200)
  if (!trimmed) throw new Error('Session name cannot be empty')
  const content = await fs.readFile(filePath, 'utf8')
  const newline = content.indexOf('\n')
  const headerText = newline === -1 ? content : content.slice(0, newline)
  let header: HeaderEntry
  try {
    header = JSON.parse(headerText) as HeaderEntry
  } catch {
    throw new Error('Session file has no readable header')
  }
  if (header.kind !== 'header') throw new Error('Session file has no header')
  const payload = JSON.stringify({ ...header, name: trimmed }) + (newline === -1 ? '\n' : content.slice(newline))
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeTempSnapshot(tempPath, payload)
    await fs.rename(tempPath, filePath)
    await syncParentDirectory(filePath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
  return trimmed
}

/** 删除一个会话转录。UX 确认由调用方负责。 */
export async function deleteSession(filePath: string): Promise<void> {
  if (!filePath.endsWith('.jsonl')) throw new Error('Not a session file')
  await fs.unlink(filePath)
}

export async function listSessions(cwd: string = process.cwd()): Promise<SessionListEntry[]> {
  const dir = sessionsDir(cwd)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
  const results = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(dir, f)
      try {
        const stat = await fs.stat(filePath)
        const head = await readRange(filePath, 0, Math.min(8 * 1024, stat.size))
        const headLines = head.split('\n')
        const headerLine = headLines.find((l) => l.includes('"kind":"header"'))
        if (!headerLine) return null
        let header: HeaderEntry
        try {
          header = JSON.parse(headerLine) as HeaderEntry
        } catch {
          return null
        }
        let forkedFrom: SessionForkOrigin | undefined
        const forkLine = headLines.find((l) => l.includes('"kind":"fork"'))
        if (forkLine) {
          try {
            const fork = JSON.parse(forkLine) as ForkEntry
            // 防范在非 fork 内容上的子串命中，这样一行格式错误的内容不会产生
            // 一个 sessionId 为 undefined 的 forkedFrom。
            if (fork.kind === 'fork' && typeof fork.parentSessionId === 'string') {
              forkedFrom = { sessionId: fork.parentSessionId, messageCount: fork.messageCount, forkedAt: fork.ts }
            }
          } catch {
            // fork 行格式错误——谱系提示只是尽力而为。
          }
        }
        const tailStart = Math.max(0, stat.size - 4 * 1024)
        const tail = await readRange(filePath, tailStart, stat.size - tailStart)
        let tokenUsage: TokenUsage | null = null
        let usageBreakdown: UsageBreakdown | null = null
        let cacheMissSummary: CacheMissSummary | null = null
        let latestModelId = header.modelId
        const tailLines = tail.split('\n').reverse()
        for (const l of tailLines) {
          if (!l.trim()) continue
          if (l.includes('"kind":"usage"')) {
            try {
              const e = JSON.parse(l) as UsageEntry
              tokenUsage = e.usage
              usageBreakdown = e.breakdown ?? null
              cacheMissSummary = e.cacheMissSummary ?? null
              latestModelId = e.modelId || header.modelId
              break
            } catch {
              // 行格式错误——继续扫描更早的行。
            }
          }
        }
        return {
          filePath,
          sessionId: header.sessionId,
          taskSlug: header.taskSlug,
          name: header.name,
          forkedFrom,
          firstPrompt: header.firstPrompt,
          startedAt: header.startedAt,
          modelId: latestModelId,
          mtime: stat.mtimeMs,
          tokenUsage,
          usageBreakdown,
          cacheMissSummary,
        } satisfies SessionListEntry
      } catch {
        return null
      }
    }),
  )
  return results
    .filter((r): r is Exclude<(typeof results)[number], null> => r !== null)
    .sort((a, b) => b.mtime - a.mtime)
}

/** 以 utf-8 读取文件的 [offset, offset+length) 字节。供 `listSessions` 抓取
 *  头部/尾部，而无需吞下整个文件。 */
async function readRange(filePath: string, offset: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await fh.close()
  }
}

/** 选取当前项目里最近修改的会话文件，若不存在则返回 null。供 `xc --continue` / `-c`
 *  跳过选择器、无条件恢复最新会话使用。 */
export async function pickLatestSession(cwd: string = process.cwd()): Promise<SessionListEntry | null> {
  const all = await listSessions(cwd)
  return all[0] ?? null
}

/** 从先前保存的会话构建一个 LoopState。agent loop 接受 `existingState`，并将继续
 *  向已加载的确切 jsonl 路径追加，包括旧版 slug 前缀文件名。`persistedMessageCount`
 *  被设为已加载的长度，这样下一次用户提交后的第一次刷写只会追加新消息——已加载的
 *  尾部已经在磁盘上了。 */
export function hydrateLoopState(
  loaded: LoadedSession,
  initialMode: PermissionMode = 'default',
  projectCwd: string = process.cwd(),
): LoopState {
  const state = createLoopState(initialMode, { ownerSessionId: loaded.sessionId, projectCwd })
  state.sessionFilePath = loaded.filePath
  state.taskSlug = loaded.taskSlug
  state.startedAt = loaded.startedAt
  setTrackedTranscript(state, loaded.trackedMessages)
  state.contextSecurity = structuredClone(loaded.contextSecurity)
  state.executionAuthority = effectiveExecutionAuthority({ source: 'user', peerTainted: false }, state.contextSecurity)
  state.committedTranscriptEpochId = loaded.committedTranscriptEpochId
  state.transcriptIntegrity = loaded.transcriptIntegrity
  state.transcriptRequiresSnapshot = loaded.transcriptRequiresSnapshot
  state.tokenUsage = { ...loaded.tokenUsage }
  state.usageBreakdown = loaded.usageBreakdown ? cloneUsageBreakdown(loaded.usageBreakdown) : createUsageBreakdown()
  state.providerTurns = loaded.providerTurns?.slice() ?? []
  const scannedCacheMissSummary = scanCacheMisses(state.providerTurns)
  state.cacheMissSummary = loaded.cacheMissSummary
    ? {
        ...loaded.cacheMissSummary,
        estimatedReusableTokens: scannedCacheMissSummary.estimatedReusableTokens,
        estimatedReusedTokens: scannedCacheMissSummary.estimatedReusedTokens,
        comparableTurnCount: scannedCacheMissSummary.comparableTurnCount,
        estimates: scannedCacheMissSummary.estimates,
      }
    : scannedCacheMissSummary
  // `inputTokens` 跨会话累计，在一段恢复的对话里可能高达数百万。在这里使用它会让
  // 恢复后的第一轮看起来像上下文已满，并在百分之几时触发压缩。最后一次请求的当前
  // 上下文才是与阈值比较的正确对象。
  state.lastInputTokens = loaded.tokenUsage.currentContextTokens || 0
  state.persistedMessageCount = loaded.trackedMessages.length
  state.checkpoints = loaded.checkpoints.slice()
  state.goal = loaded.goal ? structuredClone(loaded.goal) : null
  state.goalInputs = loaded.goalInputs.map((input) => ({ ...input }))
  state.stepStats = loaded.stepStats.slice()
  state.memoryRecallAttachments = loaded.memoryRecallAttachments.map((attachment) => structuredClone(attachment))
  state.memoryRecallTombstones = loaded.memoryRecallTombstones.map((tombstone) => structuredClone(tombstone))
  state.memoryGeneration = loaded.memoryGeneration
  state.surfacedMemoryHashes = new Set(
    state.memoryRecallAttachments.flatMap((attachment) =>
      attachment.topics.map((topic) => `${topic.topicId}@${topic.topicHash}`),
    ),
  )
  state.memoryTokensInWindow = state.memoryRecallAttachments.reduce(
    (sum, attachment) => sum + attachment.estimatedTokens,
    0,
  )
  return state
}
