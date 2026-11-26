import { debugLog, refreshOpenAIChatGPTModels } from '@x-code-cli/core'

type RefreshModels = typeof refreshOpenAIChatGPTModels

let startupPreloadStarted = false

/** 为一次已认证的产品启动开始唯一一次正常的目录加载。 */
export function startChatGPTModelPreload(
  authMode: 'none' | 'api-key' | 'chatgpt',
  clientVersion: string,
  refreshModels: RefreshModels = refreshOpenAIChatGPTModels,
): boolean {
  if (authMode !== 'chatgpt' || startupPreloadStarted) return false
  startupPreloadStarted = true
  const logFailure = (error: unknown) => debugLog('openai-chatgpt.models-preload-failed', String(error))
  try {
    void refreshModels(clientVersion, { signal: AbortSignal.timeout(8_000) }).catch(logFailure)
  } catch (error) {
    // 即发即忘的预加载：同步抛错（注入实现、AbortSignal 构造）不能冒泡到
    // main() 去打断启动。
    logFailure(error)
  }
  return true
}

export function resetChatGPTModelPreloadForTesting(): void {
  startupPreloadStarted = false
}
