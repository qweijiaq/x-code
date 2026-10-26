/**
 * 为运行 Ollama 或 LM Studio 的桌面用户做本地模型发现。
 *
 * 与其给核心 catalog 增加 provider（它驱动 env-key 检测和 CLI 的选择器），
 * 桌面运行时在启动时发现本地服务器并包装核心注册表：诸如
 * `ollama:llama3.2` 和 `lmstudio:qwen2.5-coder-7b` 这样的 id 会解析为
 * 指向本地服务器的 OpenAI 兼容客户端。未知 id
 * 原样落到核心注册表。
 */
import type { LanguageModel } from 'ai'

import { createLocalOpenAICompatibleModel, createModelRegistry } from '@x-code-cli/core'

type CoreModelRegistry = ReturnType<typeof createModelRegistry>
type LocalProvider = 'ollama' | 'lmstudio'

export interface LocalModelInfo {
  id: string
  label: string
  provider: LocalProvider
  description: string
  baseUrl: string
}

const DISCOVERY_TIMEOUT_MS = 700
const MAX_MODELS_PER_SERVER = 12
const discovered = new Map<string, LocalModelInfo>()

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
      description: `本地 Ollama · ${root}`,
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
      description: `本地 LM Studio · ${root}`,
      baseUrl: openAiBase(root),
    }))
}

/** 并行探测两个本地服务器。错误（未运行、超时）视为
 *  「无模型」，这样启动绝不会因本地服务器而失败。 */
export async function discoverLocalModels(): Promise<LocalModelInfo[]> {
  const results = await Promise.allSettled([probeOllama(), probeLmStudio()])
  const models: LocalModelInfo[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') models.push(...result.value)
  }
  discovered.clear()
  for (const model of models) discovered.set(model.id, model)
  return models
}

export function localModelInfos(): LocalModelInfo[] {
  return [...discovered.values()]
}

function providerFor(id: string): LocalProvider | null {
  if (id.startsWith('ollama:')) return 'ollama'
  if (id.startsWith('lmstudio:')) return 'lmstudio'
  return null
}

function createLocalModel(id: string): LanguageModel | null {
  const provider = providerFor(id)
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
