// @x-code-cli/core — Local audio transcription via whisper.cpp
//
// Transcribes local MP3, WAV, FLAC, OGG Vorbis and M4A files using
// @fugood/whisper.node — a native Node.js binding of whisper.cpp.
// Returns timestamped text segments; only the text is sent to the LLM, never
// the raw audio. The whisper model is auto-downloaded from Hugging Face on
// first use and cached under ~/.x-code/whisper-models/.
//
// Platform support:
//   macOS ARM64  — Metal GPU acceleration
//   macOS x86_64 — CPU only
//   Windows x64  — Vulkan GPU acceleration (optional)
//   Linux x64    — CPU (Vulkan/CUDA optional)
//
// When the native binding is unavailable (unsupported OS/arch, broken install),
// transcribeAudio returns a descriptive error string instead of throwing —
// callers can surface it to the model and the user.
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

// ── Supported audio formats ──────────────────────────────────────────────
export function isAudioFile(filePath: string): boolean {
  return isSupportedAudioPath(filePath)
}

/** Whisper model variants, ordered small→large.
 *  Default is `tiny` — only ~75 MB to download, fast on CPU, and good
 *  enough for a CLI assistant. Users who need better accuracy for
 *  non-English or complex audio can override via env or option. */
const DEFAULT_MODEL: WhisperModelName = (process.env.X_CODE_WHISPER_MODEL as WhisperModelName | undefined) ?? 'tiny'
const HUGGINGFACE_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}`
const DEFAULT_MIRROR_BASE = 'https://hf-mirror.com'
/** How long to wait for response headers before falling back to the mirror. */
const MODEL_HEADER_TIMEOUT_MS = 20_000
export { MAX_AUDIO_DECODED_PCM_BYTES, MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_SOURCE_BYTES }

/** Candidate download URLs, in order. Hugging Face is unreachable on some
 *  networks (notably mainland China); hf-mirror serves the same revision.
 *  X_CODE_WHISPER_MODEL_URL overrides the list entirely. */
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

/** Model files shipped inside the desktop app bundle. Read-only; used before
 *  the user cache and any download so first-run voice input works offline. */
function bundledModelPath(model: WhisperModelName): string | null {
  const dir = process.env.X_CODE_WHISPER_BUNDLED_DIR?.trim()
  if (!dir) return null
  return path.join(dir, WHISPER_MODELS[model].filename)
}

// ── Model download ───────────────────────────────────────────────────────

// Per-chunk stall timeout: if no data arrives for this long we assume
// the connection is dead.  This is NOT a total download timeout — a
// slow-but-steady 75 MB download is fine; only a fully stalled network
// triggers this.
const STALL_TIMEOUT_MS = 30_000
const MODEL_LOCK_WAIT_MS = 30 * 60_000

interface EnsureModelOptions {
  abortSignal?: AbortSignal
  /** Called for every notable step (start download, loading model, ready).
   *  Callers choose how to surface these: tool-progress updates the same
   *  spinner line in-place (readFile), while file-ingest appends a new
   *  message per call. To avoid flooding the UI with a new line per 10%,
   *  intermediate download percentages are only sent to debugLog. */
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
      // Fall through to the cache/download path.
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

    // The fixed temporary name is safe while the cross-process lock is held;
    // removing it also recovers an interrupted download from an earlier run.
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
          // The timer only guards connection/header setup; clearing it keeps a
          // slow-but-healthy 75 MB body download from being aborted midway.
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

// ── Transcription result ─────────────────────────────────────────────────

export interface TranscribeSegment {
  /** Start time in milliseconds */
  t0: number
  /** End time in milliseconds */
  t1: number
  /** Transcribed text for this segment */
  text: string
}

export interface TranscribeAudioResult {
  /** Full transcription text */
  text: string
  /** Timestamped segments */
  segments: TranscribeSegment[]
  /** Detected/specified language */
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

/** Format transcription result as timestamped text suitable for LLM context. */
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

// ── Public API ───────────────────────────────────────────────────────────

/** Check whether whisper.node native binding is available on this platform. */
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
  /** Override the default model. Defaults to 'tiny'. */
  model?: WhisperModelName
  /** Force a specific language (ISO 639-1 code, e.g. 'en', 'zh'). Auto-detect if omitted. */
  language?: string
  /** Abort signal to cancel transcription. */
  abortSignal?: AbortSignal
  /** Progress callback (0–100). */
  onProgress?: (pct: number) => void
  /** UI notice callback — displayed to the user for download progress, model loading, etc. */
  onNotice?: (message: string) => void
}

/** Transcribe a local audio file, returning timestamped text segments.
 *  Never throws — returns descriptive error text on failure so callers
 *  can surface it directly to the model. */
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

    // onNotice fires for every progress tick — fine for tool-progress
    // (overwrites the same spinner line), but file-ingest appends a new
    // UI message each time. So use onNotice for key milestones only
    // when no dedicated progress sink exists; downstream download ticks
    // always go to onNotice so the readFile spinner stays live.
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
