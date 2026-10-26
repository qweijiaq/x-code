// @x-code-cli/core — 显式视觉兼容辅助
//
// 供明确请求字幕的产品面使用，例如工具图片投递。普通本地附件从不调用这个辅助函数：
// 它们要么只去当前视觉模型，要么留在本地做 OCR。
import { generateText } from 'ai'
import type { LanguageModel, LanguageModelUsage } from 'ai'

import { getAvailableProviders } from '../config/index.js'
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImage,
  normalizeImageMime,
  sniffImageMime,
} from '../providers/capabilities.js'
import { createModelRegistry } from '../providers/registry.js'
import { debugLog } from '../utils.js'
import { readFileWithinLimit } from '../utils/bounded-read.js'
import {
  ATTACH_BYTE_BUDGET,
  MAX_EDGE_PX,
  MAX_IMAGE_SOURCE_BYTES,
  buildImageProcessingFailureNotice,
  compressImage,
} from '../utils/image-compress.js'
import { LruCache, bufferFingerprint } from '../utils/lru-cache.js'
import { knownMediaTypeFor } from '../utils/media-type.js'
import { attributedModelId } from './usage.js'

export interface VisionProvider {
  /** 提供方 id，如 "google" / "zhipu"。 */
  provider: string
  /** 传给 AI SDK registry 的完整 <provider>:<model> id。 */
  modelId: string
  /** 用于 UI 提示的短标签（"Gemini 2.5 Flash"）。 */
  label: string
}

export interface VisionUsageEvent {
  modelId: string
  usage: LanguageModelUsage
}

/** 每个提供方的视觉模型 id + 显示标签。模型选择偏向便宜 / 免费档——目标是快速字幕，
 *  而非深度分析。 */
