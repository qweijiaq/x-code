// @x-code-cli/core — 基于 whisper.cpp 的本地音频转录
//
// 使用 @fugood/whisper.node（whisper.cpp 的原生 Node.js 绑定）转录
// 本地 MP3、WAV、FLAC、OGG Vorbis 和 M4A 文件。
// 返回带时间戳的文本片段；只有文本会被发送给 LLM，绝不会发送原始音频。
// whisper 模型在首次使用时自动从 Hugging Face 下载，并缓存到
// ~/.x-code/whisper-models/ 下。
//
// 平台支持：
//   macOS ARM64  — Metal GPU 加速
//   macOS x86_64 — 仅 CPU
//   Windows x64  — Vulkan GPU 加速（可选）
//   Linux x64    — CPU（Vulkan/CUDA 可选）
//
// 当原生绑定不可用时（不受支持的 OS/arch、安装损坏），
// transcribeAudio 会返回描述性错误字符串而不是抛出异常——
// 调用方可将其直接呈现给模型和用户。
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { debugLog, errorMessage, userXcodeDir } from '../utils.js'
import { FileSizeLimitError, readFileWithinLimit } from '../utils/bounded-read.js'
import { acquireFileLock } from '../utils/file-lock.js'
import { isSupportedAudioPath } from './audio-formats.js'
import { MAX_AUDIO_DECODED_PCM_BYTES, MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_SOURCE_BYTES } from './audio-limits.js'
import { WHISPER_MODELS, WHISPER_MODEL_REVISION } from './audio-transcribe-models.js'
import type { WhisperModelName, WhisperModelSpec } from './audio-transcribe-models.js'
import {
  WhisperProcessError,
  disposeWhisperProcess,
  prepareWhisperAudio,
  probeWhisperRuntime,
  runWhisperTranscription,
} from './audio-transcribe-runner.js'

// ── 支持的音频格式 ────────────────────────────────────────────────────────
export function isAudioFile(filePath: string): boolean {
  return isSupportedAudioPath(filePath)
}

/** Whisper 模型变体，按小→大排序。
 *  默认是 `tiny` —— 只需下载约 75 MB，CPU 上速度快，
 *  对 CLI 助手来说足够好。需要更好准确度（非英语或复杂音频）的
 *  用户可通过环境变量或选项覆盖。 */
