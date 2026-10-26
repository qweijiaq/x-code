// 共享的 provider 环境变量列表，供那些必须先清除开发者真实 shell 环境、
// 再断言“未配置任何 provider”行为的测试使用。它从 catalog 派生而来，
// 因此新增 provider 无需修改测试；OPENAI_COMPATIBLE_* 这一对由
// getAvailableProviders 读取。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resetOpenAIAuthContextForTesting } from '../src/auth/openai-chatgpt/auth-resolver.js'
import { PROVIDERS } from '../src/providers/catalog.js'
import { resetOpenAIChatGPTModelsForTesting } from '../src/providers/openai-chatgpt-models.js'

export const PROVIDER_ENV_VARS: readonly string[] = [
  ...PROVIDERS.map((p) => p.envKey),
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
]

/** 让 provider-policy 测试独立于开发者的真实 `xc login`。 */
export function isolateOpenAIAuth(): () => void {
  const previousHome = process.env.X_CODE_HOME
  const isolatedHome = path.join(os.tmpdir(), `x-code-provider-auth-${crypto.randomUUID()}`)
  process.env.X_CODE_HOME = isolatedHome
  resetOpenAIAuthContextForTesting()
  resetOpenAIChatGPTModelsForTesting()
  return () => {
    resetOpenAIAuthContextForTesting()
    resetOpenAIChatGPTModelsForTesting()
    if (previousHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = previousHome
    fs.rmSync(isolatedHome, { recursive: true, force: true })
  }
}
