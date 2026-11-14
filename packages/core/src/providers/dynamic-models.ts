// @x-code-cli/core — provider 模型目录的动态补充
//
// OpenCode / OpenDesign 这类网关的可用模型取决于账号和套餐，静态 catalog
// 只能列一个子集。启动或切换 provider 后请求一次 `/models`，把返回的 id
// 合并进模型选择器；请求失败时继续用静态列表，不影响启动。
import { getProviderOptions, loadUserConfig } from '../config/index.js'
import type { ProviderModel } from './catalog.js'
import { GATEWAY_PROVIDERS, gatewayBaseUrl } from './gateways.js'
import { listOpenAICompatibleModels } from './model-discovery.js'

const dynamicModels = new Map<string, ProviderModel[]>()

function prefixedId(provider: string, raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith(`${provider}:`) ? trimmed : `${provider}:${trimmed}`
}

function toProviderModels(provider: string, ids: readonly string[]): ProviderModel[] {
  return ids
    .map((raw) => {
      const id = prefixedId(provider, raw)
      return {
        id,
        label: id.slice(provider.length + 1),
        description: 'Discovered from the provider model list',
        vision: false,
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** 替换某个 provider 的动态模型列表。空数组表示回退到静态 catalog。 */
export function setDynamicProviderModels(provider: string, ids: readonly string[]): void {
  const models = toProviderModels(provider, ids)
  if (models.length === 0) dynamicModels.delete(provider)
  else dynamicModels.set(provider, models)
}

export function getDynamicProviderModels(provider: string): readonly ProviderModel[] {
  return dynamicModels.get(provider) ?? []
}

export function clearDynamicProviderModels(): void {
  dynamicModels.clear()
}

export interface RefreshDynamicModelsOptions {
  /** 只刷新这些 provider；省略时刷新所有已配置 key 的网关 provider。 */
  providers?: readonly string[]
  timeoutMs?: number
}

export interface RefreshDynamicModelsResult {
  refreshed: string[]
  errors: Array<{ provider: string; message: string }>
}

/** 从各自 `/models` 端点刷新动态模型。只处理 GATEWAY_PROVIDERS 中已配置
 *  API key 的 provider；单个 provider 失败不会影响其他 provider。 */
export async function refreshDynamicProviderModels(
  options: RefreshDynamicModelsOptions = {},
): Promise<RefreshDynamicModelsResult> {
  const config = loadUserConfig()
  const rawOptions = getProviderOptions() as Record<string, unknown>
  const selected = options.providers ? new Set(options.providers) : null
  const targets = GATEWAY_PROVIDERS.filter((provider) => !selected || selected.has(provider.name))

  const refreshed: string[] = []
  const errors: Array<{ provider: string; message: string }> = []

  await Promise.all(
    targets.map(async (provider) => {
      const key = rawOptions[provider.name]
      if (typeof key !== 'string' || !key.trim()) return
      const baseUrl = gatewayBaseUrl(provider.name, config.baseUrls?.[provider.name])
      if (!baseUrl) return
      try {
        const models = await listOpenAICompatibleModels({
          baseUrl,
          apiKey: key,
          timeoutMs: options.timeoutMs ?? 4_000,
        })
        setDynamicProviderModels(provider.name, models)
        refreshed.push(provider.name)
      } catch (error) {
        errors.push({
          provider: provider.name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )

  return { refreshed, errors }
}
