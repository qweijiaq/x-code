// @x-code-cli/core — 针对特定提供方的兼容性补丁
import type { ModelMessage } from 'ai'

import {
  buildUnsupportedImageNotice,
  capabilitiesOf,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { truncateUtf8 } from '../utils.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  buildImageProcessingFailureNotice,
  compressImage,
} from '../utils/image-compress.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { ocrImage } from './image-ocr.js'
import { toolMediaUserMessage } from './messages.js'
import type { ToolImage } from './messages.js'

// ── 面向纯文本模型的图片/PDF 降级 ───────────────────────────────────────
//
// 如果当前模型无法接收图片/文件片段（例如 DeepSeek V4 Pro，以及未显式开启的 `custom`），
// 就遍历下一轮要发送的每条消息，把每个二进制片段替换成该提供方能够接受的内容。
//
// 两种情况：
//   - 用户消息：ImagePart / FilePart → 带 OCR 文本的 TextPart。
//   - 工具结果消息：带标签图片 `file` 条目（以及旧式 `image-data`）的 `content` 值数组
//     → 同一个 content 数组，但图片条目被替换为 `text` 条目（经 OCR）。
//
// OCR 通过 tesseract.js 在本地运行。结果按内容哈希做记忆化，
// 这样跨轮次重复发送同一张图片时，不必每轮都重跑 OCR。

type MaybeOutput = { type?: string; value?: unknown; filename?: string }

interface ToolContentEntry {
  type?: string
  data?: string | { type?: string; data?: unknown }
  mediaType?: string
  text?: string
  filename?: string
  [key: string]: unknown
}

function isToolImageEntry(entry: ToolContentEntry): boolean {
  if (entry.type === 'file') {
    const mediaType = entry.mediaType?.toLowerCase() ?? ''
    return mediaType === 'image' || mediaType.startsWith('image/')
  }
  return entry.type === 'image-data' || (entry.type === 'media' && (entry.mediaType?.startsWith('image/') ?? false))
}

function toolImageBase64(entry: ToolContentEntry): string | undefined {
  if (entry.type === 'file') {
    if (typeof entry.data === 'string') return entry.data
    return entry.data?.type === 'data' && typeof entry.data.data === 'string' ? entry.data.data : undefined
  }
  return typeof entry.data === 'string' ? entry.data : undefined
}

function withToolImageData(
  entry: ToolContentEntry,
  data: string,
  mediaType: string,
  filename?: string,
): ToolContentEntry {
  return entry.type === 'file'
    ? { ...entry, data: { type: 'data', data }, mediaType, filename }
    : { ...entry, data, mediaType, filename }
}

/**
 * 针对多模态 Chat Completions 提供方，把图片片段从工具结果中挪出来。
 * 它们的 `tool` 角色只接受文本，而紧随其后的 `user` 角色接受带类型的图片内容。
 * 这也能覆盖 AI SDK 自动执行的工具（如 readFile，它们绕过了 deliverToolImages）。
 *
 * 来自一个连续工具结果组的图片，会在整组之后变成一条用户消息，
 * 从而保持严格的 assistant → 所有工具结果的顺序。
 * 只返回请求用的投影，不修改规范历史，这样过期截图裁剪仍能移除旧的二进制负载。
 */
export function reattachToolResultImagesForProvider(messages: ModelMessage[], modelId: string): ModelMessage[] {
  const caps = capabilitiesOf(modelId)
  if (caps.toolImageTransport !== 'user-message' || !caps.image || !modelSupportsVision(modelId)) {
    return messages
  }

  const rewritten: ModelMessage[] = []
  let pendingImages: ToolImage[] = []
  let movedAny = false

  const flushImages = () => {
    if (pendingImages.length === 0) return
    rewritten.push(toolMediaUserMessage(pendingImages))
    pendingImages = []
  }

  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      flushImages()
      rewritten.push(message)
      continue
    }

    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const output = (part as { output?: MaybeOutput }).output
      if (!output || output.type !== 'content' || !Array.isArray(output.value)) return part

      const retained: unknown[] = []
      for (const entry of output.value as ToolContentEntry[]) {
        const data = toolImageBase64(entry)
        if (isToolImageEntry(entry) && data && typeof entry.mediaType === 'string') {
          pendingImages.push({ data, mediaType: entry.mediaType })
          movedAny = true
        } else {
          retained.push(entry)
        }
      }

      if (retained.length === output.value.length) return part
      changed = true
      let nextOutput: MaybeOutput
      if (
        retained.length > 0 &&
        retained.every(
          (entry) => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === 'text',
        )
      ) {
        nextOutput = {
          ...output,
          type: 'text',
          value: retained
            .map((entry) => (entry as { text?: string }).text ?? '')
            .filter(Boolean)
            .join('\n'),
        }
      } else if (retained.length > 0) {
        nextOutput = { ...output, value: retained }
      } else {
        nextOutput = {
          ...output,
          type: 'text',
          value: '[Tool returned media attached in the following message]',
        }
      }
      return { ...part, output: nextOutput }
    })

    rewritten.push(changed ? ({ ...message, content } as ModelMessage) : message)
  }

  flushImages()
  return movedAny ? rewritten : messages
}