const DEFAULT_MODEL: WhisperModelName = (process.env.X_CODE_WHISPER_MODEL as WhisperModelName | undefined) ?? 'tiny'
const HUGGINGFACE_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}`
const DEFAULT_MIRROR_BASE = 'https://hf-mirror.com'
/** 在回退到镜像之前等待响应头的时长。 */
const MODEL_HEADER_TIMEOUT_MS = 20_000
export { MAX_AUDIO_DECODED_PCM_BYTES, MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_SOURCE_BYTES }

/** 候选下载 URL，按顺序排列。Hugging Face 在某些网络下不可达
 *  （尤其是中国大陆）；hf-mirror 提供相同的 revision。
 *  X_CODE_WHISPER_MODEL_URL 会整体覆盖该列表。 */
function whisperModelUrls(filename: string): string[] {
  const custom = process.env.X_CODE_WHISPER_MODEL_URL?.trim()
  if (custom) return [custom]
  const mirror = (process.env.X_CODE_WHISPER_MIRROR?.trim() || DEFAULT_MIRROR_BASE).replace(/\/+$/, '')
  return [
    `${HUGGINGFACE_BASE}/${filename}`,
    `${mirror}/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/${filename}`,
  ]
}

function modelsDir(): string {
  return path.join(userXcodeDir(), 'whisper-models')
}

function modelPath(model: WhisperModelName): string {
  return path.join(modelsDir(), WHISPER_MODELS[model].filename)
}

/** 随桌面应用 bundle 一起分发的模型文件。只读；优先于用户缓存和
 *  任何下载使用，这样首次运行的语音输入也能离线工作。 */
function bundledModelPath(model: WhisperModelName): string | null {
  const dir = process.env.X_CODE_WHISPER_BUNDLED_DIR?.trim()
  if (!dir) return null
  return path.join(dir, WHISPER_MODELS[model].filename)
}

// ── 模型下载 ─────────────────────────────────────────────────────────────

// 每个 chunk 的停滞超时：若这么久都没有数据到达，我们就认为
// 连接已死。这不是总下载超时——缓慢但稳定的 75 MB 下载没有问题；
// 只有完全停滞的网络才会触发它。
const STALL_TIMEOUT_MS = 30_000
const MODEL_LOCK_WAIT_MS = 30 * 60_000

interface EnsureModelOptions {
  abortSignal?: AbortSignal
  /** 每个值得注意的步骤都会被调用（开始下载、加载模型、就绪）。
   *  调用方自行选择如何呈现：tool-progress 就地覆盖同一条 spinner 行
   *  （readFile），而 file-ingest 每次调用追加一条新消息。
   *  为避免每 10% 就新增一行刷屏，中间的下载百分比只发给 debugLog。 */
  onProgress?: (message: string) => void
}

interface VerifiedModelIdentity {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
}

const verifiedModels = new Map<string, VerifiedModelIdentity>()
const MODEL_HASH_CHUNK_BYTES = 1024 * 1024

async function validateModelFile(
  filePath: string,
  spec: WhisperModelSpec,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  abortSignal?.throwIfAborted()
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const before = await handle.stat()
    const cached = verifiedModels.get(filePath)
    if (
      cached &&
      cached.size === before.size &&
      cached.mtimeMs === before.mtimeMs &&
      cached.ctimeMs === before.ctimeMs &&
      cached.ino === before.ino
    ) {
      return true
    }
    if (before.size !== spec.bytes) return false

    const hash = createHash('sha256')
    let position = 0
    while (position < spec.bytes) {
      abortSignal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(MODEL_HASH_CHUNK_BYTES, spec.bytes - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) return false
      hash.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return false
    if (hash.digest('hex') !== spec.sha256) return false
    verifiedModels.set(filePath, {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      ino: after.ino,
    })
    return true
  } catch {
    abortSignal?.throwIfAborted()
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function ensureModel(model: WhisperModelName, options?: EnsureModelOptions): Promise<string> {
  const dest = modelPath(model)
  const spec = WHISPER_MODELS[model]
  const localOverride = process.env.X_CODE_WHISPER_MODEL_PATH?.trim()
  if (localOverride) {
    try {
      const stat = await fs.stat(localOverride)
      if (stat.isFile() && stat.size > 0) {
        options?.onProgress?.(`Using Whisper model from X_CODE_WHISPER_MODEL_PATH`)
        return localOverride
      }
    } catch {
      // 回退到缓存/下载路径。
    }
  }
  const bundled = bundledModelPath(model)
  if (bundled && (await validateModelFile(bundled, spec, options?.abortSignal))) {
    options?.onProgress?.(`Using bundled Whisper model "${model}"`)
    return bundled
  }
  if (await validateModelFile(dest, spec, options?.abortSignal)) {
    debugLog('audio-transcribe', `model cache hit: ${dest}`)
    options?.onProgress?.(`Using cached Whisper model "${model}"`)
    return dest
  }

  await fs.mkdir(modelsDir(), { recursive: true })
  const lease = await acquireFileLock(`${dest}.lock`, {
    waitMs: MODEL_LOCK_WAIT_MS,
    timeoutError: `Timed out waiting for another process to download whisper model ${model}`,
    signal: options?.abortSignal,
  })
  if (!lease) throw new Error(`Could not acquire the whisper model download lock for ${model}`)
  try {
    if (await validateModelFile(dest, spec, options?.abortSignal)) {
      debugLog('audio-transcribe', `model cache filled by another process: ${dest}`)
      options?.onProgress?.(`Using cached Whisper model "${model}"`)
      return dest
    }
    verifiedModels.delete(dest)
    await fs.rm(dest, { force: true })

    // 在跨进程锁被持有的情况下，固定临时名是安全的；
    // 删除它还能回收早前一次运行中被中断的下载。
    const tmpDest = `${dest}.tmp`
    await fs.rm(tmpDest, { recursive: true, force: true })

    const filename = spec.filename
    const urls = whisperModelUrls(filename)

    const curlCmd = (url: string): string =>
      process.platform === 'win32'
        ? `  curl.exe -L -o "${dest}" "${url}"\n` +
          `  # Or in PowerShell:\n` +
          `  Invoke-WebRequest -Uri "${url}" -OutFile "${dest}"`
        : `  curl -L -o "${dest}" "${url}"`
    const manualHint =
      `You can also download it manually (the mirror usually works where huggingface.co is blocked):\n` +
      urls.map(curlCmd).join('\n') +
      `\nOr set X_CODE_WHISPER_MODEL_PATH=/path/to/ggml-${model}.bin to reuse an existing file.`

    let lastError: Error | null = null
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[attempt]
      const host = (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })()
      debugLog('audio-transcribe', `downloading model ${filename} from ${host}`)
      options?.onProgress?.(
        attempt === 0
          ? `First-time setup: downloading whisper model "${model}" — press Esc to cancel.\n${manualHint}`
          : `Primary download failed; trying mirror ${host}…`,
      )

      let downloadedBytes = 0
      let lastPctReported = -1
      const downloadHash = createHash('sha256')
      let stallError: Error | null = null
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const stallController = new AbortController()
      const resetStallTimer = () => {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          stallError = new Error(`Download stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s.`)
          stallController.abort(stallError)
        }, STALL_TIMEOUT_MS)
        stallTimer.unref()
      }

      try {
        const headerController = new AbortController()
        const headerTimer = setTimeout(() => {
          headerController.abort(new Error(`No response from ${host} within ${MODEL_HEADER_TIMEOUT_MS / 1000}s`))
        }, MODEL_HEADER_TIMEOUT_MS)
        const headerSignal = options?.abortSignal
          ? AbortSignal.any([options.abortSignal, headerController.signal])
          : headerController.signal
        let response: Response
        try {
          response = await fetch(url, { signal: headerSignal })
        } finally {
          // 该定时器只守护连接/头部建立；清除它能避免
          // 缓慢但健康的 75 MB body 下载被中途中止。
          clearTimeout(headerTimer)
        }
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }

        const declaredBytes = Number(response.headers.get('content-length') || 0)
        if (declaredBytes > 0 && declaredBytes !== spec.bytes) {
          throw new Error(`returned ${declaredBytes} bytes; expected ${spec.bytes}`)
        }
        const downloadSignal = options?.abortSignal
          ? AbortSignal.any([options.abortSignal, stallController.signal])
          : stallController.signal
        const progress = new Transform({
          transform(chunk, _encoding, callback) {
            resetStallTimer()
            downloadedBytes += chunk.byteLength
            if (downloadedBytes > spec.bytes) {
              callback(new Error(`Whisper model download exceeds the expected ${spec.bytes}-byte limit`))
              return
            }
            downloadHash.update(chunk)
            const pct = Math.floor((downloadedBytes / spec.bytes) * 100)
            if (pct >= lastPctReported + 5) {
              lastPctReported = pct
              const mb = (downloadedBytes / 1024 / 1024).toFixed(1)
              const totalMb = (spec.bytes / 1024 / 1024).toFixed(1)
              debugLog('audio-transcribe', `download progress: ${mb}/${totalMb} MB (${pct}%)`)
              options?.onProgress?.(`Downloading whisper model: ${mb}/${totalMb} MB (${pct}%)`)
            }
            callback(null, chunk)
          },
        })

        resetStallTimer()
        const source = Readable.fromWeb(
          response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        )
        await pipeline(source, progress, createWriteStream(tmpDest), { signal: downloadSignal })
        options?.abortSignal?.throwIfAborted()
        if (downloadedBytes !== spec.bytes) {
          throw new Error(`download ended at ${downloadedBytes} bytes; expected ${spec.bytes}`)
        }
        if (downloadHash.digest('hex') !== spec.sha256) {
          throw new Error('checksum verification failed; the response was not cached')
        }
        await fs.rename(tmpDest, dest)
        verifiedModels.delete(dest)
        if (!(await validateModelFile(dest, spec, options?.abortSignal))) {
          await fs.rm(dest, { force: true })
          throw new Error('post-download verification failed')
        }
        debugLog('audio-transcribe', `model saved to ${dest}`)
        options?.onProgress?.(`Whisper model downloaded successfully`)
        return dest
      } catch (error) {
        await fs.rm(tmpDest, { recursive: true, force: true }).catch(() => undefined)
        if (options?.abortSignal?.aborted) throw error
        lastError = stallError ?? (error instanceof Error ? error : new Error(String(error)))
        debugLog('audio-transcribe', `download attempt from ${host} failed: ${lastError.message}`)
      } finally {
        clearTimeout(stallTimer)
      }
    }

    throw new Error(
      `Failed to download whisper model ${filename}. Last error: ${lastError?.message ?? 'unknown'}\n${manualHint}`,
    )
  } finally {
    await lease.release()
  }
}

