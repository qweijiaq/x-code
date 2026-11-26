import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { createCliModelRegistry } from '../../model-registry.js'

/** "provider:model" 格式校验。`registry.languageModel()` 只接受模板字面量类型
 *  `${string}:${string}`——用它之前必须真的检查过格式，否则 `as` 断言只是骗过
 *  编译器。本地模型 id 同样是这个形状（`ollama:llama3.2`、`lmstudio:qwen2.5`）。 */
function assertModelId(modelId: string): asserts modelId is `${string}:${string}` {
  if (!modelId.includes(':')) {
    throw new Error(`Invalid model id ${JSON.stringify(modelId)}: expected "provider:model" format.`)
  }
}

export function replaceActiveModelProvider(
  modelId: string,
  options: Pick<AgentOptions, 'modelRegistry'>,
  switchModel: (modelId: string, model: LanguageModel) => void,
): void {
  assertModelId(modelId)
  const registry = createCliModelRegistry()
  const model = registry.languageModel(modelId)
  // 未知模型时注册表可能返回空值（本地模型包装层就是这样委托的）。空值一旦流进
  // `switchModel`，会话就带着一个假模型继续跑，直到真正调用时才崩——错误现场被
  // 推迟到下一个用户回合，极难定位。在这里就拦住。
  if (!model) {
    throw new Error(`Unknown model ${JSON.stringify(modelId)}: it is not provided by any configured provider.`)
  }
  // 先切 model、成功后再落 registry：反过来的话，`switchModel` 抛错时会留下
  // 「新 registry + 旧 model」的半完成状态（旧 model 可能属于旧 registry）。
  switchModel(modelId, model)
  options.modelRegistry = registry
}
