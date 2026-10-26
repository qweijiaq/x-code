// @x-code-cli/core — 可选的本地嵌入后端。
//
// 安装可选包后，语义搜索通过 transformers.js 使用 BGE-small-zh-v1.5。
// 加载模型时会把模型下载一次到 transformers 缓存（约 100 MB）。
// 包或模型不可用时，库仍能用关键词检索工作；调用方检查返回的 null。
export const EMBEDDING_DIMENSIONS = 512
const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const RETRY_COOLDOWN_MS = 5 * 60_000

interface PipelineOutput {
  tolist(): number[][]
}

type FeaturePipeline = (texts: string[], options: Record<string, unknown>) => Promise<PipelineOutput>

interface TransformersModule {
  pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeaturePipeline>
}

export interface EmbedderStatus {
  backendInstalled: boolean
  modelReady: boolean
  note: string
}

let backend: TransformersModule | null | undefined
let extractor: FeaturePipeline | null = null
let lastError: string | null = null
let lastAttempt = 0

// 非字面的动态 import 可让打包器和 tsc 不在构建时
// 要求这个可选包。
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

async function loadBackend(): Promise<TransformersModule | null> {
  if (backend !== undefined) return backend
  for (const specifier of ['@huggingface/transformers', '@xenova/transformers']) {
    try {
      const module = (await dynamicImport(specifier)) as TransformersModule
      if (typeof module.pipeline === 'function') {
        backend = module
        return backend
      }
    } catch {
      // 尝试下一个包名。
    }
  }
  backend = null
  return null
}

async function ensureExtractor(): Promise<FeaturePipeline | null> {
  if (extractor) return extractor
  if (lastError && Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return null
  lastAttempt = Date.now()
  const module = await loadBackend()
  if (!module?.pipeline) {
    lastError = 'Embedding backend is not installed'
    return null
  }
  try {
    extractor = await module.pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' })
    lastError = null
    return extractor
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    return null
  }
}

export async function embedderStatus(): Promise<EmbedderStatus> {
  const module = await loadBackend()
  if (!module) {
    return {
      backendInstalled: false,
      modelReady: false,
      note: '未安装可选依赖 @huggingface/transformers；当前仅支持关键词检索',
    }
  }
  if (extractor) {
    return { backendInstalled: true, modelReady: true, note: `已加载 ${MODEL_ID}` }
  }
  return {
    backendInstalled: true,
    modelReady: false,
    note: lastError ? `模型不可用：${lastError}` : `首次语义索引/检索会下载 ${MODEL_ID}（约 100 MB）`,
  }
}

/** 用 CLS 池化 + L2 归一化对文本做嵌入（BGE 约定）。
 *  后端或模型不可用时返回 null。 */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return []
  const pipeline = await ensureExtractor()
  if (!pipeline) return null
  try {
    const output = await pipeline(texts, { pooling: 'cls', normalize: true })
    const rows = output.tolist()
    return rows.map((row) => Float32Array.from(row))
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    return null
  }
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  const vectors = await embedTexts([text])
  return vectors?.[0] ?? null
}

export function lastEmbedderError(): string | null {
  return lastError
}
