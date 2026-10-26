// @x-code-cli/core — AI SDK provider 注册表（多模型支持）
import { createAlibaba } from '@ai-sdk/alibaba'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogle } from '@ai-sdk/google'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry, customProvider } from 'ai'

import { getOpenAIAuthSnapshot, refreshOpenAIAuthSnapshot } from '../auth/openai-chatgpt/auth-resolver.js'
import type { OpenAIAuthSnapshot } from '../auth/openai-chatgpt/auth-resolver.js'
import { getOpenAIChatGPTTokenManager } from '../auth/openai-chatgpt/token-manager.js'
import { getProviderOptions, loadUserConfig } from '../config/index.js'
import { OPENAI_SESSION_ID_HEADER, XAI_PROMPT_CACHE_KEY_HEADER } from './cache-control.js'
import { createOpenAIChatGPTFetch } from './openai-chatgpt-fetch.js'

const KIMI_CODING_MODEL_IDS = {
  'kimi-k3': 'k3',
  // 稳定的 Coding Plan id 目前自动路由到 K2.8 Preview。
  'kimi-k2.7-code': 'kimi-for-coding',
  'kimi-k2.7-code-highspeed': 'kimi-for-coding-highspeed',
  // Coding Plan 通过关闭 kimi-for-coding 的 thinking 来暴露 K2.6，
  // 而非使用独立的模型 id。
  'kimi-k2.6': 'kimi-for-coding',
} as const

export function kimiCodingModelId(modelId: string): string {
  return KIMI_CODING_MODEL_IDS[modelId as keyof typeof KIMI_CODING_MODEL_IDS] ?? modelId
}

function unavailableOpenAIResponse(message: string): Response {
  return Response.json({ error: { message } }, { status: 401 })
}

function createOpenAIAuthFetch(providerSnapshot: OpenAIAuthSnapshot): typeof fetch {
  const chatGPTFetch = createOpenAIChatGPTFetch({
    tokenManager: getOpenAIChatGPTTokenManager(),
    fetch: permanentErrorFetch,
    userAgent: 'x-code-cli',
  })
  return async (input, init) => {
    const current = await refreshOpenAIAuthSnapshot()
    if (current.revision !== providerSnapshot.revision) {
      return unavailableOpenAIResponse(
        'OpenAI authentication changed in another process before this request was sent. Retry the request with the active authentication method.',
      )
    }
    if (providerSnapshot.context.mode === 'chatgpt') return chatGPTFetch(input, init)
    if (providerSnapshot.context.mode === 'api-key') {
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      headers.delete(OPENAI_SESSION_ID_HEADER)
      return permanentErrorFetch(input, { ...init, headers })
    }
    return unavailableOpenAIResponse('No active OpenAI credentials remain. Run /login.')
  }
}

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}
  const config = loadUserConfig()

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  const openAIAuth = getOpenAIAuthSnapshot()
  if (openAIAuth.context.mode !== 'none') {
    providers.openai = createOpenAI({
      apiKey: openAIAuth.context.mode === 'api-key' ? openAIAuth.context.apiKey : 'x-code-dynamic-openai-auth',
      // 将官方 OpenAI 认证与 SDK 级的 OPENAI_BASE_URL 隔离。
      // 第三方网关通过 custom:* 显式配置。
      baseURL: 'https://api.openai.com/v1',
      fetch: createOpenAIAuthFetch(openAIAuth),
    })
  }
  if (opts.google) providers.google = createGoogle({ fetch: permanentErrorFetch })
  if (opts.xai) providers.xai = createXai({ fetch: xaiPromptCacheFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: permanentErrorFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetch: permanentErrorFetch,
    })
  }
  if (opts.zhipu) {
    providers.zhipu = createOpenAICompatible({
      name: 'zhipu',
      apiKey: opts.zhipu,
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      fetch: zhipuReasoningFetch,
      includeUsage: true,
    })
  }
  if (opts.moonshotai) {
    // Base URL 来自 /model 选择器，持久化在 config.baseUrls 中。
    // 没有环境变量后门——选择器是唯一事实来源，对用户可见且易于修改
    // （重新运行 /model 即可）。
    const baseURL = config.baseUrls?.moonshotai

    // Coding Plan（kimi.com/code/console）使用 api.kimi.com/coding/v1，这是一个
    // 普通的 OpenAI-compatible 端点。@ai-sdk/moonshotai provider 会注入每请求
    // 转换（如 thinking 配置包装），与 Coding Plan 的直接 API 不兼容——通过
    // Coding Plan 控制台签发的 key 只能在这里认证，对 moonshot.* 端点会 401。
    // 改走 createOpenAICompatible，使请求原样透传。
    if (baseURL?.includes('api.kimi.com/coding')) {
      const codingProvider = createOpenAICompatible({
        name: 'moonshotai',
        apiKey: opts.moonshotai,
        baseURL,
        fetch: permanentErrorFetch,
        // createOpenAICompatible 只有在被要求时才发送 `stream_options.include_usage`；
        // 没有它，Coding Plan 不会流式返回 usage 块，页脚的上下文大小读数
        // 会一直是 0。下方 @ai-sdk/moonshotai 路由已经硬编码了这一点。
        includeUsage: true,
        convertUsage: moonshotConvertUsage,
      })
      providers.moonshotai = customProvider({
        languageModels: {
          'kimi-k3': codingProvider(kimiCodingModelId('kimi-k3')),
          'kimi-k2.7-code': codingProvider(kimiCodingModelId('kimi-k2.7-code')),
          'kimi-k2.7-code-highspeed': codingProvider(kimiCodingModelId('kimi-k2.7-code-highspeed')),
          'kimi-k2.6': codingProvider(kimiCodingModelId('kimi-k2.6')),
        },
        fallbackProvider: codingProvider,
      })
    } else {
      providers.moonshotai = createMoonshotAI({
        fetch: permanentErrorFetch,
        ...(baseURL ? { baseURL } : {}),
      })
    }
  }

  // 自定义 OpenAI-compatible provider
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
      fetch: permanentErrorFetch,
      // 与上方 Coding Plan 路由相同的 includeUsage 理由。
      includeUsage: true,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * Coding Plan（OpenAI-compatible）路由的 usage 转换器。镜像 SDK 的默认转换，
 * 但额外读取 Moonshot 专有的顶层 `cached_tokens`——默认只读取 OpenAI 的
 * `prompt_tokens_details.cached_tokens`，否则缓存读取 token 会始终报告为 0
 * （usage schema 是 looseObject，因此顶层字段能通过校验并在这里被读取）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moonshotConvertUsage = (usage: any) => {
  if (usage == null) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      raw: undefined,
    }
  }
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheReadTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens,
    },
    raw: usage,
  }
}

