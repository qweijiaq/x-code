// @x-code-cli/core — 配置解析
//
// API key 始终来自环境变量（各提供商的专属 key，
// 如 ANTHROPIC_API_KEY / ALIBABA_API_KEY —— 绝不落盘存储）。
//
// 默认 **model** 可来自四个来源，按优先级排序：
//   1. `--model` CLI 标志（显式 `input` 参数）
//   2. `~/.x-code/config.json` 的 `model` 字段 —— 由 `/model` 选择器写入
//   3. `X_CODE_MODEL` 环境变量
//   4. 智能默认：按 PROVIDER_DETECTION_ORDER 第一个有 key 的提供商
//
// 选择器的选择优先于环境变量，这样 `/model` 才能在重启后“固定”下来 ——
// 否则在 shell / .env 里设置了 `X_CODE_MODEL` 的用户会发现下次启动时
// 自己的 `/model` 选择被静默回退（已报告的 bug）。
import fsSync from 'node:fs'
import path from 'node:path'

import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
import { MODEL_ALIASES, PROVIDERS, PROVIDER_DETECTION_ORDER } from '../providers/catalog.js'
import { userXcodeDir } from '../utils.js'

/** 提供商 → 环境变量的映射，由目录派生。 */
const ENV_MAP: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.name, p.envKey]))

/** 获取某个提供商的 API key —— 只从环境变量读取 */
function getApiKey(provider: string): string | undefined {
  if (provider === 'openai') {
    const auth = getOpenAIAuthContext()
    return auth.mode === 'api-key' ? auth.apiKey : undefined
  }
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}

/** 获取某个提供商的环境变量名 */
export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider]
}

/** 检查哪些提供商已配置 API key（仅环境变量） */
export function getAvailableProviders(): string[] {
  const openAIAuth = getOpenAIAuthContext()
  const providers = Object.keys(ENV_MAP).filter((provider) =>
    provider === 'openai' ? openAIAuth.mode !== 'none' : !!getApiKey(provider),
  )
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

/**
 * 按四级优先级解析模型 ID：
 *   1. 显式 `input`（例如 --model CLI 标志）
 *   2. `~/.x-code/config.json` 的 `model` 字段（由 /model 选择器写入）
 *   3. `X_CODE_MODEL` 环境变量
 *   4. 智能默认：按 PROVIDER_DETECTION_ORDER 第一个有 API key 的提供商
 *
 * MODEL_ALIASES 里的别名（如 "sonnet" → "anthropic:claude-sonnet-4-5"）
 * 会在所有层级展开。未配置任何提供商时返回 null。
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? loadUserConfig().model ?? process.env.X_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (envKey === 'OPENAI_API_KEY' ? getOpenAIAuthContext().mode !== 'none' : !!process.env[envKey]) {
      return defaultModel
    }
  }

  return null
}

// ── 用户配置文件（~/.x-code/config.json）────────────────────────────
//
// 持久化偏好：
//   model    — /model 选择器最近一次提交的 id
//   thinking — 由 /thinking 写入的扩展思考 / 推理开关。
//              对暴露 thinking 开关的提供商统一生效
//              （见 providers/thinking.ts）。默认是 undefined
//              （视为关闭），这样朴素的启动不会在默认关闭的提供商
//              （Sonnet、DeepSeek、Qwen）上悄悄引入 2-10 倍延迟 ——
//              与功能上线前的基线一致。
//
// API key 特意不存储在这里（仅环境变量，见文件头注释）。

/** 默认启用的一次性视觉检查与交互式 `browser` 子代理共享的设置。
 *  `enabled` 只控制子代理；headless/channel/viewport 设置作用于它们共享的、
 *  惰性启动的 @playwright/mcp 浏览器进程。 */
export interface BrowserConfig {
  /** 启用交互式浏览器子代理。一次性本地视觉检查
   *  不需要这个开关。 */
  enabled?: boolean
  /** 为本地 Web UI 启用自动一次性视觉检查。默认 true；
   *  与交互式浏览器代理开关相互独立。 */
  visualCheck?: boolean
  /** 无头运行（无可见窗口）。默认：可见，这样用户能看到
   *  代理驱动浏览器。 */
  headless?: boolean
  /** @playwright/mcp 驱动的浏览器渠道。默认 'chrome' —— 用户
   *  已安装的 Google Chrome（无需下载 Chromium）。 */
  browser?: 'chrome' | 'chromium' | 'msedge' | 'firefox' | 'webkit'
  /** 浏览器视口尺寸，形如 "width,height"（px）。默认 '1280,800'。它限制
   *  截图分辨率 —— 视觉 token 成本随图像尺寸增长，因此
   *  更小的视口意味着更便宜的截图。仅当某网站需要
   *  更宽布局才能正确渲染时才调大它。 */
  viewport?: string
  /** 额外的基于坐标的浏览器控制。除非显式为 false，
   *  托管服务器都会以稳定的视觉能力超集启动，这样之后切换模型
   *  就不必重启 Chrome 并丢失标签页。
   *  只有当当前或借用的视觉模型确实能解读截图时，浏览器代理
   *  才会收到这些控制。 */
  vision?: boolean
  /** 完全覆盖启动命令（高级用法：离线、固定版本、
   *  自定义服务器）。设置后，`args` 原样传入。 */
  command?: string
  args?: string[]
}

const BROWSER_CHANNELS = new Set<NonNullable<BrowserConfig['browser']>>([
  'chrome',
  'chromium',
  'msedge',
  'firefox',
  'webkit',
])
const BROWSER_VIEWPORT_RE = /^(\d{3,4})\s*[,x]\s*(\d{3,4})$/i

/** 在构造 MCP 命令前清洗手工编辑的浏览器设置。
 *  非法的可选字段回退到托管默认值；仅当其 argv 是纯字符串数组时
 *  才保留命令覆盖。 */
export function resolveBrowserConfig(value: unknown): BrowserConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const browser =
    typeof raw.browser === 'string' && BROWSER_CHANNELS.has(raw.browser as NonNullable<BrowserConfig['browser']>)
      ? (raw.browser as NonNullable<BrowserConfig['browser']>)
      : undefined
  let viewport: string | undefined
  if (typeof raw.viewport === 'string') {
    const match = BROWSER_VIEWPORT_RE.exec(raw.viewport.trim())
    const width = Number(match?.[1])
    const height = Number(match?.[2])
    if (match && width >= 320 && width <= 1_920 && height >= 320 && height <= 1_200) {
      viewport = `${width},${height}`
    }
  }
  const argsAreValid =
    raw.args === undefined || (Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === 'string'))
  const command = typeof raw.command === 'string' && raw.command.trim() && argsAreValid ? raw.command.trim() : undefined
  const args = command && Array.isArray(raw.args) ? (raw.args as string[]) : undefined
  return {
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.visualCheck === 'boolean' ? { visualCheck: raw.visualCheck } : {}),
    ...(typeof raw.headless === 'boolean' ? { headless: raw.headless } : {}),
    ...(browser ? { browser } : {}),
    ...(viewport ? { viewport } : {}),
    ...(typeof raw.vision === 'boolean' ? { vision: raw.vision } : {}),
    ...(command ? { command } : {}),
    ...(command && args ? { args } : {}),
  }
}

