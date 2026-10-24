/**
 * Local model discovery for desktop users running Ollama or LM Studio.
 *
 * Rather than adding providers to core's catalog (which powers env-key
 * detection and the CLI's picker), the desktop runtime discovers local
 * servers at startup and wraps the core registry: ids such as
 * `ollama:llama3.2` and `lmstudio:qwen2.5-coder-7b` resolve to an
 * OpenAI-compatible client pointed at the local server. Unknown ids fall
 * through to the core registry unchanged.
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

/** Probe both local servers in parallel. Errors (not running, timeout) are
 *  treated as "no models" so startup never fails because of a local server. */
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

/** Wrap the core registry so `<local>:<model>` ids resolve to local servers.
 *  Every other id is delegated unchanged (and still throws when unavailable). */
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

/** Whether a model id belongs to a discovered local server. */
export function isLocalModelId(id: string): boolean {
  return discovered.has(id)
}