const ocrCache = new LruCache<string>({ maxEntries: 50 })
const MAX_COMPAT_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_COMPAT_OCR_BYTES = 256 * 1024

type CompatImageProjection =
  | { ok: true; data: Buffer; mimeType: string; changed: boolean }
  | { ok: false; notice: string }

const compatImageCache = new LruCache<CompatImageProjection>({ maxEntries: 20 })

async function normalizeCompatImage(
  buffer: Buffer,
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<CompatImageProjection> {
  abortSignal?.throwIfAborted()
  if (buffer.length > MAX_COMPAT_IMAGE_SOURCE_BYTES) {
    return {
      ok: false,
      notice: `[image omitted: legacy payload exceeds the ${MAX_COMPAT_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB local image limit]`,
    }
  }

  // 兼容性校验在每次请求投影时都会运行。使用完整摘要可以让重复的会话图片复用
  // 已解码结果，同时又不会让“同尺寸、同头部”的负载共享同一个安全判定。
  const key = `${modelId}:${bufferFingerprint(buffer)}`
  const cached = compatImageCache.get(key)
  if (cached) return cached

  const sniffedMime = await sniffImageMime(buffer)
  if (!sniffedMime?.startsWith('image/')) {
    return { ok: false, notice: '[image omitted: legacy payload is not a recognized image]' }
  }
  const compressed = await compressImage(buffer, sniffedMime, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal,
  })
  const mimeType = normalizeImageMime(compressed.mimeType)
  let result: CompatImageProjection
  if (!isModelAcceptedImage(mimeType, { modelId, animated: compressed.animated })) {
    result = {
      ok: false,
      notice: buildUnsupportedImageNotice(mimeType, 'legacy session payload', modelId, compressed.animated),
    }
  } else if (
    compressed.failureReason ||
    compressed.data.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    result = { ok: false, notice: buildImageProcessingFailureNotice('legacy session payload', compressed) }
  } else {
    result = { ok: true, data: compressed.data, mimeType, changed: compressed.changed }
  }
  compatImageCache.set(key, result)
  return result
}

function normalizedImageFilename(filename: string | undefined, mimeType: string): string | undefined {
  if (!filename) return undefined
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)
  const stem = filename.replace(/\.[^./\\]+$/, '')
  return `${stem}.${extension}`
}

async function ocrBuffer(buffer: Buffer, abortSignal?: AbortSignal): Promise<string> {
  if (buffer.length > MAX_COMPAT_IMAGE_SOURCE_BYTES) {
    return `[image omitted: legacy payload exceeds the ${MAX_COMPAT_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB local OCR limit]`
  }
  const key = bufferFingerprint(buffer)
  const cached = ocrCache.get(key)
  if (cached != null) return cached
  const sniffedMime = await sniffImageMime(buffer)
  if (!sniffedMime?.startsWith('image/')) return '[image omitted: legacy payload is not a recognized image]'
  const compressed = await compressImage(buffer, sniffedMime, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal,
  })
  const finalMime = normalizeImageMime(compressed.mimeType)
  if (
    compressed.failureReason ||
    !isModelAcceptedImageMime(finalMime) ||
    compressed.data.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    return buildImageProcessingFailureNotice('legacy session payload', compressed)
  }
  const rawText = await ocrImage(compressed.data, { abortSignal })
  const text =
    Buffer.byteLength(rawText, 'utf-8') <= MAX_COMPAT_OCR_BYTES
      ? rawText
      : truncateUtf8(rawText, MAX_COMPAT_OCR_BYTES) + '\n[Local OCR output truncated at 256 KB.]'
  ocrCache.set(key, text)
  return text
}

