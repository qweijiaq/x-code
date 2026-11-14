// @x-code-cli/core — OpenAI-compatible 网关 provider 定义
//
// 这些 provider 共用同一套 chat-completions 协议，只是端点不同。把默认端点
// 集中在这里，供 registry 构造和动态模型发现共用，避免两处各写一份。
export interface GatewayProviderDefinition {
  name: string
  defaultBaseUrl: string
}

export const GATEWAY_PROVIDERS: readonly GatewayProviderDefinition[] = [
  { name: 'opencode', defaultBaseUrl: 'https://opencode.ai/zen/v1' },
  { name: 'opencode-go', defaultBaseUrl: 'https://opencode.ai/zen/go/v1' },
  { name: 'opendesign', defaultBaseUrl: 'https://amr-link.open-design.ai/v1' },
  { name: 'opendesign-go', defaultBaseUrl: 'https://amr-link.open-design.ai/v1' },
]

export function gatewayBaseUrl(name: string, configured?: string): string {
  const trimmed = configured?.trim()
  if (trimmed) return trimmed
  return GATEWAY_PROVIDERS.find((provider) => provider.name === name)?.defaultBaseUrl ?? ''
}
