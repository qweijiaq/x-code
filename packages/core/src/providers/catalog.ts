// @x-code-cli/core — provider 元数据目录
//
// 每个 provider 静态已知信息的唯一事实来源：环境变量、默认模型、
// 精选的 /model 选择器条目、API-key 控制台 URL、多端点选项、推理强度档位。
// 添加 provider = 一条 PROVIDERS 条目（+ registry.ts 中的一个构造函数分支）。
// 底部的 PROVIDER_* 记录是派生视图，为既有调用方保持字节兼容。

// ─── 类型 ───

export interface ProviderModel {
  /** 传给 AI SDK 的完整 `<provider>:<model>` id */
  id: string
  /** 选择器中显示的简短标签 */
  label: string
  /** 标签下显示的一行描述 */
  description: string
  /** 该具体模型能否原生看图（多模态），而不只是其 provider 的 API 是否接受
   *  图片片段。驱动浏览器 agent 的视觉把关（modelSupportsVision），使纯文本
   *  模型永远不会获得 `--caps vision` / 截图。按模型设置是因为 provider 会在
   *  同一 id 命名空间下混用视觉与纯文本模型（如 DeepSeek Flash 对 V4 Pro、
   *  Qwen-VL 对 Qwen-Max、GLM-4V 对 GLM-5）。 */
  vision: boolean
}

export interface ProviderBaseUrlOption {
  label: string
  url: string
}

export interface ReasoningTierOption {
  label: string
  value: string
  description: string
}

export interface ReasoningTierProfile {
  /** 将本档位限制为匹配的模型 id。省略则作用于整个 provider。 */
  modelPattern?: RegExp
  options: readonly ReasoningTierOption[]
  /** 对拒绝关闭推理的模型，其最低有效强度。 */
  offValue?: string
}

export interface ProviderInfo {
  /** 用于 `<provider>:<model>` id 和配置映射中的 provider 键。 */
  name: string
  /** 读取 API key 的环境变量（从不写盘）。 */
  envKey: string
  /** 该 provider 在智能默认检测中胜出时使用的模型。 */
  defaultModel: string
  /** 用户可以申领 API key 的控制台页面。 */
  keyUrl: string
  /** 交互式 `/model` 选择器中展示的手工精选模型。用户仍可对未在此列出的
   *  变体，在 `/model <provider>:<model>` 中直接输入完整 id。vision 标志
   *  反映的是模型家族：Claude / GPT / Gemini / Grok 旗舰、DeepSeek Flash、
   *  Kimi K2.x 为多模态；Qwen-Max / GLM 文本旗舰与 DeepSeek V4 Pro 为纯文本；
   *  专门的 *-VL / GLM-4V / *-vision-preview 模型可看图。 */
  models: readonly ProviderModel[]
  /** 为同一 API 提供多个端点的 provider（区域平台、套餐专属网关等）。
   *  当用户从这类 provider 选择模型时，/model 流程会弹出选择器让其选择
   *  正确端点。所选 URL 持久化在 UserConfig.baseUrls 中，是唯一事实来源——
   *  不涉及环境变量。 */
  baseUrlOptions?: readonly ProviderBaseUrlOption[]
  /** 暴露细粒度推理强度旋钮（超出二元的开/关）的 provider。从这类 provider
   *  选择模型后，/model 会再弹出一个选择器让用户选择强度档位。所选档位按
   *  模型持久化在 UserConfig.modelReasoningEffort 中。
   *
   *  此处无条目的 provider（alibaba）仅支持二元的 /thinking 开关——跳过
   *  档位选择器。
   *
   *  `modelPattern` 把每个档位限制在实际遵循它的模型上：同一 provider 内
   *  只有部分模型家族暴露细粒度旋钮（如 thinkingLevel 仅 Gemini 3、
   *  Kimi 的 reasoningEffort 仅 K3）。不匹配的模型回退到二元 /thinking
   *  开关。 */
  reasoningTiers?: readonly ReasoningTierProfile[]
}

// ─── 数据表 ───
//
// 条目顺序 = /model 选择器中的展示顺序（PROVIDER_MODELS 的键序是可观察的
// UI）。智能默认检测改用下方的 DETECTION_ORDER。