function filePartToBuffer(part: { data?: unknown }): Buffer | null {
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer || value instanceof URL) return value
    const tagged = value as { type?: string; data?: unknown }
    return tagged.type === 'data' ? tagged.data : value
  }
  const data = unwrap(part.data)
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data !== 'string') return null
  const commaIdx = data.indexOf(',')
  const payload = data.startsWith('data:') && commaIdx > 0 ? data.slice(commaIdx + 1) : data
  try {
    return Buffer.from(payload, 'base64')
  } catch {
    return null
  }
}

function cloneRequestValue<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (value instanceof ArrayBuffer) return value.slice(0) as T
  if (value instanceof URL) return new URL(value.href) as T
  if (Array.isArray(value)) return value.map((entry) => cloneRequestValue(entry)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneRequestValue(entry)]),
  ) as T
}

function imagePartToBuffer(part: { image: unknown; mediaType?: string }): Buffer | null {
  const img = part.image
  if (Buffer.isBuffer(img)) return img
  if (img instanceof Uint8Array) return Buffer.from(img)
  if (typeof img === 'string') {
    // 可能是 base64，也可能是 data URL。若存在 `data:...;base64,` 前缀则先剥离。
    const commaIdx = img.indexOf(',')
    const data = img.startsWith('data:') && commaIdx > 0 ? img.slice(commaIdx + 1) : img
    try {
      return Buffer.from(data, 'base64')
    } catch {
      return null
    }
  }
  return null
}

/** 就地替换对话中每一个二进制片段为文本提示。这是 agent loop 中的 400 恢复路径：
 *  当提供方拒绝一张图片（字节损坏、超出大小限制、格式漏过了摄入门禁）时，出问题的
 *  片段会留在历史里，之后每一次请求都会失败——即会话中毒。一次性剥离所有二进制片段
 *  并重试本轮。仅当确有改动时才返回 true，这样调用方就能区分“值得重试”和
 *  “这个坏片段不是我们能识别的形态——上报错误而非陷入循环”。 */
export function stripBinaryPartsFromMessages(
  messages: ModelMessage[],
  deliveredFileCache?: { clear(): void },
): boolean {
  let changed = false
  const fileNotice = (mediaType?: string) =>
    `[File attachment omitted (${mediaType ?? 'binary'}) — the provider rejected it; removed so the session can continue.]`
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'user' || msg.role === 'assistant') {
      let msgChanged = false
      const rewritten = (msg.content as Array<{ type: string; mediaType?: string }>).map((part) => {
        if (part.type === 'image') {
          msgChanged = true
          return { type: 'text', text: buildUnsupportedImageNotice(part.mediaType ?? 'unknown') }
        }
        if (part.type === 'file') {
          msgChanged = true
          return { type: 'text', text: fileNotice(part.mediaType) }
        }
        return part
      })
      if (msgChanged) {
        changed = true
        ;(msg as { content: unknown }).content = rewritten
      }
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue
        const entries = output.value as Array<{ type?: string; mediaType?: string }>
        if (!entries.some((e) => e?.type !== 'text' && e?.type !== 'custom')) continue
        output.value = entries.map((entry) => {
          if (entry?.type === 'text' || entry?.type === 'custom') return entry
          changed = true
          return { type: 'text', text: buildUnsupportedImageNotice(entry?.mediaType ?? 'unknown') }
        }) as never
      }
    }
  }
  if (changed) deliveredFileCache?.clear()
  return changed
}

/** 构建一个仅用于请求的投影：移除旧式非图片文件，并为纯文本模型对图片做 OCR。
 *  规范会话消息绝不会被这个兼容性步骤修改。 */