export interface MemoryRecallConfig {
  maxTopicsPerTurn: number
  maxTokensPerTopic: number
  maxTokensPerTurn: number
  maxTokensPerCompactionWindow: number
  semanticSelector: 'auto' | 'off'
  selectorModel: string
  lateBoundRecall: boolean
}

export type MemoryReasoningMode = 'auto' | 'off' | 'low' | 'provider-default'

export interface MemoryConfig {
  model: string
  reasoning: MemoryReasoningMode
  maxInputTokens: number
  maxOutputTokens: number
  maxTotalOutputTokens: number
  maxOperationsPerTurn: number
  drainTimeoutMs: number
  retryMaxAttempts: number
  recall: MemoryRecallConfig
}

export interface StreamConfig {
  /** 提供商流断开后的应用层重连尝试次数。
   *  与 AI SDK 的建连重试相互独立。 */
  maxRetries: number
  /** 流块之间允许的最长静默时间。0 表示关闭
   *  看门狗；默认值也覆盖了因系统休眠而失效的 socket。 */
  idleTimeoutMs: number
}

export const DEFAULT_STREAM_CONFIG: Readonly<StreamConfig> = {
  maxRetries: 5,
  idleTimeoutMs: 300_000,
}

export interface PeerMessagingConfig {
  inbound: 'auto' | 'accept' | 'hold' | 'refuse'
  dialogExpiryMs: number
}

export const DEFAULT_PEER_MESSAGING_CONFIG: Readonly<PeerMessagingConfig> = {
  inbound: 'auto',
  dialogExpiryMs: 300_000,
}