const OPENDESIGN_MODELS: readonly ProviderModel[] = [
  {
    id: 'opendesign:deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    description: 'OpenDesign · fast DeepSeek tier, 1M context',
    vision: true,
  },
  {
    id: 'opendesign:deepseek-v4.1-flash-eco',
    label: 'DeepSeek V4.1 Flash Eco',
    description: 'OpenDesign · slower/cheaper DeepSeek tier for batch work',
    vision: true,
  },
  {
    id: 'opendesign:deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'OpenDesign · legacy ID, routed to V4.1 Flash',
    vision: true,
  },
  {
    id: 'opendesign:deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision Exp',
    description: 'OpenDesign · legacy vision ID, routed to V4.1 Flash',
    vision: true,
  },
  {
    id: 'opendesign:deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'OpenDesign · DeepSeek reasoning tier',
    vision: false,
  },
  {
    id: 'opendesign:claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    description: 'OpenDesign · fast Anthropic tier',
    vision: true,
  },
  {
    id: 'opendesign:gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'OpenDesign · cost-sensitive GPT-6 tier',
    vision: true,
  },
  {
    id: 'opendesign:glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    description: 'OpenDesign · fast Zhipu tier',
    vision: true,
  },
  {
    id: 'opendesign:glm-5.3-flashx',
    label: 'GLM-5.3 Flash-X',
    description: 'OpenDesign · faster Zhipu tier',
    vision: true,
  },
  {
    id: 'opendesign:kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: 'OpenDesign · coding model',
    vision: true,
  },
  {
    id: 'opendesign:mimo-v2.6-flash',
    label: 'MiMo V2.6 Flash',
    description: 'OpenDesign · fast MiMo tier',
    vision: true,
  },
  {
    id: 'opendesign:mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    description: 'OpenDesign · MiMo pro tier',
    vision: true,
  },
  {
    id: 'opendesign:minimax-m3.1-flash',
    label: 'MiniMax M3.1 Flash',
    description: 'OpenDesign · fast MiniMax tier',
    vision: true,
  },
  {
    id: 'opendesign:hy4-preview',
    label: 'Hunyuan H4 Preview',
    description: 'OpenDesign · Hunyuan preview model',
    vision: false,
  },
]

