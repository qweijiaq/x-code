// 本地模型发现已经移到 core，CLI 和桌面端共用同一套实现。
// 保留这个文件作为桌面的薄转发层，避免改所有既有 import。
export {
  discoverLocalModels,
  isLocalModelId,
  localModelInfos,
  localProviderOf,
  withLocalModels,
} from '@x-code-cli/core'
export type { LocalModelInfo, LocalProvider } from '@x-code-cli/core'
