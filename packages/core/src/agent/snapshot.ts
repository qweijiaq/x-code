// @x-code-cli/core — 文件历史快照存储（按内容寻址）
//
// 支撑 `/rewind` 命令。每个用户消息轮次都会产生一个 checkpoint，捕获
// `state.filesModified` 中每个文件的当前状态。内容按 sha256 blob 去重——
// 跨 checkpoint 重复的文件在磁盘上只占一份。每个会话的布局位于
// .x-code/file-history/<sid>/：
//
//   blobs/<sha256>           — 按内容寻址的文件内容（共享）
//   checkpoints/<id>.json    — 清单，映射绝对路径 -> blob 哈希 | absent | skip
//
// 为什么按内容寻址（而不是每个 checkpoint 各存一份）：在典型 agent 运行中，
// 相邻用户消息之间大多数文件不变——模型每轮只编辑 1-3 个文件，而
// `filesModified` 可能已累计 30+ 个。有了去重，新 checkpoint 的边际成本
// 就只是实际变更文件的字节数，而不是整个被追踪集合。
//
// 为什么不用影子 git（按设计讨论）：文件拷贝让这在非 git 项目里也能工作，
// 规避 .gitignore 冲突，并避免任何触及用户真实 .git 索引的可能。
import { diffLines } from 'diff'

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, fileExists, generateTimestampId } from '../utils.js'
import { atomicWriteFile } from '../utils/atomic-file.js'
import type { LoopState } from './loop-state.js'

const FILE_HISTORY_SUBDIR = 'file-history'
const BLOBS_SUBDIR = 'blobs'
const CHECKPOINTS_SUBDIR = 'checkpoints'
const ORIGINS_FILENAME = 'origins.json'

/** 大于此大小的文件在清单里记作 `skip: true`，恢复时保持不动。避免一个游离的
 *  构建产物（数 MB 到数 GB）撑爆 blob 存储；agent 追踪的源文件几乎从不会这么大。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** 环形缓冲上限。较旧的 checkpoint 会被逐出；孤儿 blob 在下一次恢复或逐出时
 *  被 GC。100 与 Claude Code 的上限一致。 */
const MAX_CHECKPOINTS = 100
const SNAPSHOT_CONCURRENCY = 8

const checkpointMutationQueues = new WeakMap<LoopState, Promise<unknown>>()

function serializeCheckpointMutation<T>(state: LoopState, mutation: () => Promise<T>): Promise<T> {
  const previous = checkpointMutationQueues.get(state) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(mutation)
  checkpointMutationQueues.set(state, current)
  return current.finally(() => {
    if (checkpointMutationQueues.get(state) === current) checkpointMutationQueues.delete(state)
  })
}

/** checkpoint 的公开内存表示。以 `meta:checkpoint` 行镜像到 jsonl，这样 /rewind
 *  能跨 /resume 存活。 */
export interface CheckpointEntry {
  ckptId: string
  /** 用户消息被推入之后的 `state.messages.length`。回退会把消息截断到
   *   `messageCount - 1`（丢弃该用户消息及其后的一切）。跨压缩不稳定——
   *   内存列表会被 markBoundaryAndReflush 清空。 */
  messageCount: number
  ts: string
  /** 触发此 checkpoint 的用户消息前约 200 字符——驱动选择器的预览。 */
  userPrompt: string
}

interface ManifestFileEntry {
  /** 快照时文件内容的 sha256 十六进制。指向 blobs/<hash>。 */
  hash?: string
  /** 快照时文件不存在（或不是常规文件）。恢复时：若当前存在则 unlink。 */
  absent?: boolean
  /** 快照时文件过大或不可读。恢复时：保持现场文件不动——我们没能捕获它，
   *   也就无法撤销它。 */
  skip?: boolean
}

interface Manifest {
  ckptId: string
  ts: string
  messageCount: number
  userPrompt: string
  /** 键是绝对路径（即 `state.filesModified` 存储的内容）。 */
  files: Record<string, ManifestFileEntry>
}

interface OriginManifest {
  version: 1
  /** agent 首次修改每个路径之前的即时状态。每个路径每会话只捕获一次，
   *   在写入到达文件系统之前。 */
  files: Record<string, ManifestFileEntry>
}

function historyDir(sessionId: string, cwd: string): string {
  return path.join(cwd, XCODE_DIR, FILE_HISTORY_SUBDIR, sessionId)
}

function blobsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), BLOBS_SUBDIR)
}

function checkpointsDir(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), CHECKPOINTS_SUBDIR)
}