const OPENDESIGN_GO_MODELS: readonly ProviderModel[] = OPENDESIGN_MODELS.map((model) => ({
  ...model,
  id: model.id.replace(/^opendesign:/, 'opendesign-go:'),
  description: model.description.replace('OpenDesign ·', 'OpenDesign Go ·'),
}))

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'anthropic:claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/',
    models: [
      {
        id: 'anthropic:claude-fable-5-1',
        label: 'Fable 5.1',
        description: 'Newest adaptive-reasoning flagship, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-mythos-5-1',
        label: 'Mythos 5.1',
        description: 'Restricted-access flagship; requires an approved organization, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-mythos-5',
        label: 'Mythos 5',
        description: 'Restricted-access model for approved organizations, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-opus-5-5',
        label: 'Opus 5.5',
        description: 'Newest Opus, complex reasoning and agentic coding, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-opus-5',
        label: 'Opus 5',
        description: 'Previous Opus tier, complex reasoning and agentic coding, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-fable-5',
        label: 'Fable 5',
        description: 'Most capable model, strongest reasoning + agentic, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-opus-4-8',
        label: 'Opus 4.8',
        description: 'Top Opus-tier, complex reasoning + agentic coding, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-sonnet-5-5',
        label: 'Sonnet 5.5',
        description: 'Newest balanced tier, $2/$10, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-sonnet-5',
        label: 'Sonnet 5',
        description: 'Previous balanced tier, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-haiku-5-5',
        label: 'Haiku 5.5',
        description: 'Fastest, cheapest tier with effort levels, $0.10/$0.50',
        vision: true,
      },
      {
        id: 'anthropic:claude-haiku-4-5',
        label: 'Haiku 4.5',
        description: 'Previous fast tier, $1/$5, 200k context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /claude-(?:fable|mythos)-5(?:-1)?$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum adaptive reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /claude-(?:opus-(?:5-5|5|4-8)|sonnet-5-5|sonnet-5|haiku-5-5)$/,
        options: [
          { label: 'Low', value: 'low', description: 'Minimal reasoning, fastest' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'openai:gpt-6-astra',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      {
        id: 'openai:gpt-6-astra',
        label: 'GPT-6 Astra',
        description: 'Newest flagship, 1.05M context and 128k output',
        vision: true,
      },
      {
        id: 'openai:gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        description: 'Newest reasoning and coding tier, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-6.1-terra',
        label: 'GPT-6.1 Terra',
        description: 'Balanced tier of the 6.1 generation, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-6-sol',
        label: 'GPT-6 Sol',
        description: 'GPT-6 reasoning tier for complex coding, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-6-luna',
        label: 'GPT-6 Luna',
        description: 'Cost-sensitive GPT-6 tier, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Previous flagship reasoning and coding tier, $4/$20, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        description: 'Balanced tier, $2/$12, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        description: 'Budget tier, $0.20/$1.20, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        description: 'Cheap mini model, $0.75/$4.50',
        vision: true,
      },
      {
        id: 'openai:gpt-5.4-nano',
        label: 'GPT-5.4 Nano',
        description: 'Cheapest, $0.20/$1.25',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gpt-6-astra$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-6\.1(?:-(?:sol|terra|luna))?$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-6(?:-(?:sol|luna))?$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-5\.6(?:-(?:sol|terra|luna))?$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-5\.5$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-5\.4-(?:mini|nano)$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced (default)' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek:deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      {
        id: 'deepseek:deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Latest fast, efficient model with native vision and 1M context',
        vision: true,
      },
      {
        id: 'deepseek:deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'Flagship V4 model with 1M context and text-only API surface',
        vision: false,
      },
    ],
    reasoningTiers: [
      {
        // Flash 与 V4 Pro 支持 low/high/max；medium/xhigh 在服务端映射到 high。
        modelPattern: /deepseek-(?:flash|v4)/,
        options: [
          { label: 'Low', value: 'low', description: 'Faster, less reasoning' },
          { label: 'High', value: 'high', description: 'Standard reasoning (default)' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'alibaba',
    envKey: 'ALIBABA_API_KEY',
    defaultModel: 'alibaba:qwen3.8-max',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    baseUrlOptions: [
      { label: 'China (dashscope.aliyuncs.com)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: 'Singapore (dashscope-intl)', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { label: 'US (dashscope-us)', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
    ],
    models: [
      {
        id: 'alibaba:qwen3.8-max',
        label: 'Qwen3.8 Max',
        description: 'Newest flagship with native vision, 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.8-flash',
        label: 'Qwen3.8 Flash',
        description: 'Fast multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.7-max',
        label: 'Qwen3.7 Max',
        description: 'Latest flagship, 1M context, reasoning-native',
        vision: false,
      },
      {
        id: 'alibaba:qwen3.7-plus',
        label: 'Qwen3.7 Plus',
        description: 'Multimodal mid-tier with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.7-flash',
        label: 'Qwen3.7 Flash',
        description: 'Fast multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3-coder-plus',
        label: 'Qwen3 Coder Plus',
        description: 'Coding-focused, 1M context',
        vision: false,
      },
      {
        id: 'alibaba:qwq-plus',
        label: 'QwQ Plus',
        description: 'Dedicated reasoning model',
        vision: false,
      },
      {
        id: 'alibaba:qwen3-vl-plus',
        label: 'Qwen3-VL Plus',
        description: 'Vision-language flagship',
        vision: true,
      },
      {
        id: 'alibaba:qwen3-vl-flash',
        label: 'Qwen3-VL Flash',
        description: 'Cheap/fast vision-language model',
        vision: true,
      },
    ],
  },
  {
    name: 'google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    defaultModel: 'google:gemini-4-argon',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      {
        id: 'google:gemini-4-argon',
        label: 'Gemini 4 Argon',
        description: 'Newest Gemini flagship, 1M context and up to 1M output',
        vision: true,
      },
      {
        id: 'google:gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: 'Newest multimodal flagship, 1M context and 64k output',
        vision: true,
      },
      {
        id: 'google:gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        description: 'Deprecated; requests auto-route to Gemini 3.8 Flash',
        vision: true,
      },
      {
        id: 'google:gemini-3.6-flash',
        label: 'Gemini 3.6 Flash',
        description: 'Fast multimodal agentic model, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        description: 'Deprecated; requests auto-route to Gemini 3.6 Flash',
        vision: true,
      },
      {
        id: 'google:gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite',
        description: 'Cheapest Flash-Lite tier, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        description: 'Legacy Pro; auto-routes to Gemini 3.8 Flash after 2026-12-01',
        vision: true,
      },
      {
        id: 'google:gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: 'Cheaper/faster tier, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gemini-4-argon$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
      {
        modelPattern: /gemini-3\.[78]-flash$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
      {
        modelPattern: /gemini-3\.[56]-flash$/,
        offValue: 'minimal',
        options: [
          { label: 'Minimal', value: 'minimal', description: 'Minimum supported reasoning' },
          { label: 'Low', value: 'low', description: 'Lower latency, lower cost' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
    ],
  },
  {
    name: 'xai',
    envKey: 'XAI_API_KEY',
    defaultModel: 'xai:grok-4.7',
    keyUrl: 'https://console.x.ai/',
    models: [
      {
        id: 'xai:grok-4.7',
        label: 'Grok 4.7',
        description: 'Newest reasoning flagship, vision and 500k context',
        vision: true,
      },
      {
        id: 'xai:grok-4.6',
        label: 'Grok 4.6',
        description: 'Previous flagship; always-reasoning, text-only, 500k context',
        vision: false,
      },
      {
        id: 'xai:grok-4.20-0309-reasoning',
        label: 'Grok 4.20 Reasoning',
        description: 'Fixed-reasoning model with native vision and 2M context',
        vision: true,
      },
      {
        id: 'xai:grok-4.20-0309-non-reasoning',
        label: 'Grok 4.20 Non-Reasoning',
        description: 'Low-latency non-reasoning variant with 2M context',
        vision: true,
      },
      {
        id: 'xai:grok-4.5',
        label: 'Grok 4.5',
        description: 'Agentic coding tier; always-reasoning, text-only, 500k context',
        vision: false,
      },
      {
        id: 'xai:grok-4.3',
        label: 'Grok 4.3',
        description: 'General-purpose, $1.25/$2.50, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /grok-4\.7$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning (default)' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
        ],
      },
      {
        modelPattern: /grok-4\.6$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
        ],
      },
      {
        modelPattern: /grok-4\.5$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /grok-4\.3$/,
        options: [
          { label: 'Low', value: 'low', description: 'Faster, cheaper responses' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
        ],
      },
    ],
  },
  {
    name: 'zhipu',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'zhipu:glm-5.3',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    baseUrlOptions: [
      { label: 'China (open.bigmodel.cn)', url: 'https://open.bigmodel.cn/api/paas/v4' },
      { label: 'International (api.z.ai)', url: 'https://api.z.ai/api/paas/v4' },
      {
        label: 'Coding Plan China (open.bigmodel.cn)',
        url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      },
      {
        label: 'Coding Plan International (api.z.ai)',
        url: 'https://api.z.ai/api/coding/paas/v4',
      },
    ],
    models: [
      {
        id: 'zhipu:glm-5.3',
        label: 'GLM-5.3',
        description: 'Newest reasoning flagship with 1M context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5.3-flash',
        label: 'GLM-5.3 Flash',
        description: 'Fast native-multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'zhipu:glm-5.2',
        label: 'GLM-5.2',
        description: 'Latest flagship, $1.40/$4.40, 1M context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5',
        label: 'GLM-5',
        description: 'Agentic engineering model, $1/$3.20, 200k context',
        vision: false,
      },
      {
        id: 'zhipu:glm-4.7',
        label: 'GLM-4.7',
        description: 'Cost-efficient, $0.60/$2.20, 128k context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5v-turbo',
        label: 'GLM-5V Turbo',
        description: 'Vision model, $1.20/$4',
        vision: true,
      },
      {
        id: 'zhipu:glm-4.6v',
        label: 'GLM-4.6V',
        description: 'Cheap vision model, $0.30/$0.90',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /glm-5\.3(?:-flash)?$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'High', value: 'high', description: 'Enhanced reasoning' },
          { label: 'Max', value: 'max', description: 'Deep reasoning (default)' },
        ],
      },
      {
        modelPattern: /glm-5\.2$/,
        options: [
          { label: 'Low', value: 'low', description: 'Light reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Enhanced reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Deep reasoning (default)' },
        ],
      },
    ],
  },
  {
    name: 'moonshotai',
    envKey: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshotai:kimi-k3.1-pro',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    models: [
      {
        id: 'moonshotai:kimi-k3.1-pro',
        label: 'Kimi K3.1 Pro',
        description: 'Newest flagship, 3T-class, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k3.1-pro-highspeed',
        label: 'Kimi K3.1 Pro Highspeed',
        description: 'High-speed K3.1 Pro, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k3',
        label: 'Kimi K3',
        description: 'Previous-generation flagship, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.7-code',
        label: 'Kimi K2.7 Code (Legacy)',
        description: 'Legacy coding model; unavailable to accounts registered after 2026-11-01',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.7-code-highspeed',
        label: 'Kimi K2.7 Code Highspeed (Legacy)',
        description: 'Legacy high-speed coding model; unavailable to new accounts',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.6',
        label: 'Kimi K2.6 (Legacy)',
        description: 'Legacy multimodal model; unavailable to new accounts',
        vision: true,
      },
    ],
    baseUrlOptions: [
      { label: 'api.kimi.com/coding (Coding Plan, China)', url: 'https://api.kimi.com/coding/v1' },
      { label: 'api.kimi.ai/coding (Coding Plan, International)', url: 'https://api.kimi.ai/coding/v1' },
      { label: 'api.moonshot.cn (China)', url: 'https://api.moonshot.cn/v1' },
      { label: 'api.moonshot.ai (International)', url: 'https://api.moonshot.ai/v1' },
    ],
    reasoningTiers: [
      {
        // reasoning_effort 支持 K3.1 Pro 和 K3；K2.x 使用二元 thinking 开关。
        modelPattern: /kimi-k3(?:\.1-pro)?/,
        options: [
          { label: 'Low', value: 'low', description: 'Faster, concise reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning (default)' },
        ],
      },
    ],
  },
  {
    name: 'opencode',
    envKey: 'OPENCODE_API_KEY',
    defaultModel: 'opencode:kimi-k3',
    keyUrl: 'https://opencode.ai/console',
    models: [
      {
        id: 'opencode:kimi-k3',
        label: 'Kimi K3',
        description: 'OpenCode Zen · flagship coding model',
        vision: true,
      },
      {
        id: 'opencode:qwen3.8-max',
        label: 'Qwen3.8 Max',
        description: 'OpenCode Zen · high-capacity Qwen flagship',
        vision: false,
      },
      {
        id: 'opencode:deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'OpenCode Zen · DeepSeek reasoning tier',
        vision: false,
      },
      {
        id: 'opencode:deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'OpenCode Zen · fast, cheaper DeepSeek tier',
        vision: false,
      },
      {
        id: 'opencode:glm-5.3',
        label: 'GLM-5.3',
        description: 'OpenCode Zen · Zhipu text flagship',
        vision: false,
      },
      {
        id: 'opencode:minimax-m3',
        label: 'MiniMax M3',
        description: 'OpenCode Zen · long-context MiniMax model',
        vision: false,
      },
      {
        id: 'opencode:kimi-k2.7-code',
        label: 'Kimi K2.7 Code',
        description: 'OpenCode Zen · legacy coding model',
        vision: true,
      },
    ],
  },
  {
    name: 'opencode-go',
    envKey: 'OPENCODE_GO_API_KEY',
    defaultModel: 'opencode-go:kimi-k3',
    keyUrl: 'https://opencode.ai/console',
    models: [
      {
        id: 'opencode-go:kimi-k3',
        label: 'Kimi K3',
        description: 'OpenCode Go · flagship coding model',
        vision: true,
      },
      {
        id: 'opencode-go:claude-haiku-5-5',
        label: 'Claude Haiku 5.5',
        description: 'OpenCode Go · fast Anthropic tier',
        vision: true,
      },
      {
        id: 'opencode-go:gemini-4-argon',
        label: 'Gemini 4 Argon',
        description: 'OpenCode Go · Google flagship',
        vision: true,
      },
      {
        id: 'opencode-go:gpt-6-luna',
        label: 'GPT-6 Luna',
        description: 'OpenCode Go · cost-sensitive GPT-6 tier',
        vision: true,
      },
      {
        id: 'opencode-go:grok-4.7',
        label: 'Grok 4.7',
        description: 'OpenCode Go · xAI flagship',
        vision: true,
      },
      {
        id: 'opencode-go:deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'OpenCode Go · DeepSeek reasoning tier',
        vision: false,
      },
      {
        id: 'opencode-go:glm-5.3',
        label: 'GLM-5.3',
        description: 'OpenCode Go · Zhipu text flagship',
        vision: false,
      },
      {
        id: 'opencode-go:minimax-m3.1-flash',
        label: 'MiniMax M3.1 Flash',
        description: 'OpenCode Go · fast MiniMax tier',
        vision: false,
      },
      {
        id: 'opencode-go:qwen3.8-max',
        label: 'Qwen3.8 Max',
        description: 'OpenCode Go · high-capacity Qwen flagship',
        vision: false,
      },
    ],
  },
  {
    name: 'opendesign',
    envKey: 'OPENDESIGN_API_KEY',
    defaultModel: 'opendesign:deepseek-v4.1-flash',
    keyUrl: 'https://open-design.ai/cloud/api-keys',
    models: OPENDESIGN_MODELS,
  },
  {
    name: 'opendesign-go',
    envKey: 'OPENDESIGN_GO_API_KEY',
    defaultModel: 'opendesign-go:deepseek-v4.1-flash',
    keyUrl: 'https://open-design.ai/cloud/api-keys',
    models: OPENDESIGN_GO_MODELS,
  },
]

// ─── 模型别名 ───

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5-1',
  sonnet: 'anthropic:claude-sonnet-5-5',
  opus: 'anthropic:claude-opus-5-5',
  haiku: 'anthropic:claude-haiku-5-5',
  gpt6: 'openai:gpt-6-astra',
  astra: 'openai:gpt-6-astra',
  gpt5: 'openai:gpt-5.6-sol',
  gemini: 'google:gemini-3.8-flash',
  deepseek: 'deepseek:deepseek-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.8-max',
  grok: 'xai:grok-4.7',
  glm: 'zhipu:glm-5.3',
  kimi: 'moonshotai:kimi-k3.1-pro',
  opencode: 'opencode:kimi-k3',
  'opencode-go': 'opencode-go:kimi-k3',
  opendesign: 'opendesign:deepseek-v4.1-flash',
  'opendesign-go': 'opendesign-go:deepseek-v4.1-flash',
}

// ─── 派生视图（为既有调用方保留的旧形态）───

/** 智能默认检测顺序：第一个有 key 的 provider 胜出。这不是表格/展示顺序——
 *  deepseek 有意排在探测首位。 */
const DETECTION_ORDER = [
  'deepseek',
  'anthropic',
  'openai',
  'alibaba',
  'google',
  'xai',
  'zhipu',
  'moonshotai',
  'opencode',
  'opencode-go',
  'opendesign',
  'opendesign-go',
] as const

export const PROVIDER_DETECTION_ORDER = DETECTION_ORDER.map((name) => {
  const p = PROVIDERS.find((provider) => provider.name === name)!
  return { envKey: p.envKey, defaultModel: p.defaultModel }
})

export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = Object.fromEntries(
  PROVIDERS.map((p) => [p.name, p.models]),
)

export const PROVIDER_KEY_URLS: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.name, p.keyUrl]))

export const PROVIDER_BASE_URLS: Record<string, { options: readonly ProviderBaseUrlOption[] }> = Object.fromEntries(
  PROVIDERS.filter((p) => p.baseUrlOptions).map((p) => [p.name, { options: p.baseUrlOptions! }]),
)

export const PROVIDER_REASONING_PROFILES: Record<string, readonly ReasoningTierProfile[]> = Object.fromEntries(
  PROVIDERS.filter((p) => p.reasoningTiers).map((p) => [p.name, p.reasoningTiers!]),
)

/** 为公共 API 兼容性保留的旧版 provider 级视图。内部模型选择使用
 *  PROVIDER_REASONING_PROFILES，使每个家族只获得其实际支持的强度值。 */
export const PROVIDER_REASONING_TIERS: Record<
  string,
  { modelPattern?: RegExp; options: readonly ReasoningTierOption[] }
> = Object.fromEntries(
  Object.entries(PROVIDER_REASONING_PROFILES).map(([name, profiles]) => {
    const options = Array.from(
      new Map(profiles.flatMap((profile) => profile.options).map((option) => [option.value, option])).values(),
    )
    const patterns = profiles.map((profile) => profile.modelPattern).filter((pattern) => pattern !== undefined)
    const modelPattern =
      patterns.length === profiles.length ? new RegExp(patterns.map((pattern) => pattern.source).join('|')) : undefined
    return [name, { ...(modelPattern ? { modelPattern } : {}), options }]
  }),
)
