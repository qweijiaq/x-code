import { streamText } from 'ai'

import { PROVIDERS, createModelRegistry } from '@x-code-cli/core'

import type { TestConnectionResult } from '../shared/protocol.js'

const ENV_BY_PROVIDER = new Map<string, string>(PROVIDERS.map((provider) => [provider.name, provider.envKey]))
ENV_BY_PROVIDER.set('custom', 'OPENAI_COMPATIBLE_API_KEY')

/**
 * 通过真实 provider 注册表发送一个最小请求。这里提供的 key 或 base
 * URL 仅用于本次请求，之后恢复原状。
 */
export async function testProviderConnection(
  provider: string,
  key?: string,
  baseUrl?: string,
): Promise<TestConnectionResult> {
  const info = PROVIDERS.find((entry) => entry.name === provider)
  const envKey = ENV_BY_PROVIDER.get(provider)
  if (!envKey) {
    return { ok: false, modelId: '', latencyMs: 0, message: `未知的 provider: ${provider}` }
  }
  if (provider === 'custom' && !baseUrl?.trim() && !process.env.OPENAI_COMPATIBLE_BASE_URL) {
    return { ok: false, modelId: '', latencyMs: 0, message: '自定义 provider 需要先填写 Base URL' }
  }

  const configuredModel = process.env.X_CODE_MODEL?.trim()
  const modelId =
    provider === 'custom'
      ? configuredModel?.startsWith('custom:')
        ? configuredModel
        : 'custom:test'
      : info?.defaultModel
  if (!modelId) {
    return { ok: false, modelId: '', latencyMs: 0, message: `无法确定 ${provider} 的测试模型` }
  }

  const previousKey = process.env[envKey]
  const previousBase = process.env.OPENAI_COMPATIBLE_BASE_URL
  if (key?.trim()) process.env[envKey] = key.trim()
  if (provider === 'custom' && baseUrl?.trim()) process.env.OPENAI_COMPATIBLE_BASE_URL = baseUrl.trim()

  const started = Date.now()
  try {
    const registry = createModelRegistry()
    const model = registry.languageModel(modelId as `${string}:${string}`)
    // 使用流式路径，与 agent 循环和 provider 测试 fixture 保持一致。
    // generateText 会要求 fixture 实现
    // 非流式 JSON 响应。
    const result = streamText({
      model,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(25_000),
    })
    let text = ''
    for await (const delta of result.textStream) {
      text += delta
      if (text.length > 200) break
    }
    return {
      ok: true,
      modelId,
      latencyMs: Date.now() - started,
      message: text.trim().slice(0, 120) || 'ok',
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    if (key?.trim()) message = message.split(key.trim()).join('***')
    return {
      ok: false,
      modelId,
      latencyMs: Date.now() - started,
      message: message.slice(0, 400),
    }
  } finally {
    if (key?.trim()) {
      if (previousKey === undefined) delete process.env[envKey]
      else process.env[envKey] = previousKey
    }
    if (provider === 'custom') {
      if (previousBase === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = previousBase
    }
  }
}
