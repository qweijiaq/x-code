import { createModelRegistry, withLocalModels } from '@x-code-cli/core'

/** CLI 的模型注册表：在核心注册表外包一层本地模型解析，和桌面端一致。
 *  没有发现本地模型时，`withLocalModels` 会把所有 id 原样委托给核心。 */
export function createCliModelRegistry() {
  return withLocalModels(createModelRegistry())
}
