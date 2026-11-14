// 用户可见的 provider 名称。模型/配置内部仍用稳定 id，界面不直接暴露 raw id。
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba Qwen',
  xai: 'xAI Grok',
  zhipu: 'Zhipu GLM',
  moonshotai: 'Moonshot Kimi',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  opendesign: 'OpenDesign',
  'opendesign-go': 'OpenDesign Go',
  custom: '自定义 / OpenAI-compatible',
}

export function providerDisplayName(name: string): string {
  return PROVIDER_LABELS[name] ?? name
}