const VISION_MODELS: Record<string, { modelId: string; label: string }> = {
  google: { modelId: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  zhipu: { modelId: 'zhipu:glm-4.6v', label: 'GLM-4.6V' },
  deepseek: { modelId: 'deepseek:deepseek-flash', label: 'DeepSeek V4.1 Flash' },
  alibaba: { modelId: 'alibaba:qwen3-vl-flash', label: 'Qwen3-VL Flash' },
  openai: { modelId: 'openai:gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  anthropic: { modelId: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  moonshotai: { modelId: 'moonshotai:kimi-k2.6', label: 'Kimi K2.6' },
  xai: { modelId: 'xai:grok-4.3', label: 'Grok 4.3' },
}

/** 挑选视觉子 agent 时尝试提供方的顺序。免费档与单图便宜的模型在前；较重的旗舰在后。
 *  Gemini 2.5 Flash 打头，因为它的免费档最慷慨（1500/天），且在该免费价位上模型也最强。
 *  GLM-4.6V 排第二，因为它便宜/免费，且在中国无需代理即可访问。
 *  DeepSeek V4.1 Flash 紧随其后，作为已配置的、具备原生视觉的最便宜付费回退。 */
const VISION_PRIORITY = ['google', 'zhipu', 'deepseek', 'alibaba', 'openai', 'anthropic', 'moonshotai', 'xai']

/**
 * 根据用户已配置的密钥挑选最佳可用视觉子 agent。若没有任何视觉提供方配有密钥
 * 则返回 null——调用方应回退到本地 OCR。
 */
export function pickVisionProvider(): VisionProvider | null {
  const available = new Set(getAvailableProviders())
  for (const provider of VISION_PRIORITY) {
    if (!available.has(provider)) continue
    const model = VISION_MODELS[provider]
    if (!model) continue
    return { provider, modelId: model.modelId, label: model.label }
  }
  return null
}

/** 内存缓存，使重复附加同一图片（或同一会话多次提交里的同一图片）不会在子 agent 上
 *  重复烧 token。完整图片 SHA-256 按模型与提示词做命名空间隔离。 */
const captionCache = new LruCache<string>({ maxEntries: 50 })

/** 缓存的 registry + 已解析的模型实例。创建 registry 很昂贵（会初始化所有已配置的
 *  提供方 SDK 实例）；缓存它能避免浏览器 agent 会话里每隔几秒就来一张截图时，
 *  每次字幕调用都重新分配。 */
let cachedRegistry: ReturnType<typeof createModelRegistry> | null = null
const resolvedModels = new Map<string, LanguageModel>()

function getVisionModel(modelId: string): LanguageModel {
  const existing = resolvedModels.get(modelId)
  if (existing) return existing
  if (!cachedRegistry) cachedRegistry = createModelRegistry()
  const model = cachedRegistry.languageModel(modelId as `${string}:${string}`)
  resolvedModels.set(modelId, model)
  return model
}

export function resetVisionModelProviders(): void {
  cachedRegistry = null
  resolvedModels.clear()
}

/** 默认字幕提示词同时要求逐字文本与视觉元素。 */
const DEFAULT_CAPTION_PROMPT =
  'Describe this image in detail so a text-only AI can act on it. ' +
  'Include: (1) any visible text transcribed verbatim, ' +
  '(2) UI elements, layout, and visual hierarchy, ' +
  '(3) colors, icons, shapes, and other visual details, ' +
  '(4) inferred purpose or context. ' +
  'Be thorough and specific. Output plain text only — no markdown formatting.'

/**
 * 通过选定的视觉模型为内存中的图片 buffer 生成字幕。是 `captionImage`（先读文件、
 * 再委托到这里）的更低层兄弟。MCP 工具结果路径用它把浏览器截图转成文本，
 * 供那些 tool-result 通道无法携带真实图片的提供方使用（见 capabilities.toolImageTransport）。
 * `prompt` 覆盖默认字幕指令，这样调用方可以索要例如像素坐标。
 */
export async function captionImageBuffer(
  buffer: Buffer,
  mediaType: string,
  modelId: string,
  opts: {
    prompt?: string
    maxOutputTokens?: number
    abortSignal?: AbortSignal
    onUsage?: (event: VisionUsageEvent) => void
  } = {},
): Promise<string> {
  if (buffer.length > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_SOURCE_BYTES}-byte source limit`)
  }
  const prompt = opts.prompt ?? DEFAULT_CAPTION_PROMPT
  const key = `${modelId}:${bufferFingerprint(buffer)}:${prompt}`
  const cached = captionCache.get(key)
  if (cached != null) {
    debugLog('vision-fallback.cache-hit', `${modelId} ${buffer.length}B`)
    return cached
  }

  // 发送给视觉子 agent 之前先压缩——与用户附加图片使用同一预算。子 agent 是廉价的
  // 字幕模型；把数 MB 的原图塞给它毫无意义。
  const compressed = await compressImage(buffer, mediaType, {
    byteBudget: ATTACH_BYTE_BUDGET,
    abortSignal: opts.abortSignal,
  })
  const finalBuf = compressed.data
  const finalMime = normalizeImageMime(compressed.mimeType)
  if (!isModelAcceptedImage(finalMime, { modelId, animated: compressed.animated })) {
    throw new Error(buildUnsupportedImageNotice(finalMime, 'vision input', modelId, compressed.animated))
  }
  if (
    compressed.failureReason ||
    finalBuf.length > ATTACH_BYTE_BUDGET ||
    compressed.width > MAX_EDGE_PX ||
    compressed.height > MAX_EDGE_PX
  ) {
    throw new Error(buildImageProcessingFailureNotice('vision input', compressed))
  }
  if (compressed.changed) {
    debugLog('vision-fallback.compressed', `${buffer.length}B → ${finalBuf.length}B (${finalMime})`)
  }

  const model = getVisionModel(modelId)

  debugLog('vision-fallback.caption', `${modelId} ${finalBuf.length}B`)
  const result = await generateText({
    model,
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'file', data: { type: 'data', data: finalBuf }, mediaType: finalMime },
        ],
      },
    ],
  })
  opts.onUsage?.({ modelId: attributedModelId(modelId, result.response?.modelId), usage: result.usage })

  const caption = result.text.trim()
  captionCache.set(key, caption)
  return caption
}

/**
 * 通过选定的子 agent 为图片文件生成文字描述。是 `captionImageBuffer` 的薄封装，
 * 负责读文件并按扩展名推导媒体类型；让现有的 file-ingest 调用点（及其按文件内容的
 * 缓存键）保持不变地工作。
 */
export async function captionImage(
  filePath: string,
  sub: VisionProvider,
  opts?: { abortSignal?: AbortSignal; onUsage?: (event: VisionUsageEvent) => void },
): Promise<string> {
  const buffer = await readFileWithinLimit(filePath, MAX_IMAGE_SOURCE_BYTES, opts?.abortSignal)
  const mediaType = (await sniffImageMime(buffer)) ?? knownMediaTypeFor(filePath)
  if (!mediaType?.startsWith('image/')) throw new Error('Unsupported or unrecognized image format')
  return captionImageBuffer(buffer, mediaType, sub.modelId, {
    abortSignal: opts?.abortSignal,
    onUsage: opts?.onUsage,
  })
}
