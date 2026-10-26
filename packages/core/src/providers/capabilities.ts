// @x-code-cli/core — provider 多模态能力表
//
// 图片能力驱动模型的交付方式。旧的 PDF/audio/file 字段为兼容性保留在
// 公开类型中，但没有摄取管线的消费方。
//
// provider 能力描述的是线上 API。modelSupportsVision 在此基础上再叠加
// 精选的逐模型标志，因此纯文本的 Qwen/GLM 变体即使其 provider 接受多模态
// 内容，也仍会降级图片。
import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
import { MODEL_ALIASES } from './catalog.js'
import { getOpenAIChatGPTRuntimeModel, getProviderModels } from './openai-chatgpt-models.js'

export interface ProviderCapabilities {
  /** provider 能否在用户消息中接收内联图片片段（base64 或 URL）。 */
  image: boolean
  /** @deprecated 文件摄取始终在本地处理 PDF。 */
  pdf: boolean
  /** @deprecated 文件摄取始终在本地转写音频。 */
  audio: boolean
  /** @deprecated 摄取管线不使用通用文件上传。 */
  filesApi: boolean
  /** 工具返回的图片在该 provider 上必须如何表示。
   *
   *  `tool-result`：provider SDK 在工具结果内部保留图片内容
   *  （Anthropic、OpenAI Responses、Gemini）。
   *  `user-message`：Chat Completions 的工具角色仅文本，因此保持工具结果
   *  为文本，并在后续用户消息中附带图片。
   *  `unsupported`：provider 完全无法接收图片。 */
  toolImageTransport: 'tool-result' | 'user-message' | 'unsupported'
}

const CAPS: Record<string, ProviderCapabilities> = {
  anthropic: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'tool-result' },
  openai: { image: true, pdf: true, audio: true, filesApi: true, toolImageTransport: 'tool-result' },
  google: { image: true, pdf: true, audio: true, filesApi: true, toolImageTransport: 'tool-result' },
  xai: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  moonshotai: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  alibaba: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  zhipu: { image: true, pdf: true, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  deepseek: { image: true, pdf: false, audio: false, filesApi: true, toolImageTransport: 'user-message' },
  custom: { image: false, pdf: false, audio: false, filesApi: false, toolImageTransport: 'unsupported' },
}

const NO_CAPABILITIES: ProviderCapabilities = {
  image: false,
  pdf: false,
  audio: false,
  filesApi: false,
  toolImageTransport: 'unsupported',
}

// ── 图片格式策略（会话污染防御）───────────────────────
//
// provider 在 MIME 与动画支持上各不相同。不受支持的部分（包括仅在文档
// 中支持静态 GIF 时传入的合法动画 GIF）会被以 400 拒绝——而由于消息会
// 在会话中持久化，后续每个请求也都会失败（Kimi CLI 的
// image-format-policy 称之为 "session poisoning"）。
// 这些封闭策略是唯一事实来源；文件摄取在摄取时把关，agent loop 在 400
// 时剥离，因此坏图片永远不会卡死会话。新格式只有先加到这里才会被发送。

interface ImageFormatPolicy {
  mimes: ReadonlySet<string>
  animatedMimes: ReadonlySet<string>
}

const DEFAULT_IMAGE_POLICY: ImageFormatPolicy = {
  mimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  animatedMimes: new Set(),
}
const PROVIDER_IMAGE_POLICIES: Readonly<Record<string, ImageFormatPolicy>> = {
  alibaba: { mimes: new Set(['image/png', 'image/jpeg', 'image/webp']), animatedMimes: new Set() },
  xai: { mimes: new Set(['image/png', 'image/jpeg']), animatedMimes: new Set() },
}

