// @x-code-cli/core — 供用户本地服务器的 OpenAI-compatible 客户端
//
// 桌面运行时发现本地的 Ollama / LM Studio 实例，需要把 `<server>:<model>` id
// 转成 AI SDK 模型，而不把本地 provider 加进目录（它们没有 API key，也没有
// 静态模型列表）。把构造逻辑放在这里，可避免 desktop 包重复依赖 @ai-sdk。
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

export function createLocalOpenAICompatibleModel(provider: string, baseURL: string, model: string): LanguageModel {
  const client = createOpenAICompatible({
    name: provider,
    apiKey: 'local',
    baseURL,
    includeUsage: true,
  })
  return client.languageModel(model)
}