function originsPath(sessionId: string, cwd: string): string {
  return path.join(historyDir(sessionId, cwd), ORIGINS_FILENAME)
}

function manifestPath(sessionId: string, ckptId: string, cwd: string): string {
  return path.join(checkpointsDir(sessionId, cwd), `${ckptId}.json`)
}

function blobPath(sessionId: string, hash: string, cwd: string): string {
  return path.join(blobsDir(sessionId, cwd), hash)
}

/** 区分“文件确实不存在”与“因其他任何原因（EACCES、EPERM、EBUSY……）无法 stat”。
 *  把一个受权限保护的文件误标为 ENOENT 会把它记作 `absent`，并在恢复时静默地
 *  unlink 它——这比什么都不做更糟。 */
type StatOutcome = { kind: 'ok'; stat: Stats } | { kind: 'absent' } | { kind: 'unreadable' }
async function statSafe(p: string): Promise<StatOutcome> {
  try {
    return { kind: 'ok', stat: await fs.stat(p) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unreadable' }
  }
}

async function writeBlobIfMissing(sessionId: string, hash: string, content: Buffer, cwd: string): Promise<void> {
  const p = blobPath(sessionId, hash, cwd)
  if (await fileExists(p)) return
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

function isManifestFileEntry(value: unknown): value is ManifestFileEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const flags = [typeof entry.hash === 'string', entry.absent === true, entry.skip === true].filter(Boolean).length
  return flags === 1
}

async function readOrigins(sessionId: string, cwd: string): Promise<OriginManifest> {
  let raw: string
  try {
    raw = await fs.readFile(originsPath(sessionId, cwd), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, files: {} }
    throw err
  }

  const parsed = JSON.parse(raw) as Partial<OriginManifest>
  if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new Error('Invalid checkpoint origin manifest')
  }
  for (const entry of Object.values(parsed.files)) {
    if (!isManifestFileEntry(entry)) throw new Error('Invalid checkpoint origin entry')
  }
  return parsed as OriginManifest
}

async function writeOrigins(sessionId: string, origins: OriginManifest, cwd: string): Promise<void> {
  await atomicWriteFile(originsPath(sessionId, cwd), JSON.stringify(origins, null, 2))
}

/** 在本会话中路径首次被 agent 修改之前立即捕获它。checkpoint 清单只包含
 *  checkpoint 创建时已知的文件，因此这条 origin 记录能区分“先前就存在的文件”
 *  与“在某个更早 checkpoint 之后才真正创建的文件”。
 *
 *  在调用方修改文件之前，写入就已持久化。损坏的 origin 存储会抛错并阻止
 *  修改，而不是静默丢失回退溯源。会话已追踪的路径无需查询 origin。 */
export async function captureFileBeforeMutation(
  state: LoopState,
  filePath: string,
  cwd: string = state.projectCwd,
  signal?: AbortSignal,
): Promise<void> {
  const absPath = path.resolve(cwd, filePath)
  if (state.checkpoints.length === 0 || state.filesModified.has(absPath)) return
  signal?.throwIfAborted()

  const origins = await readOrigins(state.sessionId, cwd)
  if (origins.files[absPath]) return

  const outcome = await statSafe(absPath)
  signal?.throwIfAborted()
  let entry: ManifestFileEntry
  if (outcome.kind === 'absent') {
    entry = { absent: true }
  } else if (outcome.kind === 'unreadable' || !outcome.stat.isFile() || outcome.stat.size > MAX_FILE_BYTES) {
    entry = { skip: true }
  } else {
    try {
      const content = signal ? await fs.readFile(absPath, { signal }) : await fs.readFile(absPath)
      signal?.throwIfAborted()
      const hash = createHash('sha256').update(content).digest('hex')
      await writeBlobIfMissing(state.sessionId, hash, content, cwd)
      entry = { hash }
    } catch (err) {
      if (signal?.aborted) throw err
      entry = { skip: true }
    }
  }

  origins.files[absPath] = entry
  await writeOrigins(state.sessionId, origins, cwd)
}

/** 把 `state.filesModified` 中每个文件当前的磁盘状态捕获进一个新的按内容寻址
 *  checkpoint，并把条目追加到 `state.checkpoints`。成功时返回条目，文件系统失败时
 *  返回 null（此时回退到该点不安全——调用方应把快照视为不可用，而不是静默跳过它）。
 *
 *  快照对每个文件尽力而为：某个路径读取失败就标记 `skip` 并继续，因此单个文件上
 *  一次瞬时 EACCES 不会毁掉整个 checkpoint。 */
