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
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  custom: 'Custom / OpenAI-compatible',
}

export function providerDisplayName(name: string): string {
  // provider 名来自用户配置 / CLI 参数（外部可控）：必须用自有属性判断，否则
  // `toString` / `constructor` 会命中原型链，把一个函数当成标签渲染出来。
  // 输入统一规范化（大小写混写的 `OpenAI` 也要命中映射表），空值给一个可读回退，
  // 保证返回类型真的是 string。
  const key = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (key === '') return 'Unknown provider'
  return Object.hasOwn(PROVIDER_LABELS, key) ? PROVIDER_LABELS[key]! : name
}