export function resolvePeerMessagingConfig(value: unknown): PeerMessagingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PEER_MESSAGING_CONFIG }
  const raw = value as Record<string, unknown>
  const inbound =
    raw.inbound === 'auto' || raw.inbound === 'accept' || raw.inbound === 'hold' || raw.inbound === 'refuse'
      ? raw.inbound
      : DEFAULT_PEER_MESSAGING_CONFIG.inbound
  return {
    inbound,
    dialogExpiryMs:
      typeof raw.dialogExpiryMs === 'number' &&
      Number.isSafeInteger(raw.dialogExpiryMs) &&
      raw.dialogExpiryMs >= 10_000 &&
      raw.dialogExpiryMs <= 1_800_000
        ? raw.dialogExpiryMs
        : DEFAULT_PEER_MESSAGING_CONFIG.dialogExpiryMs,
  }
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = {
  model: 'inherit',
  reasoning: 'auto',
  maxInputTokens: 12_000,
  maxOutputTokens: 1500,
  maxTotalOutputTokens: 8192,
  maxOperationsPerTurn: 8,
  drainTimeoutMs: 5000,
  retryMaxAttempts: 8,
  recall: {
    maxTopicsPerTurn: 5,
    maxTokensPerTopic: 1500,
    maxTokensPerTurn: 4000,
    maxTokensPerCompactionWindow: 15_000,
    semanticSelector: 'auto',
    selectorModel: 'inherit',
    lateBoundRecall: true,
  },
}

export function resolveMemoryConfig(config: UserConfig = loadUserConfig()): MemoryConfig {
  const memory =
    config.memory && typeof config.memory === 'object' && !Array.isArray(config.memory)
      ? (config.memory as Record<string, unknown>)
      : {}
  const recallValue = memory.recall
  const recall =
    recallValue && typeof recallValue === 'object' && !Array.isArray(recallValue)
      ? (recallValue as Record<string, unknown>)
      : {}
  const integer = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const maxTokensPerTopic = integer(
    recall.maxTokensPerTopic,
    DEFAULT_MEMORY_CONFIG.recall.maxTokensPerTopic,
    100,
    10_000,
  )
  const maxTokensPerTurn = Math.max(
    maxTokensPerTopic,
    integer(recall.maxTokensPerTurn, DEFAULT_MEMORY_CONFIG.recall.maxTokensPerTurn, 100, 20_000),
  )
  const maxOutputTokens = integer(memory.maxOutputTokens, DEFAULT_MEMORY_CONFIG.maxOutputTokens, 128, 8192)
  return {
    model: text(memory.model, DEFAULT_MEMORY_CONFIG.model),
    reasoning:
      memory.reasoning === 'auto' ||
      memory.reasoning === 'off' ||
      memory.reasoning === 'low' ||
      memory.reasoning === 'provider-default'
        ? memory.reasoning
        : DEFAULT_MEMORY_CONFIG.reasoning,
    maxInputTokens: integer(memory.maxInputTokens, DEFAULT_MEMORY_CONFIG.maxInputTokens, 1000, 100_000),
    maxOutputTokens,
    maxTotalOutputTokens: Math.max(
      maxOutputTokens,
      integer(memory.maxTotalOutputTokens, DEFAULT_MEMORY_CONFIG.maxTotalOutputTokens, 128, 65_536),
    ),
    maxOperationsPerTurn: integer(memory.maxOperationsPerTurn, DEFAULT_MEMORY_CONFIG.maxOperationsPerTurn, 1, 8),
    drainTimeoutMs: integer(memory.drainTimeoutMs, DEFAULT_MEMORY_CONFIG.drainTimeoutMs, 0, 30_000),
    retryMaxAttempts: integer(memory.retryMaxAttempts, DEFAULT_MEMORY_CONFIG.retryMaxAttempts, 1, 8),
    recall: {
      maxTopicsPerTurn: integer(recall.maxTopicsPerTurn, DEFAULT_MEMORY_CONFIG.recall.maxTopicsPerTurn, 1, 5),
      maxTokensPerTopic,
      maxTokensPerTurn,
      maxTokensPerCompactionWindow: Math.max(
        maxTokensPerTurn,
        integer(
          recall.maxTokensPerCompactionWindow,
          DEFAULT_MEMORY_CONFIG.recall.maxTokensPerCompactionWindow,
          100,
          100_000,
        ),
      ),
      semanticSelector:
        recall.semanticSelector === 'auto' || recall.semanticSelector === 'off'
          ? recall.semanticSelector
          : DEFAULT_MEMORY_CONFIG.recall.semanticSelector,
      selectorModel: text(recall.selectorModel, DEFAULT_MEMORY_CONFIG.recall.selectorModel),
      lateBoundRecall:
        typeof recall.lateBoundRecall === 'boolean'
          ? recall.lateBoundRecall
          : DEFAULT_MEMORY_CONFIG.recall.lateBoundRecall,
    },
  }
}

