import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
// 245 MB installers can take much longer than a fixed 10-minute cap on slow
// links. Abort only when the stream stops producing data.
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
const PROGRESS_INTERVAL_MS = 200

export interface ReleaseArtifact {
  file: string
  size?: number
  sha256?: string
}

export interface ParsedRelease {
  version: string
  artifacts: ReleaseArtifact[]
  url?: string
  notes?: string
}

export interface UpdateDownloadResult {
  version: string
  filePath: string
  fileName: string
  bytes: number
  sha256: string
}

/** Validate the RELEASE.json body used by the update panel and by downloads. */
export function parseReleaseInfo(data: unknown): ParsedRelease {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  if (!record || typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('更新源缺少 version 字段')
  }
  const artifacts: ReleaseArtifact[] = []
  if (Array.isArray(record.artifacts)) {
    for (const entry of record.artifacts) {
      if (!entry || typeof entry !== 'object') continue
      const artifact = entry as Record<string, unknown>
      if (typeof artifact.file !== 'string' || !artifact.file.trim()) continue
      const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256.toLowerCase() : ''
      artifacts.push({
        file: path.basename(artifact.file.trim().replace(/\\/g, '/')),
        ...(typeof artifact.size === 'number' && Number.isFinite(artifact.size) ? { size: artifact.size } : {}),
        ...(/^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
      })
    }
  }
  return {
    version: record.version.trim(),
    artifacts,
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(typeof record.notes === 'string' ? { notes: record.notes } : {}),
  }
}

/** Choose the installer for this OS/arch. macOS prefers the dmg over the zip. */
export function pickUpdateArtifact(
  release: ParsedRelease,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseArtifact | null {
  const extension = platform === 'darwin' ? /\.(dmg|zip)$/i : platform === 'win32' ? /\.exe$/i : /\.AppImage$/i
  const candidates = release.artifacts.filter((artifact) => extension.test(artifact.file))
  if (candidates.length === 0) return null
  const archPattern = arch === 'arm64' ? /arm64/i : /(x64|x86_64|amd64)/i
  const matchingArch = candidates.filter((artifact) => archPattern.test(artifact.file))
  const pool = matchingArch.length > 0 ? matchingArch : candidates
  if (platform === 'darwin') {
    return pool.find((artifact) => /\.dmg$/i.test(artifact.file)) ?? pool[0] ?? null
  }
  return pool[0] ?? null
}

export function resolveArtifactUrl(feed: string, file: string): string {
  const base = new URL(feed)
  if (base.protocol !== 'https:') throw new Error('更新源必须是 https URL')
  const url = new URL(path.basename(file), base)
  if (url.protocol !== 'https:') throw new Error('安装包地址必须是 https URL')
  return url.toString()
}

export interface DownloadUpdateOptions {
  feed: string
  release: ParsedRelease
  platform: NodeJS.Platform
  arch: string
  destDir: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  maxBytes?: number
  /** Exact destination chosen by the user; defaults to destDir/<artifact name>. */
  destPath?: string
  /** User cancellation; aborts the feed request and the stream. */
  signal?: AbortSignal
  onProgress?: (progress: { receivedBytes: number; totalBytes?: number; bytesPerSecond?: number }) => void
}

/** Download the platform installer into `destDir` and verify its SHA-256. */
export async function downloadUpdateArtifact(options: DownloadUpdateOptions): Promise<UpdateDownloadResult> {
  const artifact = pickUpdateArtifact(options.release, options.platform, options.arch)
  if (!artifact) throw new Error('发布信息中没有适用于当前平台的安装包')
  if (!artifact.sha256) throw new Error('安装包缺少 sha256 校验值')
  const url = resolveArtifactUrl(options.feed, artifact.file)
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES
  const fetchImpl = options.fetchImpl ?? fetch

  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimedOut = false
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      controller.abort()
    }, DOWNLOAD_IDLE_TIMEOUT_MS)
  }
  resetIdle()

  try {
    const signals = options.signal ? [controller.signal, options.signal] : [controller.signal]
    const response = await fetchImpl(url, {
      signal: signals.length > 1 ? AbortSignal.any(signals) : controller.signal,
    })
    resetIdle()
    if (!response.ok) throw new Error(`下载安装包失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('安装包超过大小上限')
    if (!response.body) throw new Error('下载响应为空')
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined

    const finalPath = options.destPath
      ? path.resolve(options.destPath)
      : path.join(options.destDir, path.basename(artifact.file))
    const fileName = path.basename(finalPath)
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true })
    const tempPath = `${finalPath}.part`
    const hash = createHash('sha256')
    let bytes = 0
    const startedAt = Date.now()
    let lastEmit = 0
    const emitProgress = (force = false): void => {
      if (!options.onProgress) return
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      options.onProgress({
        receivedBytes: bytes,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        bytesPerSecond: bytes > 0 ? Math.round(bytes / Math.max(0.001, (now - startedAt) / 1000)) : 0,
      })
    }
    emitProgress(true)
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        resetIdle()
        if (bytes > maxBytes) {
          callback(new Error('安装包超过大小上限'))
          return
        }
        hash.update(chunk)
        emitProgress()
        callback(null, chunk)
      },
    })

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        fs.createWriteStream(tempPath),
      )
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true })
      throw error
    }

    emitProgress(true)
    const sha256 = hash.digest('hex')
    if (sha256 !== artifact.sha256) {
      await fs.promises.rm(tempPath, { force: true })
      throw new Error('安装包校验失败（sha256 不一致）')
    }

    await fs.promises.rm(finalPath, { force: true })
    await fs.promises.rename(tempPath, finalPath)
    return { version: options.release.version, filePath: finalPath, fileName, bytes, sha256 }
  } catch (error) {
    if (options.signal?.aborted) throw new Error('下载已取消')
    if (idleTimedOut) throw new Error(`下载超时：${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒内没有收到新数据`)
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}