// ── 转录结果 ─────────────────────────────────────────────────────────────

export interface TranscribeSegment {
  /** 起始时间（毫秒） */
  t0: number
  /** 结束时间（毫秒） */
  t1: number
  /** 该片段的转录文本 */
  text: string
}

export interface TranscribeAudioResult {
  /** 完整转录文本 */
  text: string
  /** 带时间戳的片段 */
  segments: TranscribeSegment[]
  /** 检测到/指定的语言 */
  language?: string
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const millis = ms % 1000

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** 把转录结果格式化为适合作为 LLM 上下文的带时间戳文本。 */
export function formatTranscription(result: TranscribeAudioResult, filePath: string): string {
  const header = `Audio transcription: ${filePath}`
  const langLine = result.language ? `Language: ${result.language}` : ''

  if (result.segments.length === 0) {
    return [header, langLine, '', result.text].filter(Boolean).join('\n')
  }

  const lines = result.segments.map(
    (seg) => `[${formatTimestamp(seg.t0)} --> ${formatTimestamp(seg.t1)}] ${seg.text.trim()}`,
  )

  return [header, langLine, '', ...lines].filter(Boolean).join('\n')
}

async function removeModelIfInvalid(model: WhisperModelName): Promise<void> {
  const dest = modelPath(model)
  verifiedModels.delete(dest)
  const lease = await acquireFileLock(`${dest}.lock`, {
    waitMs: MODEL_LOCK_WAIT_MS,
    timeoutError: `Timed out rechecking whisper model ${model}`,
  })
  if (!lease) return
  try {
    if (!(await validateModelFile(dest, WHISPER_MODELS[model]))) await fs.rm(dest, { force: true })
  } finally {
    await lease.release()
  }
}

async function stageAudioFile(
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<{ directory: string; path: string }> {
  const bytes = await readFileWithinLimit(filePath, MAX_AUDIO_SOURCE_BYTES, abortSignal)
  abortSignal?.throwIfAborted()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-audio-'))
  const stagedPath = path.join(directory, `input${path.extname(filePath).toLowerCase() || '.audio'}`)
  try {
    await fs.writeFile(stagedPath, bytes, { signal: abortSignal })
    return { directory, path: stagedPath }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

// ── 公共 API ─────────────────────────────────────────────────────────────

/** 检查 whisper.node 原生绑定在当前平台是否可用。 */
export async function isWhisperAvailable(abortSignal?: AbortSignal): Promise<boolean> {
  try {
    await probeWhisperRuntime({ abortSignal })
    return true
  } catch {
    abortSignal?.throwIfAborted()
    disposeWhisperProcess()
    return false
  }
}

export interface TranscribeOptions {
  /** 覆盖默认模型。默认是 'tiny'。 */
  model?: WhisperModelName
  /** 强制指定语言（ISO 639-1 代码，例如 'en'、'zh'）。省略则自动检测。 */
  language?: string
  /** 取消转录的中止信号。 */
  abortSignal?: AbortSignal
  /** 进度回调（0–100）。 */
  onProgress?: (pct: number) => void
  /** UI 通知回调 —— 用于向用户展示下载进度、模型加载等。 */
  onNotice?: (message: string) => void
}

/** 转录本地音频文件，返回带时间戳的文本片段。
 *  绝不抛异常——失败时返回描述性错误文本，调用方可
 *  直接呈现给模型。 */
export async function transcribeAudio(
  filePath: string,
  options?: TranscribeOptions,
): Promise<TranscribeAudioResult | string> {
  const model = options?.model ?? DEFAULT_MODEL
  let stagedDirectory: string | null = null
  if (options?.abortSignal?.aborted) return '[Audio transcription was cancelled.]'
  if (!Object.hasOwn(WHISPER_MODELS, model)) {
    return `[Audio transcription failed: unknown Whisper model "${model}".]`
  }

  try {
    debugLog('audio-transcribe', `starting transcription: ${filePath} (model: ${model})`)

    const staged = await stageAudioFile(filePath, options?.abortSignal)
    stagedDirectory = staged.directory

    const available = await isWhisperAvailable(options?.abortSignal)
    if (!available) {
      return (
        `[Audio transcription unavailable: the whisper.node native binding ` +
        `could not be loaded on this platform (${process.platform}/${process.arch}). ` +
        `Supported: macOS ARM64, Windows x64, Linux x64/ARM64. ` +
        `Install @fugood/whisper.node and its platform package to enable local audio transcription.]`
      )
    }

    const pcmPath = path.join(staged.directory, 'decoded.pcm')
    await prepareWhisperAudio(staged.path, pcmPath, { abortSignal: options?.abortSignal })

    // onNotice 在每次进度 tick 都会触发——对 tool-progress 来说没问题
    // （覆盖同一条 spinner 行），但 file-ingest 每次都会追加一条新的
    // UI 消息。所以在没有专用进度接收器时，只用 onNotice 报告关键里程碑；
    // 下游的下载 tick 始终走 onNotice，好让 readFile 的 spinner 保持活跃。
    const targetModel = await ensureModel(model, {
      abortSignal: options?.abortSignal,
      onProgress: options?.onNotice,
    })
    options?.abortSignal?.throwIfAborted()
    options?.onNotice?.(`Transcribing audio: ${path.basename(filePath)}…`)
    let lastNoticeProgress = -5
    const result = await runWhisperTranscription(targetModel, pcmPath, {
      language: options?.language,
      abortSignal: options?.abortSignal,
      onProgress: (progress) => {
        options?.onProgress?.(progress)
        const percentage = Math.max(0, Math.min(100, Math.floor(progress / 5) * 5))
        if (percentage <= lastNoticeProgress) return
        lastNoticeProgress = percentage
        options?.onNotice?.(`Transcribing audio: ${path.basename(filePath)} (${percentage}%)`)
      },
      onNotice: options?.onNotice,
    })

    if (result.isAborted) {
      return '[Audio transcription was cancelled.]'
    }

    debugLog('audio-transcribe', `done: ${result.segments.length} segments, lang=${result.language ?? 'auto'}`)

    return {
      text: result.result,
      segments: result.segments.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text })),
      language: result.language,
    }
  } catch (err) {
    if (options?.abortSignal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return '[Audio transcription was cancelled.]'
    }
    if (err instanceof FileSizeLimitError) {
      return (
        `[Audio transcription failed: source file is too large (${err.observedBytes} bytes, ` +
        `cap ${err.limitBytes} bytes).]`
      )
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `[Audio transcription failed: file not found — ${filePath}]`
    }
    if (err instanceof WhisperProcessError && err.phase === 'initialize') {
      await removeModelIfInvalid(model).catch(() => {})
    }
    const msg = errorMessage(err)
    debugLog('audio-transcribe', `error: ${msg}`)
    return `[Audio transcription failed: ${msg}]`
  } finally {
    if (stagedDirectory) await fs.rm(stagedDirectory, { recursive: true, force: true }).catch(() => {})
  }
}
