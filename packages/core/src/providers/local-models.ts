/**
 * 本地模型发现：Ollama / LM Studio。
 *
 * 桌面端和 CLI 共用同一套发现逻辑，避免两个界面支持的 provider 不一致。
 * 这里不把本地服务器塞进 catalog（catalog 驱动 env-key 检测），而是包装
 * 核心注册表：`ollama:llama3.2`、`lmstudio:qwen2.5-coder-7b` 这类 id
 * 解析为指向本地服务器的 OpenAI 兼容客户端，其他 id 原样委托。
 */
import type { LanguageModel } from 'ai'

import { createLocalOpenAICompatibleModel } from './local.js'
import { createModelRegistry } from './registry.js'

type CoreModelRegistry = ReturnType<typeof createModelRegistry>
export type LocalProvider = 'ollama' | 'lmstudio'

export interface LocalModelInfo {
  id: string
  label: string
  provider: LocalProvider
  description: string
  baseUrl: string
}

const DISCOVERY_TIMEOUT_MS = 700
const DISCOVERY_CACHE_MS = 30_000
const MAX_MODELS_PER_SERVER = 12
const discovered = new Map<string, LocalModelInfo>()
let lastDiscoveryAt = 0
let lastDiscovery: LocalModelInfo[] = []

function normalizeRoot(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

function ollamaRoot(): string {
  return normalizeRoot(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434')
}

function lmStudioRoot(): string {
  return normalizeRoot(process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234')
}

function openAiBase(root: string): string {
  return `${root}/v1`
}

async function probeOllama(): Promise<LocalModelInfo[]> {
  const root = ollamaRoot()
  const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
  if (!response.ok) return []
  const payload = (await response.json()) as { models?: Array<{ name?: string }> }
  return (payload.models ?? [])
    .map((model) => model.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, MAX_MODELS_PER_SERVER)
    .map((name) => ({
      id: `ollama:${name}`,
      label: name,
      provider: 'ollama' as const,
      description: `Local Ollama · ${root}`,
      baseUrl: openAiBase(root),
    }))
}

async function probeLmStudio(): Promise<LocalModelInfo[]> {
  const root = lmStudioRoot()
  const response = await fetch(`${openAiBase(root)}/models`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return (payload.data ?? [])
    .map((model) => model.id?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, MAX_MODELS_PER_SERVER)
    .map((name) => ({
      id: `lmstudio:${name}`,
      label: name,
      provider: 'lmstudio' as const,
      description: `Local LM Studio · ${root}`,
      baseUrl: openAiBase(root),
    }))
}

/** 并行探测两个本地服务器。错误（未运行、超时）视为「无模型」，
 *  这样启动绝不会因本地服务器而失败。 */
export async function discoverLocalModels(force = false): Promise<LocalModelInfo[]> {
  if (!force && lastDiscoveryAt > 0 && Date.now() - lastDiscoveryAt < DISCOVERY_CACHE_MS) {
    return lastDiscovery
  }
  const results = await Promise.allSettled([probeOllama(), probeLmStudio()])
  const models: LocalModelInfo[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') models.push(...result.value)
  }
  discovered.clear()
  for (const model of models) discovered.set(model.id, model)
  lastDiscovery = models
  lastDiscoveryAt = Date.now()
  return models
}

export function localModelInfos(): LocalModelInfo[] {
  return [...discovered.values()]
}

export function localProviderOf(id: string): LocalProvider | null {
  if (id.startsWith('ollama:')) return 'ollama'
  if (id.startsWith('lmstudio:')) return 'lmstudio'
  return null
}

function createLocalModel(id: string): LanguageModel | null {
  const provider = localProviderOf(id)
  if (!provider) return null
  const info = discovered.get(id)
  if (!info) return null
  const model = id.slice(provider.length + 1)
  if (!model) return null
  return createLocalOpenAICompatibleModel(provider, info.baseUrl, model)
}

/** 包装核心注册表，使 `<local>:<model>` id 解析到本地服务器。
 *  其他所有 id 原样委托（不可用时仍会抛出）。 */
export function withLocalModels(base: CoreModelRegistry): CoreModelRegistry {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'languageModel') {
        return (id: string) => createLocalModel(id) ?? target.languageModel(id as `${string}:${string}`)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as CoreModelRegistry
}

/** 判断模型 id 是否属于已发现的本地服务器。 */
export function isLocalModelId(id: string): boolean {
  return discovered.has(id)
}