/** 转小写、去掉 MIME 参数、应用 `image/jpg` 别名。 */
export function normalizeImageMime(mime: string): string {
  const base = (mime.split(';', 1)[0] ?? '').trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

function imagePolicy(modelId?: string): ImageFormatPolicy {
  if (!modelId) return DEFAULT_IMAGE_POLICY
  const resolved = MODEL_ALIASES[modelId] ?? modelId
  return PROVIDER_IMAGE_POLICIES[providerOf(resolved)] ?? DEFAULT_IMAGE_POLICY
}

export function isModelAcceptedImageMime(mime: string, modelId?: string): boolean {
  return imagePolicy(modelId).mimes.has(normalizeImageMime(mime))
}

export function isModelAcceptedImage(mime: string, options: { modelId?: string; animated?: boolean } = {}): boolean {
  const normalized = normalizeImageMime(mime)
  const policy = imagePolicy(options.modelId)
  return policy.mimes.has(normalized) && (!options.animated || policy.animatedMimes.has(normalized))
}

/** 从魔数字节嗅探真实 MIME；无法识别时返回 null。字节是权威——
 *  被错误标记的文件（AVIF 改名为 .png）必须按它的实际内容判定，
 *  因为 provider 解码的是字节而非文件名。 */
export async function sniffImageMime(buffer: Buffer): Promise<string | null> {
  try {
    const { fileTypeFromBuffer } = await import('file-type')
    const detected = await fileTypeFromBuffer(buffer)
    return detected?.mime ?? null
  } catch {
    return null
  }
}

/** 代替被拒绝 / 被剥离图片的文本提示，让模型知道发生了什么，同时使会话
 *  历史中不残留 provider 拒绝的部分。 */
export function buildUnsupportedImageNotice(mime: string, name?: string, modelId?: string, animated = false): string {
  const kind = animated ? `animated ${mime}` : `unsupported image format ${mime}`
  const what = name ? `"${name}" uses ${kind}` : kind
  const policy = imagePolicy(modelId)
  const formats = [...policy.mimes]
    .map((value) => {
      const label = value.slice('image/'.length).replace('jpeg', 'JPEG').toUpperCase()
      return value === 'image/gif' && !policy.animatedMimes.has(value) ? `${label} (non-animated)` : label
    })
    .join(', ')
  return `[Image omitted: ${what}. The current model accepts only ${formats} — convert it to PNG or JPEG and try again.]`
}

/** 从 `provider:model` id 中提取 `provider`。缺少分隔符时返回 `unknown`
 *  （防御性——解析后的 id 不应出现此情况）。 */
export function providerOf(modelId: string): string {
  const idx = modelId.indexOf(':')
  return idx > 0 ? modelId.slice(0, idx) : 'unknown'
}

/** 查询某模型 id 的能力。未知 provider 默认纯文本——比假定支持视觉更安全。 */
export function capabilitiesOf(modelId: string): ProviderCapabilities {
  return CAPS[providerOf(modelId)] ?? NO_CAPABILITIES
}

/** 这个具体的 MODEL 能否原生看图？不同于 `capabilitiesOf`（那是 provider
 *  级——"API 是否接受图片片段"），这是逐模型判断，因为 provider 会在同一
 *  id 命名空间下混用视觉与纯文本模型（DeepSeek Flash 对 V4 Pro、
 *  Qwen-VL 对 Qwen-Max、GLM-4V 对 GLM-5）。用于给浏览器 agent 的
 *  `--caps vision` 把关，使纯文本模型永远不会收到读不了的截图。
 *
 *  解析方式：展开别名、在精选目录中查找 id 并信任其显式 `vision` 标志。
 *  对于不在目录中的 id（用户输入的自定义变体），回退到 provider 级图片
 *  能力——偏宽松，避免仅因未列出就挡住一个视觉模型。 */
export function modelSupportsVision(modelId: string): boolean {
  const resolved = MODEL_ALIASES[modelId] ?? modelId
  if (getOpenAIAuthContext().mode === 'chatgpt' && resolved.startsWith('openai:')) {
    return getOpenAIChatGPTRuntimeModel(resolved)?.vision ?? false
  }
  for (const models of Object.values(getProviderModels())) {
    for (const m of models) {
      if (m.id === resolved) return m.vision
    }
  }
  return capabilitiesOf(resolved).image
}