export function resolveStreamConfig(config: UserConfig = loadUserConfig()): StreamConfig {
  const stream =
    config.stream && typeof config.stream === 'object' && !Array.isArray(config.stream)
      ? (config.stream as Record<string, unknown>)
      : {}
  const maxRetries =
    typeof stream.maxRetries === 'number' &&
    Number.isSafeInteger(stream.maxRetries) &&
    stream.maxRetries >= 0 &&
    stream.maxRetries <= 100
      ? stream.maxRetries
      : DEFAULT_STREAM_CONFIG.maxRetries
  const idleTimeoutMs =
    stream.idleTimeoutMs === 0 ||
    (typeof stream.idleTimeoutMs === 'number' &&
      Number.isSafeInteger(stream.idleTimeoutMs) &&
      stream.idleTimeoutMs >= 100 &&
      stream.idleTimeoutMs <= 3_600_000)
      ? stream.idleTimeoutMs
      : DEFAULT_STREAM_CONFIG.idleTimeoutMs
  return { maxRetries, idleTimeoutMs }
}

export interface UserConfig {
  model?: string
  thinking?: boolean
  /** 用户强制的上下文窗口（token 数）。统一覆盖模型/提供商元数据，
   *  直到用 `/context reset` 清除。 */
  contextWindow?: number
  /** 显式选择更小的标准工具集。 */
  experimentalToolProfile?: 'full' | 'standard'
  /** 持久化的 UI 主题名。既驱动 diff 背景色，也驱动
   *  对应的语法高亮配色。加载时由 CLI 的 `parseThemeName` 校验；
   *  这里类型保持宽松的 `string`，因为 core 不依赖 CLI 的主题列表。
   *  未知值静默回退到默认值（'dark'）。 */
  theme?: string
  /** MCP 服务器声明。这里保持宽松类型，因为模式在
   *  `mcp/config-schema.ts` 中校验 —— 我们不想把 Zod 类型
   *  拖进 config 模块的接口。加载器在构造客户端前用
   *  `parseServersBlock` 校验。 */
  mcpServers?: Record<string, unknown>
  /** 托管浏览器设置。`enabled === true` 注册交互式
   *  Browser Use；视觉检查保持默认开启，除非显式为 false。 */
  browser?: BrowserConfig
  /** 通过 /model tier 选择器为各模型选择的推理努力等级。
   *  Key = 完整模型 id（如 "openai:gpt-5.6-sol"），value = 努力标签
   *  （如 "medium"）。存在时，它覆盖该模型的 /thinking 开关 ——
   *  tier 知道用户真正想要什么；/thinking 是给没有显式 tier 的
   *  模型用的粗略回退。 */
  modelReasoningEffort?: Record<string, string>
  /** 多端点提供商的 base URL，通过 /model base-URL
   *  选择器选择。Key = 提供商 key（如 "moonshotai"），value = 完整 base URL
   *  （如 "https://api.moonshot.cn/v1"）。 */
  baseUrls?: Record<string, string>
  /** 提供商流恢复。默认五次重连尝试和一个
   *  五分钟无活动看门狗。 */
  stream?: Partial<StreamConfig>
  memory?: Partial<Omit<MemoryConfig, 'recall'>> & { recall?: Partial<MemoryRecallConfig> }
  peerMessaging?: Partial<PeerMessagingConfig>
}

/** 用户配置文件的路径。暴露出来是为了让其他想读取同一份 JSON 的模块
 *  （例如 MCP 加载器读 `mcpServers` 字段）能自动遵循 X_CODE_HOME 覆盖。 */
export function getUserConfigPath(): string {
  return path.join(userXcodeDir(), 'config.json')
}

/** 读取用户配置。任何失败（文件缺失、解析错误、形状不对）都返回空对象，
 *  这样调用方无需判空。 */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(getUserConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const config = parsed as UserConfig
      if ('browser' in config) config.browser = resolveBrowserConfig(config.browser)
      if ('peerMessaging' in config) config.peerMessaging = resolvePeerMessagingConfig(config.peerMessaging)
      return config
    }
  } catch {
    // 文件可能尚不存在，或格式损坏 —— 两种情况都回退到 {}
  }
  return {}
}

/** 把一次部分更新写入用户配置，保留其他键。返回
 *  新配置是否已落盘，以便交互式命令能报告失败。 */
export function saveUserConfig(update: Partial<UserConfig>): boolean {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    // mkdir 的根目录与 getUserConfigPath() 指向的根一致 —— 否则
    // X_CODE_HOME 覆盖会创建 `~/.x-code/` 却写到覆盖目录，
    // 写操作会因父目录缺失而静默失败。
    fsSync.mkdirSync(userXcodeDir(), { recursive: true })
    fsSync.writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    return true
  } catch {
    // 尽力而为：配置目录只读时也不要让 UI 崩溃。
    return false
  }
}

/** 用来自环境变量的 API key 构建提供商选项 */
export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    google: getApiKey('google'),
    xai: getApiKey('xai'),
    deepseek: getApiKey('deepseek'),
    alibaba: getApiKey('alibaba'),
    zhipu: getApiKey('zhipu'),
    moonshotai: getApiKey('moonshotai'),
    custom: {
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  }
}