export async function createCheckpoint(
  state: LoopState,
  userPromptPreview: string,
  cwd: string = state.projectCwd,
  signal?: AbortSignal,
): Promise<CheckpointEntry | null> {
  return serializeCheckpointMutation(state, () => createCheckpointUnlocked(state, userPromptPreview, cwd, signal))
}

async function createCheckpointUnlocked(
  state: LoopState,
  userPromptPreview: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CheckpointEntry | null> {
  if (signal?.aborted) return null
  // 连续快照可能在一毫秒内完成。推进本地时间戳，直到其规范文件名唯一，且不阻塞 UI。
  const existingIds = new Set(state.checkpoints.map((checkpoint) => checkpoint.ckptId))
  let checkpointDate = new Date()
  let ckptId = generateTimestampId(checkpointDate)
  while (existingIds.has(ckptId)) {
    checkpointDate = new Date(checkpointDate.getTime() + 1)
    ckptId = generateTimestampId(checkpointDate)
  }
  const messageCount = state.messages.length
  const files: Record<string, ManifestFileEntry> = {}

  for (const cachedPath of state.checkpointFileCache.keys()) {
    if (!state.filesModified.has(cachedPath)) state.checkpointFileCache.delete(cachedPath)
  }

  const paths = [...state.filesModified]
  let cursor = 0
  const worker = async () => {
    while (!signal?.aborted) {
      const absPath = paths[cursor++]
      if (absPath === undefined) return
      const outcome = await statSafe(absPath)
      if (signal?.aborted) return
      if (outcome.kind === 'absent') {
        state.checkpointFileCache.delete(absPath)
        files[absPath] = { absent: true }
        continue
      }
      if (outcome.kind === 'unreadable') {
        // 因“文件不存在”以外的原因无法 stat——多半是权限问题。标记 skip，这样恢复时
        // 不会去删除一个用户（或另一进程）正在关心的文件。
        state.checkpointFileCache.delete(absPath)
        files[absPath] = { skip: true }
        continue
      }
      const stat = outcome.stat
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        // 符号链接 / 目录 / 过大 blob——记作 skip，让恢复知道要放过它们
        //（而不是误判为 absent 并删除）。
        state.checkpointFileCache.delete(absPath)
        files[absPath] = { skip: true }
        continue
      }

      const cached = state.checkpointFileCache.get(absPath)
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        files[absPath] = { hash: cached.hash }
        continue
      }

      try {
        const buf = signal ? await fs.readFile(absPath, { signal }) : await fs.readFile(absPath)
        const hash = createHash('sha256').update(buf).digest('hex')
        await writeBlobIfMissing(state.sessionId, hash, buf, cwd)
        state.checkpointFileCache.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, hash })
        files[absPath] = { hash }
      } catch {
        if (signal?.aborted) return
        state.checkpointFileCache.delete(absPath)
        files[absPath] = { skip: true }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, paths.length) }, () => worker()))
  if (signal?.aborted) return null

  try {
    await fs.mkdir(checkpointsDir(state.sessionId, cwd), { recursive: true })
  } catch {
    return null
  }

  let manifest: Manifest
  while (true) {
    manifest = {
      ckptId,
      ts: checkpointDate.toISOString(),
      messageCount,
      userPrompt: userPromptPreview.slice(0, 200),
      files,
    }
    try {
      await fs.writeFile(manifestPath(state.sessionId, ckptId, cwd), JSON.stringify(manifest, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
      })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null
      existingIds.add(ckptId)
      do {
        checkpointDate = new Date(checkpointDate.getTime() + 1)
        ckptId = generateTimestampId(checkpointDate)
      } while (existingIds.has(ckptId))
    }
  }

  const entry: CheckpointEntry = {
    ckptId,
    messageCount,
    ts: manifest.ts,
    userPrompt: manifest.userPrompt,
  }
  state.checkpoints.push(entry)

  // 环形缓冲逐出。丢弃最旧的清单；把 blob GC 推迟到下方摊销的清扫，
  // 这样每次逐出时就不必重读剩余清单。
  let evicted = false
  while (state.checkpoints.length > MAX_CHECKPOINTS) {
    const dropped = state.checkpoints.shift()
    if (!dropped) break
    void fs.unlink(manifestPath(state.sessionId, dropped.ckptId, cwd)).catch(() => undefined)
    evicted = true
  }
  if (evicted) {
    // 这里等待（而非发后即忘），让测试看到确定的 blob 计数，也避免后续逐出与
    // 仍在运行的清扫竞态、重复删除新清单引用的某个 blob。GC 是 O(剩余 checkpoint *
    // 每个清单的文件数)——最多几百次读取，在两次逐出之间的数百个常规 checkpoint
    // 上摊销。
    await garbageCollectBlobs(state, cwd).catch(() => undefined)
  }

  return entry
}

