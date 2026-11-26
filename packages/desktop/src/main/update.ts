import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
// 245 MB 安装器在慢速链路上可能远超过固定的 10 分钟上限。
// 只在流停止产出数据时才中止。
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

/** 校验更新面板和下载使用的 RELEASE.json 体。 */
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

/** 选择此 OS/arch 的安装器。macOS 优先选择 dmg 而非 zip。 */
export function pickUpdateArtifact(
  release: ParsedRelease,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseArtifact | null {
  const extension = platform === 'darwin' ? /\.(dmg|zip)$/i : platform === 'win32' ? /\.exe$/i : /\.AppImage$/i
  const candidates = release.artifacts.filter((artifact) => extension.test(artifact.file))
  if (candidates.length === 0) return null
  // Linux/Windows 发布包里 arm64 常写作 `aarch64`，只匹配 `arm64` 会让
  // matchingArch 为空。
  const armPattern = /(arm64|aarch64)/i
  const x64Pattern = /(x64|x86_64|amd64)/i
  const archPattern = arch === 'arm64' || arch === 'aarch64' ? armPattern : x64Pattern
  const matchingArch = candidates.filter((artifact) => archPattern.test(artifact.file))
  // 明确标了别的架构时不能静默回退到 candidates[0]：那会把 x64 包装给 arm64
  // 用户（Linux 上 AppImage 根本无法运行，还会先报一条令人困惑的「校验失败」）。
  // 只有候选完全没有架构标记（universal 包）时才允许回退。
  const anyArchTagged = candidates.some((artifact) => armPattern.test(artifact.file) || x64Pattern.test(artifact.file))
  if (matchingArch.length === 0 && anyArchTagged) return null
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
  /** 可注入用于测试；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch
  maxBytes?: number
  /** 用户选择的精确目标；默认 destDir/<artifact name>。 */
  destPath?: string
  /** 用户取消；中止源请求和流。 */
  signal?: AbortSignal
  onProgress?: (progress: { receivedBytes: number; totalBytes?: number; bytesPerSecond?: number }) => void
}

/** 把平台安装器下载到 `destDir` 并校验其 SHA-256。 */
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
    // fetch 默认 redirect: 'follow'：一旦服务端 302 到 http:// 或第三方主机，
    // https-only 的约束就被绕过。这里对最终 URL 再校验一次协议。
    // 空 url 表示实现没有提供最终地址（测试桩/精简 fetch），此时依赖调用方
    // 已校验的 feed + resolveArtifactUrl 的 https 检查。
    if (response.url && !response.url.startsWith('https://')) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('安装包地址被重定向到非 https 地址，已中止下载')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`下载安装包失败：HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      // 这条路径一定拿到了 body：不关掉响应流会占着连接直到 GC。
      await response.body?.cancel().catch(() => undefined)
      throw new Error('安装包超过大小上限')
    }
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
    if (idleTimedOut)
      throw new Error(`下载超时：${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒内没有收到新数据`, { cause: error })
    // 只有真正的 abort 才能归因为「用户取消」：否则校验失败 / 写盘错误也会被
    // 报成取消，排障时误导。
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    if (options.signal?.aborted && aborted) throw new Error('下载已取消', { cause: error })
    // fetch 层的网络错误（DNS/TLS/连接断开）是 TypeError，原文对用户不可读。
    if (error instanceof TypeError) {
      throw new Error(`下载安装包失败：网络错误（${url}）：${error.message}`, { cause: error })
    }
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}