/**
 * Zhipu 推理强度的旁路通道。Zhipu 走 @ai-sdk/openai-compatible，
 * 它不会自动翻译顶层的 `reasoning` 参数。我们通过 fetch 垫片注入
 * `reasoning_effort`。
 */
let _zhipuReasoningEffort: string | undefined
const ZHIPU_REASONING_HEADER = 'x-x-code-zhipu-reasoning-effort'
const XAI_REASONING_HEADER = 'x-x-code-xai-reasoning-effort'

export function setZhipuReasoningEffort(effort: string | undefined): void {
  _zhipuReasoningEffort = effort
}

export function withZhipuReasoningHeader(
  headers: Record<string, string | undefined> | undefined,
  effort: string | undefined,
): Record<string, string> {
  return withInternalReasoningHeader(headers, ZHIPU_REASONING_HEADER, effort)
}

export function withXaiReasoningHeader(
  headers: Record<string, string | undefined> | undefined,
  effort: string | undefined,
): Record<string, string> {
  return withInternalReasoningHeader(headers, XAI_REASONING_HEADER, effort)
}

function withInternalReasoningHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
  effort: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) result[key] = value
  }
  result[name] = effort ?? ''
  return result
}

/** 把 x-code 的每会话亲和提示挪到 xAI 所选传输要求的线上位置。
 *  AI SDK 目前未暴露 Responses 的 `prompt_cache_key` 选项，因此常规的
 *  provider-options 路径做不到这一点。 */
const xaiPromptCacheFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const promptCacheKey = headers.get(XAI_PROMPT_CACHE_KEY_HEADER)
  const reasoningEffort = headers.get(XAI_REASONING_HEADER) || undefined
  headers.delete(XAI_PROMPT_CACHE_KEY_HEADER)
  headers.delete(XAI_REASONING_HEADER)
  const sanitizedInit = { ...init, headers }
  if (!promptCacheKey && !reasoningEffort) return permanentErrorFetch(input, sanitizedInit)

  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
  if (url.pathname.endsWith('/chat/completions')) {
    if (promptCacheKey) headers.set('x-grok-conv-id', promptCacheKey)
  } else if (!url.pathname.endsWith('/responses')) {
    return permanentErrorFetch(input, sanitizedInit)
  }

  const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (typeof rawBody !== 'string') return permanentErrorFetch(input, sanitizedInit)
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return permanentErrorFetch(input, sanitizedInit)
    }
    const body = parsed as Record<string, unknown>
    if (url.pathname.endsWith('/chat/completions')) {
      if (reasoningEffort) body.reasoning_effort = reasoningEffort
    } else {
      if (promptCacheKey && !body.prompt_cache_key) body.prompt_cache_key = promptCacheKey
      if (reasoningEffort) {
        const current =
          body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
            ? (body.reasoning as Record<string, unknown>)
            : {}
        body.reasoning = { ...current, effort: reasoningEffort }
      }
    }
    return permanentErrorFetch(input, { ...sanitizedInit, body: JSON.stringify(body) })
  } catch {
    return permanentErrorFetch(input, sanitizedInit)
  }
}

/** 把 `reasoning_effort` 注入 Zhipu 请求。Zhipu 走 @ai-sdk/openai-compatible，
 *  它不会自动翻译 SDK 顶层的 `reasoning` 参数，因此由 fetch 垫片把它加进
 *  HTTP 请求体。 */
const zhipuReasoningFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  const hasRequestEffort = headers.has(ZHIPU_REASONING_HEADER)
  const requestEffort = headers.get(ZHIPU_REASONING_HEADER) ?? undefined
  headers.delete(ZHIPU_REASONING_HEADER)
  const sanitizedInit = init ? { ...init, headers } : init
  if (!init?.body || typeof init.body !== 'string') return permanentErrorFetch(input, sanitizedInit)

  const effort = hasRequestEffort ? requestEffort || undefined : _zhipuReasoningEffort
  if (effort) {
    try {
      const body = JSON.parse(init.body) as { model?: string; reasoning_effort?: string }
      if (typeof body.model === 'string' && !body.reasoning_effort) {
        body.reasoning_effort = effort
        return permanentErrorFetch(input, { ...sanitizedInit, body: JSON.stringify(body) })
      }
    } catch {
      // 透传
    }
  }

  return permanentErrorFetch(input, sanitizedInit)
}

/**
 * 响应体关键字 → 不可重试状态码的映射。SDK 的 `APICallError` 会把
 * 408 / 409 / 429 / 5xx 标记为 `isRetryable: true`；该集合之外的 4xx 都
 * 视为不可重试。下面每一项都捕获一种“重试永远无法成功”的失败模式，但
 * provider 却用可重试的状态码返回它（最常见的是 Moonshot 用 429 表示
 * 计费问题）。选择一个语义诚实的目标状态码，这样下游的 `classifyApiError`
 * 也能仅凭状态码给出正确的恢复提示。
 *
 * 顺序很重要：第一个匹配到模式的分组胜出。把计费 / 上下文长度放在
 * 内容策略 / 认证之前——它们最具体。
 */
type PermanentErrorMatcher = string | RegExp

const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    // 402 Payment Required — 账户余额不足 / 配额耗尽。
    // 真实案例：Moonshot 返回 HTTP 429，响应体为
    // `{"error":{"message":"... is suspended due to insufficient balance,
    //   please recharge ...","type":"exceeded_current_quota_error"}}`。
    // DeepSeek 返回 "Insufficient Balance" 并带 HTTP 400（本身已不可重试；
    // 改写成 402 只是归一化状态码，让分类器给出同样的友好提示）。
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'insufficient quota',
      'exceeded_current_quota',
      'exceeded your current quota',
      'suspended due to insufficient',
      'please recharge',
    ],
  },
  {
    // 413 Payload Too Large — prompt 超出模型的上下文窗口。
    // 同一个 prompt 会一直溢出——只有 /compact、/clear 或更换模型才能解决。
    status: 413,
    statusText: 'Payload Too Large',
    patterns: [
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'prompt is too long',
      'prompt_too_long',
      'context window',
    ],
  },
  {
    // 422 Unprocessable Entity — provider 的安全过滤器拦截了请求或响应。
    // 重试同样的内容会再次触发同样的拦截；用户必须改写或更换模型。
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: [
      'content_policy_violation',
      'content_filter_triggered',
      'content_filter',
      'content_policy',
      'input_blocked',
      'harmful_content',
      'unsafe content',
      'safety_violation',
    ],
  },
  {
    // 401 Unauthorized — 因上游代理 / 网关配置错误而偶尔以 5xx 或 429
    // 泄漏出来的认证相关失败。用同一把（坏掉的）key 重试会得到同样的失败。
    status: 401,
    statusText: 'Unauthorized',
    patterns: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'api key not found',
      'api_key_invalid',
      'expired api key',
    ],
  },
  {
    // 404 Not Found — 模型 id 错误、已弃用或未对该账户启用。有些 provider
    // 在无法识别模型别名时返回 5xx 而非 404；这里把它归一化。正则捕获
    // OpenAI 的 "The model `gpt-x` does not exist or you do not have
    // access..."，其中模型名位于两个 token 之间。
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

/**
 * 拦截描述永久性失败却使用可重试 HTTP 状态码的上游错误响应（4xx / 5xx），
 * 在 AI SDK 解析它们之前把状态码改写成不可重试的。SDK 的 `APICallError`
 * 构造函数根据状态码计算 `isRetryable`——{408, 409, 429, 5xx} 之外都算
 * false——于是 SDK 的 `_retryWithExponentialBackoff` 在第一次尝试就放弃，
 * 而不是在一个重试无法解决的问题上白白消耗约 30 秒并套上一层 `RetryError`。
 *
 * 只做响应体检测——没有匹配关键字的错误响应原样透传，所以真实的限流 /
 * 网络抖动 / 5xx 打嗝仍能受益于 SDK 的正常重试。成功响应（`< 400`）从不
 * 被读取，因此 SSE 流不受影响。
 */
const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  // 流式 / 成功响应是禁区：读取它们的响应体会消耗掉 SDK 即将解析的 SSE 流。
  if (response.status < 400) return response

  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return response

  const lower = text.toLowerCase()
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue
    // provider 已经用了正确的状态码时，无需改写。
    if (response.status === category.status) return response
    // 响应体原样保留——SDK 的错误解析器仍会从中提取 provider 的 message
    // 字段，classifyApiError 随后读到它并路由到正确的友好提示。
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,
    })
  }
  return response
}
