import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { createCliModelRegistry } from '../../model-registry.js'

export function replaceActiveModelProvider(
  modelId: string,
  options: Pick<AgentOptions, 'modelRegistry'>,
  switchModel: (modelId: string, model: LanguageModel) => void,
): void {
  const registry = createCliModelRegistry()
  const model = registry.languageModel(modelId as `${string}:${string}`)
  options.modelRegistry = registry
  switchModel(modelId, model)
}