export async function downgradeBinaryPartsForProvider(
  messages: ModelMessage[],
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const caps = capabilitiesOf(modelId)
  const acceptsImages = caps.image && modelSupportsVision(modelId)
  const projected = cloneRequestValue(messages)

  for (const msg of projected) {
    // 用户消息——content 可能是 TextPart | ImagePart | FilePart 数组。
    if ((msg.role === 'user' || msg.role === 'assistant') && Array.isArray(msg.content)) {
      const rewritten: unknown[] = []
      for (const part of msg.content) {
        if (part.type === 'image') {
          const buffer = imagePartToBuffer(part as { image: unknown; mediaType?: string })
          if (!acceptsImages) {
            const text = buffer ? await ocrBuffer(buffer, abortSignal) : '[image omitted]'
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
            })
            continue
          }
          if (!buffer) {
            rewritten.push({ type: 'text', text: '[image omitted: legacy payload could not be decoded]' })
            continue
          }
          const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
          if (!normalized.ok) {
            rewritten.push({ type: 'text', text: normalized.notice })
            continue
          }
          const declaredMime = normalizeImageMime((part as { mediaType?: string }).mediaType ?? '')
          rewritten.push(
            !normalized.changed && declaredMime === normalized.mimeType
              ? part
              : {
                  ...part,
                  image: normalized.data.toString('base64'),
                  mediaType: normalized.mimeType,
                },
          )
          continue
        }
        if (part.type === 'file') {
          const file = part as { data?: unknown; filename?: string; mediaType?: string }
          const mediaType = file.mediaType?.toLowerCase() ?? ''
          const isImage = mediaType === 'image' || mediaType.startsWith('image/')
          if (isImage && acceptsImages) {
            const buffer = filePartToBuffer(file)
            if (!buffer) {
              rewritten.push({ type: 'text', text: '[image omitted: legacy payload could not be decoded]' })
              continue
            }
            const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
            if (!normalized.ok) {
              rewritten.push({ type: 'text', text: normalized.notice })
              continue
            }
            const declaredMime = normalizeImageMime(mediaType)
            rewritten.push(
              !normalized.changed && declaredMime === normalized.mimeType
                ? part
                : {
                    ...file,
                    data: { type: 'data', data: normalized.data.toString('base64') },
                    mediaType: normalized.mimeType,
                    filename: normalizedImageFilename(file.filename, normalized.mimeType),
                  },
            )
            continue
          }
          if (isImage) {
            const buffer = filePartToBuffer(file)
            const text = buffer ? await ocrBuffer(buffer, abortSignal) : '[image omitted]'
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images. Visual content is NOT visible.]\n${text}`,
            })
            continue
          }
          rewritten.push({
            type: 'text',
            text: `[Legacy file attachment omitted: ${file.filename ?? (mediaType || 'unknown')} — reattach or read the original path to process it locally.]`,
          })
          continue
        }
        rewritten.push(part)
      }
      ;(msg as { content: unknown }).content = rewritten
      continue
    }

    // 工具结果消息——content 始终是 tool-result 片段数组。
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const output = (part as { output?: MaybeOutput }).output
        if (!output || output.type !== 'content' || !Array.isArray(output.value)) continue

        const rewritten: unknown[] = []
        for (const entry of output.value as ToolContentEntry[]) {
          // 新会话使用带标签的图片 FileParts；旧会话可能仍包含 image-data/media。
          // 为纯文本提供方做 OCR，以免它们拒绝二进制工具输出。
          const isImageEntry = isToolImageEntry(entry)
          const imageData = toolImageBase64(entry)
          if (isImageEntry && (entry.mediaType?.startsWith('image/') ?? true) && acceptsImages) {
            const buffer = Buffer.from(imageData ?? '', 'base64')
            const normalized = await normalizeCompatImage(buffer, modelId, abortSignal)
            if (!normalized.ok) {
              rewritten.push({ type: 'text', text: normalized.notice })
              continue
            }
            const declaredMime = normalizeImageMime(entry.mediaType ?? '')
            rewritten.push(
              !normalized.changed && declaredMime === normalized.mimeType
                ? entry
                : withToolImageData(
                    entry,
                    normalized.data.toString('base64'),
                    normalized.mimeType,
                    normalizedImageFilename(entry.filename, normalized.mimeType),
                  ),
            )
            continue
          }
          if (isImageEntry && (entry.mediaType?.startsWith('image/') ?? true)) {
            const data = imageData ?? ''
            let text = '[image omitted]'
            try {
              const buffer = Buffer.from(data, 'base64')
              text = await ocrBuffer(buffer, abortSignal)
            } catch {
              // 落入占位符分支
            }
            rewritten.push({
              type: 'text',
              text: `[Image replaced by local OCR — the current model cannot natively see images.]\n${text}`,
            })
            continue
          }
          const isLegacyFileEntry =
            entry.type === 'file' ||
            entry.type === 'file-data' ||
            entry.type === 'file-url' ||
            entry.type === 'file-id' ||
            (entry.type === 'media' && !entry.mediaType?.startsWith('image/'))
          if (isLegacyFileEntry) {
            rewritten.push({
              type: 'text',
              text: `[Legacy file attachment omitted (${entry.filename ?? entry.mediaType ?? 'binary'}) — reattach or read the original path to process it locally.]`,
            })
            continue
          }
          rewritten.push(entry)
        }
        ;(output as MaybeOutput).value = rewritten
      }
    }
  }
  return projected
}
