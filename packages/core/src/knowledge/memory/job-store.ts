import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage, fileExists } from '../../utils.js'
import { atomicWriteFile, syncDirectory } from '../../utils/atomic-file.js'
import { acquireFileLock } from '../../utils/file-lock.js'
import type { FileLockLease } from '../../utils/file-lock.js'
import { redactMemoryValue } from './redaction.js'
import type { MemoryJob } from './types.js'

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000]
const LOCK_STALE_MS = 30_000
const SAFE_JOB_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
const MAX_JOB_BYTES = 2 * 1024 * 1024
const RECENT_RUNS_MAX_BYTES = 256 * 1024
const RECENT_RUNS_MAX_RECORDS = 256

export type ExtractorLease = FileLockLease

export interface MemoryRunRecord {
  jobId: string
  status: 'success' | 'no-op' | 'warning' | 'failed'
  durationMs: number
  tokens: number
  operations: number
  errorCategory?: string
  completedAt: string
}

/** 判定"这个待办文件本身是坏的"，与 I/O 故障区分开：只有前者才该被搬进
 *  failed/ 隔离——EACCES/EBUSY 之类瞬时错误把合法 job 隔离掉会造成静默丢
 *  数据（failed/ 里的同名文件会被 `enqueue()` 当作 duplicate，永远无法重试）。 */
class CorruptJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptJobError'
  }
}

function validateJob(value: unknown): MemoryJob {
  if (!value || typeof value !== 'object') throw new Error('Job must be an object')
  const job = value as Partial<MemoryJob>
  if (
    job.version !== 2 ||
    typeof job.jobId !== 'string' ||
    !SAFE_JOB_ID_RE.test(job.jobId) ||
    typeof job.sessionId !== 'string' ||
    !SAFE_JOB_ID_RE.test(job.sessionId) ||
    typeof job.turnStartMessageIndex !== 'number' ||
    !Number.isSafeInteger(job.turnStartMessageIndex) ||
    job.turnStartMessageIndex < 0 ||
    typeof job.modelId !== 'string' ||
    !job.modelId.trim() ||
    job.modelId.length > 500 ||
    typeof job.repositoryId !== 'string' ||
    !job.repositoryId.trim() ||
    job.repositoryId.length > 8192 ||
    typeof job.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(job.createdAt)) ||
    typeof job.sourceOccurredAt !== 'string' ||
    !Number.isFinite(Date.parse(job.sourceOccurredAt)) ||
    typeof job.attempt !== 'number' ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    (job.explicitMemoryIntent !== undefined && typeof job.explicitMemoryIntent !== 'boolean') ||
    (job.nextAttemptAt !== undefined &&
      (typeof job.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(job.nextAttemptAt)))) ||
    !validateProjection(job.projection, job.repositoryId)
  ) {
    throw new Error('Invalid memory job schema')
  }
  return { ...job, explicitMemoryIntent: job.explicitMemoryIntent ?? false } as MemoryJob
}

function validateProjection(value: unknown, repositoryId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const projection = value as Record<string, unknown>
  const stringArray = (item: unknown, maxItems: number, maxChars: number) =>
    Array.isArray(item) &&
    item.length <= maxItems &&
    item.every((entry) => typeof entry === 'string' && entry.length <= maxChars)
  if (
    !stringArray(projection.userMessages, 32, 12_000) ||
    typeof projection.assistantFinal !== 'string' ||
    projection.assistantFinal.length > 18_000 ||
    !Array.isArray(projection.events) ||
    projection.events.length > 128 ||
    !stringArray(projection.changedFiles, 512, 8192) ||
    !stringArray(projection.verification, 128, 1000) ||
    projection.repositoryId !== repositoryId ||
    typeof projection.turnStartedAt !== 'string' ||
    !Number.isFinite(Date.parse(projection.turnStartedAt)) ||
    typeof projection.turnCompletedAt !== 'string' ||
    !Number.isFinite(Date.parse(projection.turnCompletedAt))
  ) {
    return false
  }
  return projection.events.every((event) => {
    if (!event || typeof event !== 'object') return false
    const item = event as Record<string, unknown>
    if (item.type === 'tool-call') {
      return (
        typeof item.name === 'string' &&
        item.name.length <= 500 &&
        typeof item.summary === 'string' &&
        item.summary.length <= 1000
      )
    }
    return (
      item.type === 'tool-result' &&
      typeof item.name === 'string' &&
      item.name.length <= 500 &&
      (item.status === 'ok' || item.status === 'error') &&
      typeof item.evidence === 'string' &&
      item.evidence.length <= 1000
    )
  })
}