/** 把工作树恢复到 `ckptId` 捕获的状态。算法作用于（当前 `filesModified`、
 *  清单键）的并集：
 *    - 在清单中且带 `hash`   → 把 blob 内容写回
 *    - 在清单中且带 `absent` → unlink（若存在）
 *    - 在清单中且带 `skip`   → 保持不动（未能捕获）
 *    - 不在清单中            → 查询首次修改 origin 副产物
 *      （`hash` 恢复先前存在的文件；`absent` 删除一个新文件）
 *    - 两个存储中都缺失      → 保持不动（旧版/未知溯源）
 *  并集之外的文件不动——我们只撤销 agent 历史上真正碰过的东西。
 *
 *  成功恢复之后：
 *    - `state.filesModified` 从清单键重建（这样 agent 对“已触碰文件”的认知
 *      与恢复点一致）。
 *    - 目标之后的 checkpoint 从 `state.checkpoints` 中丢弃，其清单被删除；
 *      孤儿 blob 被 GC。
 *
 *  调用方（use-agent）负责把 `state.messages` 截断到 `entry.messageCount - 1`
 *  并重写会话 jsonl——这里的恢复只触及工作树 + checkpoint 记账。 */
export async function restoreCheckpoint(
  state: LoopState,
  ckptId: string,
  cwd: string = state.projectCwd,
): Promise<boolean> {
  return serializeCheckpointMutation(state, () => restoreCheckpointUnlocked(state, ckptId, cwd))
}

async function restoreCheckpointUnlocked(state: LoopState, ckptId: string, cwd: string): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(state.sessionId, ckptId, cwd), 'utf-8')
  } catch {
    return false
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return false
  }

  let origins: OriginManifest
  try {
    origins = await readOrigins(state.sessionId, cwd)
  } catch {
    return false
  }

  const allFiles = new Set<string>([...state.filesModified, ...Object.keys(manifest.files)])
  for (const absPath of allFiles) {
    const entry = manifest.files[absPath] ?? origins.files[absPath]
    if (!entry) {
      // 旧会话没有 origin 副产物，因此缺失条目是含糊的。保留现场文件：没能删除
      // 一个旧版创建的文件，比删掉一个先前就存在的用户文件更安全。
      continue
    }
    if (entry.skip) continue
    if (entry.absent) {
      await fs.unlink(absPath).catch(() => undefined)
      continue
    }
    if (entry.hash) {
      try {
        const buf = await fs.readFile(blobPath(state.sessionId, entry.hash, cwd))
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.writeFile(absPath, buf)
      } catch {
        // blob 缺失 → 无法恢复该文件。不要让整个回退失败：单个坏文件好过把
        // 其余部分留在一个半恢复状态。
      }
    }
  }

  // 回退到某路径首次修改之前，就开启了一条新分支。丢弃那个“未来 origin”，
  // 这样稍后在同一路径上手动/用户创建的文件会从其新的真实状态捕获，而不是
  // 从被放弃分支继承过期的 `absent`/hash 溯源。
  let originsChanged = false
  for (const absPath of Object.keys(origins.files)) {
    if (!manifest.files[absPath]) {
      delete origins.files[absPath]
      originsChanged = true
    }
  }
  if (originsChanged) {
    try {
      await writeOrigins(state.sessionId, origins, cwd)
    } catch {
      return false
    }
  }

  // 从清单重建 filesModified，这样后续 checkpoint 覆盖正确的集合。包含
  // absent/skip 条目：这些文件历史上被 agent 碰过，应保持在范围内。
  state.filesModified.clear()
  for (const absPath of Object.keys(manifest.files)) {
    state.filesModified.add(absPath)
  }
  state.checkpointFileCache.clear()

  // 丢弃被恢复的 checkpoint 之后的那些（保留目标——用户现在“处于”该点，
  // 可以再次回退到它）。
  const cutoffIndex = state.checkpoints.findIndex((c) => c.ckptId === ckptId)
  if (cutoffIndex >= 0) {
    const dropped = state.checkpoints.splice(cutoffIndex + 1)
    await Promise.all(
      dropped.map((entry) => fs.unlink(manifestPath(state.sessionId, entry.ckptId, cwd)).catch(() => undefined)),
    )
  }
  await garbageCollectBlobs(state, cwd).catch(() => undefined)
  return true
}

