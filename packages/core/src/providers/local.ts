// @x-code-cli/core — OpenAI-compatible clients for user-run local servers
//
// The desktop runtime discovers local Ollama / LM Studio instances and needs
// to turn `<server>:<model>` ids into AI SDK models without adding local
// providers to the catalog (they have no API key and no static model list).
// Keeping the construction here avoids a duplicate @ai-sdk dependency in the
// desktop package.
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