export class MemoryJobStore {
  readonly stateRoot: string
  readonly pendingDir: string
  readonly runningDir: string
  readonly failedDir: string
  readonly appliedDir: string
  readonly locksDir: string
  readonly recentRunsPath: string

  constructor(memoryRoot: string) {
    this.stateRoot = path.join(memoryRoot, '.state')
    this.pendingDir = path.join(this.stateRoot, 'jobs', 'pending')
    this.runningDir = path.join(this.stateRoot, 'jobs', 'running')
    this.failedDir = path.join(this.stateRoot, 'jobs', 'failed')
    this.appliedDir = path.join(this.stateRoot, 'jobs', 'applied')
    this.locksDir = path.join(this.stateRoot, 'locks')
    this.recentRunsPath = path.join(this.stateRoot, 'recent-runs.jsonl')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.pendingDir, { recursive: true }),
      fs.mkdir(this.runningDir, { recursive: true }),
      fs.mkdir(this.failedDir, { recursive: true }),
      fs.mkdir(this.appliedDir, { recursive: true }),
      fs.mkdir(this.locksDir, { recursive: true }),
    ])
  }

  async enqueue(job: MemoryJob): Promise<'created' | 'duplicate'> {
    validateJob(job)
    const fileName = `${job.jobId}.json`
    if (await fileExists(path.join(this.appliedDir, fileName))) return 'duplicate'
    if (await this.hasCompletedRun(job.jobId)) return 'duplicate'
    for (const dir of [this.pendingDir, this.runningDir, this.failedDir]) {
      if (await fileExists(path.join(dir, fileName))) return 'duplicate'
    }
    const target = path.join(this.pendingDir, fileName)
    const temp = path.join(this.pendingDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`)
    const payload = JSON.stringify(redactMemoryValue(job), null, 2) + '\n'
    const handle = await fs.open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(payload, 'utf-8')
      await handle.sync().catch(() => {})
    } finally {
      await handle.close()
    }
    try {
      try {
        await fs.link(temp, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return 'duplicate'
        if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error
        const lockPath = path.join(this.locksDir, `enqueue-${job.jobId}.lock`)
        const deadline = Date.now() + 10_000
        while (true) {
          try {
            await fs.mkdir(lockPath)
            break
          } catch (lockError) {
            if ((lockError as NodeJS.ErrnoException).code !== 'EEXIST') throw lockError
            for (const dir of [this.pendingDir, this.runningDir, this.failedDir, this.appliedDir]) {
              if (await fileExists(path.join(dir, fileName))) return 'duplicate'
            }
            const stat = await fs.stat(lockPath).catch(() => null)
            if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
              await fs.rmdir(lockPath).catch(() => {})
              continue
            }
            if (Date.now() >= deadline) throw new Error(`Timed out publishing memory job: ${job.jobId}`)
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        try {
          for (const dir of [this.pendingDir, this.runningDir, this.failedDir, this.appliedDir]) {
            if (await fileExists(path.join(dir, fileName))) return 'duplicate'
          }
          await fs.rename(temp, target)
          await syncDirectory(this.pendingDir)
          return 'created'
        } finally {
          await fs.rmdir(lockPath).catch(() => {})
          await syncDirectory(this.locksDir)
        }
      }
      await fs.unlink(temp)
      await syncDirectory(this.pendingDir)
      for (const dir of [this.runningDir, this.failedDir, this.appliedDir]) {
        if (!(await fileExists(path.join(dir, fileName)))) continue
        await fs.unlink(target).catch(() => {})
        await syncDirectory(this.pendingDir)
        return 'duplicate'
      }
      return 'created'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'duplicate'
      throw error
    } finally {
      await fs.unlink(temp).catch(() => {})
    }
  }

  async claimNext(): Promise<MemoryJob | null> {
    const entries = (await fs.readdir(this.pendingDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    const now = Date.now()
    const parsed: Array<{ name: string; job: MemoryJob }> = []
    for (const name of entries) {
      const source = path.join(this.pendingDir, name)
      let job: MemoryJob
      try {
        job = await this.readPendingJob(source, name)
      } catch (error) {
        if (!(error instanceof CorruptJobError)) {
          // I/O 类故障：文件仍在磁盘上，留着下次轮询重试，不要隔离。
          debugLog('memory.claim-job-io-failed', `${name}: ${errorMessage(error)}`)
          continue
        }
        await this.quarantineCorruptJob(name)
        continue
      }
      if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now) continue
      parsed.push({ name, job })
    }
    parsed.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.job.jobId.localeCompare(b.job.jobId))
    for (const item of parsed) {
      const source = path.join(this.pendingDir, item.name)
      const target = path.join(this.runningDir, item.name)
      try {
        await fs.rename(source, target)
        await Promise.all([syncDirectory(this.pendingDir), syncDirectory(this.runningDir)])
        return item.job
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    return null
  }

  /** 读取并校验一个待办文件。只有内容层面的问题（JSON 语法、schema、文件名
   *  不匹配、超大）才抛 {@link CorruptJobError}，其余异常原样上抛。 */
  private async readPendingJob(source: string, name: string): Promise<MemoryJob> {
    const stat = await fs.stat(source)
    if (stat.size > MAX_JOB_BYTES) throw new CorruptJobError('Memory job exceeds the durable queue size limit')
    let raw: string
    try {
      raw = await fs.readFile(source, 'utf-8')
    } catch (error) {
      // EACCES/EISDIR 等读取故障文件还在：不能当成损坏内容隔离。
      throw new Error(`Cannot read memory job ${name}: ${errorMessage(error)}`, { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new CorruptJobError(`Memory job is not valid JSON: ${errorMessage(error)}`)
    }
    let job: MemoryJob
    try {
      job = validateJob(value)
    } catch (error) {
      throw new CorruptJobError(errorMessage(error))
    }
    if (`${job.jobId}.json` !== name) throw new CorruptJobError('Memory job ID does not match its filename')
    return job
  }

  /** 把损坏的待办文件搬进 failed/ 隔离，并尽力记录一条 run。隔离本身与簿记
   *  都是尽力而为：旧记录已存在时不覆盖（rename 在 POSIX 上会静默覆盖），
   *  run 日志写失败也不能让整个 `claimNext()` 中断。 */
  private async quarantineCorruptJob(name: string): Promise<void> {
    const source = path.join(this.pendingDir, name)
    const target = path.join(this.failedDir, name)
    try {
      if (await fileExists(target)) await fs.unlink(source).catch(() => {})
      else await fs.rename(source, target)
    } catch (error) {
      debugLog('memory.quarantine-job-failed', `${name}: ${errorMessage(error)}`)
    }
    await Promise.all([syncDirectory(this.pendingDir), syncDirectory(this.failedDir)]).catch(() => {})
    const jobId = name.slice(0, -'.json'.length)
    if (!SAFE_JOB_ID_RE.test(jobId)) return
    await this.appendRun({
      jobId,
      status: 'failed',
      durationMs: 0,
      tokens: 0,
      operations: 0,
      errorCategory: 'corrupt-job',
      completedAt: new Date().toISOString(),
    }).catch((error) => debugLog('memory.quarantine-run-log-failed', `${jobId}: ${errorMessage(error)}`))
  }

  async complete(job: MemoryJob): Promise<void> {
    await fs.unlink(path.join(this.runningDir, `${job.jobId}.json`)).catch(() => {})
    await fs.unlink(path.join(this.appliedDir, `${job.jobId}.json`)).catch(() => {})
    await Promise.all([syncDirectory(this.runningDir), syncDirectory(this.appliedDir)])
  }

  async isApplied(jobId: string): Promise<boolean> {
    if (!SAFE_JOB_ID_RE.test(jobId)) return false
    return fileExists(path.join(this.appliedDir, `${jobId}.json`))
  }

  async retry(job: MemoryJob, maxAttempts = RETRY_DELAYS_MS.length): Promise<'pending' | 'failed'> {
    const nextAttempt = job.attempt + 1
    if (nextAttempt >= Math.min(maxAttempts, RETRY_DELAYS_MS.length)) {
      await this.fail({ ...job, attempt: nextAttempt })
      return 'failed'
    }
    const delay = RETRY_DELAYS_MS[nextAttempt - 1] ?? RETRY_DELAYS_MS.at(-1)!
    const jitter = Math.floor(delay * Math.random() * 0.2)
    const updated: MemoryJob = {
      ...job,
      attempt: nextAttempt,
      nextAttemptAt: new Date(Date.now() + delay + jitter).toISOString(),
    }
    const running = path.join(this.runningDir, `${job.jobId}.json`)
    // running/ 下已经没有这个 job（`complete()` 已删除它）时绝不能凭空创建：
    // 否则会“复活”一条已完成的任务，导致重复抽取 / 重复提交记忆。
    if (!(await fileExists(running))) return 'pending'
    await atomicWriteFile(running, JSON.stringify(updated, null, 2) + '\n')
    await fs.rename(running, path.join(this.pendingDir, `${job.jobId}.json`))
    await Promise.all([syncDirectory(this.runningDir), syncDirectory(this.pendingDir)])
    return 'pending'
  }

  async fail(job: MemoryJob): Promise<void> {
    const running = path.join(this.runningDir, `${job.jobId}.json`)
    // 同 retry()：running/ 里已无此 job 时不新建，避免把已完成的任务重新落进 failed/。
    if (!(await fileExists(running))) return
    await atomicWriteFile(running, JSON.stringify(job, null, 2) + '\n')
    await fs.rename(running, path.join(this.failedDir, `${job.jobId}.json`)).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await fs.unlink(running).catch(() => {})
    })
    await Promise.all([syncDirectory(this.runningDir), syncDirectory(this.failedDir)])
  }

  async recoverRunning(): Promise<void> {
    const entries = (await fs.readdir(this.runningDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    for (const name of entries) {
      const source = path.join(this.runningDir, name)
      const target = path.join(this.pendingDir, name)
      if (await fileExists(target)) await fs.unlink(source).catch(() => {})
      else await fs.rename(source, target).catch(() => {})
    }
    await Promise.all([syncDirectory(this.runningDir), syncDirectory(this.pendingDir)])
  }

  async tryAcquireExtractorLock(): Promise<ExtractorLease | null> {
    return acquireFileLock(path.join(this.locksDir, 'extractor.lock'))
  }

  async appendRun(record: MemoryRunRecord): Promise<void> {
    const handle = await fs.open(this.recentRunsPath, 'a', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record) + '\n', 'utf-8')
      await handle.sync().catch(() => {})
    } finally {
      await handle.close()
    }
    await syncDirectory(path.dirname(this.recentRunsPath))
    const size = await fs
      .stat(this.recentRunsPath)
      .then((stat) => stat.size)
      .catch(() => 0)
    if (size <= RECENT_RUNS_MAX_BYTES) return
    const records = (await fs.readFile(this.recentRunsPath, 'utf-8')).trim().split('\n').slice(-RECENT_RUNS_MAX_RECORDS)
    await atomicWriteFile(this.recentRunsPath, records.join('\n') + '\n')
  }

  async counts(): Promise<{ pending: number; running: number; failed: number }> {
    const count = async (dir: string) =>
      (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).length
    const [pending, running, failed] = await Promise.all([
      count(this.pendingDir),
      count(this.runningDir),
      count(this.failedDir),
    ])
    return { pending, running, failed }
  }

  async lastRun(): Promise<MemoryRunRecord | undefined> {
    const raw = await fs.readFile(this.recentRunsPath, 'utf-8').catch(() => '')
    const line = raw.trim().split('\n').at(-1)
    if (!line) return undefined
    try {
      return JSON.parse(line) as MemoryRunRecord
    } catch {
      return undefined
    }
  }

  private async hasCompletedRun(jobId: string): Promise<boolean> {
    const raw = await fs.readFile(this.recentRunsPath, 'utf-8').catch(() => '')
    for (const line of raw.trim().split('\n')) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as Partial<MemoryRunRecord>
        if (
          record.jobId === jobId &&
          (record.status === 'success' || record.status === 'no-op' || record.status === 'warning')
        ) {
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }

  async nextPendingDelay(): Promise<number | null> {
    const entries = (await fs.readdir(this.pendingDir).catch(() => [])).filter((name) => name.endsWith('.json'))
    let earliest = Infinity
    for (const name of entries) {
      try {
        const job = validateJob(JSON.parse(await fs.readFile(path.join(this.pendingDir, name), 'utf-8')))
        const due = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : Date.now()
        earliest = Math.min(earliest, due)
      } catch {
        return 0
      }
    }
    return Number.isFinite(earliest) ? Math.max(0, earliest - Date.now()) : null
  }
}