export interface DiffStats {
  filesChanged: string[]
  insertions: number
  deletions: number
}

async function readFileUtf8OrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** 计算如果工作树被恢复到给定 checkpoint，会有多少文件/行发生改变。清单无法
 *  读取（被逐出或损坏）时返回 null。使用与 restoreCheckpoint 相同的
 *  `filesModified ∪ manifest` 并集，这样预览与真实回退会触及的内容完全一致。 */
export async function getDiffStatsForCheckpoint(
  state: LoopState,
  ckptId: string,
  cwd: string = state.projectCwd,
): Promise<DiffStats | null> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath(state.sessionId, ckptId, cwd), 'utf-8')
  } catch {
    return null
  }
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw) as Manifest
  } catch {
    return null
  }

  let origins: OriginManifest
  try {
    origins = await readOrigins(state.sessionId, cwd)
  } catch {
    return null
  }

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0

  // 对齐 restoreCheckpoint 的文件并集：清单键（checkpoint 时追踪的文件）+
  // state.filesModified（agent 自会话开始以来碰过的文件，包括此 checkpoint 之后
  // 创建的那些）。
  const allFiles = new Set<string>([...state.filesModified, ...Object.keys(manifest.files)])
  for (const absPath of allFiles) {
    try {
      const entry = manifest.files[absPath] ?? origins.files[absPath]

      if (entry?.skip) continue

      const currentContent = await readFileUtf8OrNull(absPath)

      if (!entry) {
        // 未知旧版溯源——恢复会让该文件保持不动。
        continue
      }

      if (entry.absent) {
        // 文件在 checkpoint 时不存在——回退会删除它。
        if (currentContent !== null) {
          const lineCount = currentContent.split('\n').length
          filesChanged.push(absPath)
          deletions += lineCount
        }
        continue
      }

      if (entry.hash) {
        const blobContent = await readFileUtf8OrNull(blobPath(state.sessionId, entry.hash, cwd))
        if (blobContent === null) continue

        if (currentContent === null) {
          // 文件在 checkpoint 之后被删除——回退会重建它。
          const lineCount = blobContent.split('\n').length
          filesChanged.push(absPath)
          insertions += lineCount
          continue
        }

        if (currentContent === blobContent) continue

        const changes = diffLines(blobContent, currentContent)
        let fileInsertions = 0
        let fileDeletions = 0
        for (const change of changes) {
          if (change.added) fileDeletions += change.count ?? 0
          if (change.removed) fileInsertions += change.count ?? 0
        }
        if (fileInsertions > 0 || fileDeletions > 0) {
          filesChanged.push(absPath)
          insertions += fileInsertions
          deletions += fileDeletions
        }
      }
    } catch {
      // 单个文件失败——跳过，不要毁掉整个统计计算。
    }
  }

  return { filesChanged, insertions, deletions }
}

/** 清扫 blobs/ 并 unlink 任何不再被剩余清单引用的 blob。开销低：O(剩余 checkpoint *
 *  每个清单的文件数)次读取 + 一次 readdir。在逐出之后与恢复之后运行——这两条路径
 *  是唯一会产生孤儿 blob 的地方。 */
async function garbageCollectBlobs(state: LoopState, cwd: string): Promise<void> {
  const referenced = new Set<string>()
  for (const ckpt of state.checkpoints) {
    try {
      const raw = await fs.readFile(manifestPath(state.sessionId, ckpt.ckptId, cwd), 'utf-8')
      const m = JSON.parse(raw) as Manifest
      for (const entry of Object.values(m.files)) {
        if (entry.hash) referenced.add(entry.hash)
      }
    } catch {
      // 清单已消失或不可读——跳过；它的 blob 会与其余一起成为收集候选。
    }
  }
  try {
    const origins = await readOrigins(state.sessionId, cwd)
    for (const entry of Object.values(origins.files)) {
      if (entry.hash) referenced.add(entry.hash)
    }
  } catch {
    // 损坏/不可读的 origin 存储可能仍引用着 blob。fail closed，保留所有 blob，
    // 而不是删除唯一的回退副本。
    return
  }
  let names: string[]
  try {
    names = await fs.readdir(blobsDir(state.sessionId, cwd))
  } catch {
    return
  }
  for (const name of names) {
    if (!referenced.has(name)) {
      await fs.unlink(blobPath(state.sessionId, name, cwd)).catch(() => undefined)
    }
  }
}
