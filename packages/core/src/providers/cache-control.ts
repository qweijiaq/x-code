// @x-code-cli/core — 各 provider 的提示词缓存
//
// 提示词缓存是降低单会话成本的最大杠杆。当前所有 provider 都支持它，
// 但激活协议各不相同：
//
//   Anthropic   — 在 SYSTEM 消息、最后一个工具定义（用一个断点缓存整个
//                 tools schema）、以及最后两条非 system 消息上设置
//                 `cacheControl: { type: 'ephemeral' }` —— 共四个断点，
//                 正好是 API 的上限。每个断点处的内容在服务端缓存，TTL 为
//                 5 分钟；后续共享完全相同前缀的请求命中缓存，只支付未缓存
//                 尾部的费用。tools schema 是收益最高的槽位——每轮都是
//                 相同的字节，注册完整工具集后可达数千 token。
//
//   OpenAI      — 自动前缀缓存，用 `promptCacheKey` 把相同的稳定前缀路由到
//                 同一缓存分片。GPT-5.6+ 的 Platform API-key 请求还额外获得
//                 30 分钟隐式缓存，以及在字节稳定 system prompt 之后的一个
//                 显式断点。ChatGPT 订阅请求保留其私有传输所接受的仅 key
//                 形态。`store: false` 独立地禁用响应存储。
//
//   Moonshot    — 自动前缀缓存 + `prompt_cache_key: sessionId` 用于会话
//                 亲和（同一会话的请求命中相同的服务端缓存分片），外加下方
//                 的字节稳定前缀。
//
//   xAI         — 自动前缀缓存。默认的 AI SDK 模型使用 Responses API，
//                 它要求请求体中有 `prompt_cache_key`。SDK 未暴露该选项，
//                 因此用一个内部 header 把 sessionId 传给 registry 的 fetch
//                 适配器，由适配器在发送请求前消费它。
//
//   Alibaba     — 同时支持隐式与显式缓存。显式 `cache_control` 标记在消息
//                 内容上有效，而非工具定义上。我们标记 system prompt 和最后
//                 两条消息；稳定的 tools schema 仍会参与这些消息断点之前的
//                 缓存前缀。
//
//   OpenAI-     — DeepSeek / Zhipu / custom 这些 provider 都提供自动前缀
//   compatible    缓存，无需任何显式标志。唯一前提是跨轮次字节稳定的前缀。
//
//   Google      — Gemini 使用隐式缓存；没有能从 SDK 有意义设置的逐请求
//                 标志。保持为无操作。
import { createHash } from 'node:crypto'

import type { ModelMessage, SystemModelMessage } from 'ai'

import { providerOf } from './capabilities.js'

/** 附加 Anthropic 缓存断点的最大消息数。Anthropic 允许每个请求最多 4 个
 *  `cache_control` 块；我们在 system prompt 上用掉一个、在最后一个工具定义
 *  上用掉一个，剩下两个留给消息尾部。二是 opencode 测试出的最佳点——
 *  第三个消息断点会针对一个即将被淘汰的区域（倒数第二条消息）付出一次
 *  缓存写入代价。 */
const MESSAGE_CACHE_BREAKPOINTS = 2

export const XAI_PROMPT_CACHE_KEY_HEADER = 'x-x-code-prompt-cache-key'
export const OPENAI_SESSION_ID_HEADER = 'x-x-code-openai-session-id'

export interface CacheControlArgs {
  /** 指令（system prompt）字符串。若 provider 需要在其上附加 cache_control，
   *  可能被包装成 system 角色消息。 */
  instructions: string
  /** 要发送的会话消息。 */
  messages: ModelMessage[]
  /** 传给 streamText 的工具注册表。对于 Anthropic，我们给最后一个条目打上
   *  cache_control，使整个 tools schema 进入缓存前缀。buildTools() 在整个
   *  会话返回同一个 Record 引用，因此键序——以及由此产生的缓存前缀——
   *  跨轮次字节稳定。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>
  /** 用于选择缓存策略的 provider:model id。 */
  modelId: string
  /** 稳定的每会话标识符。OpenAI 的 ChatGPT 传输会单独收到它，与跨会话的
   *  提示词缓存路由 key 区分开。 */
  sessionId: string
  /** ChatGPT 订阅使用私有 Responses 传输，它接受稳定 key 但不接受
   *  Platform 专属的显式缓存控制。 */
  openAIAuthMode?: 'chatgpt' | 'api-key' | 'none'
}

export interface CacheControlResult {
  /** 当 provider 需要在稳定 system prompt 上打缓存断点时，指令可能是
   *  打上标记的 system 消息。 */
  instructions?: string | SystemModelMessage
  messages: ModelMessage[]
  /** Anthropic 收到浅克隆的 tools 记录，且最后一个条目带 cache_control。
   *  其他 provider 原样收到输入记录。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>
  /** 透传给 streamText 的顶层 providerOptions。 */
  providerOptions?: Record<string, unknown>
  /** 透传给 streamText 的 HTTP headers，包括内部 fetch 适配器提示。 */
  headers?: Record<string, string>
}

/** 以非破坏性方式把给定的 providerOptions 条目附加到消息上。 */
function tagMessage(msg: ModelMessage, provider: string, entry: Record<string, unknown>): ModelMessage {
  const existing = (msg as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {}
  return {
    ...msg,
    providerOptions: {
      ...existing,
      [provider]: { ...(existing[provider] ?? {}), ...entry },
    },
  } as ModelMessage
}

/** 构建附带 Anthropic cache_control 的 system 角色指令。 */
function anthropicSystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  }
}

/** 构建附带 Alibaba cache_control 的 system 角色指令。 */
function alibabaSystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      alibaba: { cacheControl: { type: 'ephemeral' } },
    },
  }
}

/** GPT-5.6 型号变体共享新的 prompt_cache_options 契约。 */
function supportsOpenAIExplicitPromptCaching(modelId: string): boolean {
  return /^openai:gpt-5\.6(?:$|-)/.test(modelId)
}

const CHATGPT_CACHE_COMPARISON_TTL_MS = 5 * 60 * 1000
const OPENAI_EXPLICIT_CACHE_TTL_MS = 30 * 60 * 1000

/** 相邻 OpenAI 轮次的诊断比较窗口。Platform GPT-5.6 获得显式 30 分钟 TTL。
 *  ChatGPT 的私有传输不暴露 TTL 控制，因此采用保守的五分钟窗口，避免把
 *  较旧的 provider 默认淘汰误判为字节不稳定的回退。 */
export function openAICacheComparisonTtlMs(
  modelId: string,
  authMode: CacheControlArgs['openAIAuthMode'],
): number | undefined {
  if (!supportsOpenAIExplicitPromptCaching(modelId)) return undefined
  return authMode === 'chatgpt' ? CHATGPT_CACHE_COMPARISON_TTL_MS : OPENAI_EXPLICIT_CACHE_TTL_MS
}

/** 让缓存路由跨会话保持稳定，同时不在 provider 可见的 key 中暴露提示词文本
 *  或本地路径。模型或提示词变化自然会生成不同的缓存组。 */
export function openAIStablePromptCacheKey(modelId: string, instructions: string): string {
  const digest = createHash('sha256').update(modelId).update('\0').update(instructions).digest('hex').slice(0, 32)
  return `xc-agent-v1:${digest}`
}

function openAISystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    },
  }
}

/**
 * 返回携带各 provider 缓存提示的请求形态。
 * 输入的 `messages` 数组不会被修改——任何需要额外 providerOptions 的消息
 * 都会返回新的消息对象。
 */
export function applyCacheControl(args: CacheControlArgs): CacheControlResult {
  const provider = providerOf(args.modelId)

  if (provider === 'anthropic') {
    // AI SDK v7 拒绝 `messages` 中的 system 角色条目；把带标记的 system
    // prompt 放在 `instructions` 里，并单独标记消息尾部。
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: anthropicSystemMessage(args.instructions),
      messages: tagged,
      tools: tagLastTool(args.tools),
    }
  }

  if (provider === 'openai') {
    const promptCacheKey = openAIStablePromptCacheKey(args.modelId, args.instructions)
    const explicitCaching = supportsOpenAIExplicitPromptCaching(args.modelId) && args.openAIAuthMode !== 'chatgpt'
    // Platform GPT-5.6 的隐式模式保留自动的最新消息断点，与我们的显式稳定
    // system 断点并存。ChatGPT 订阅则维持已接受的自动仅 key 形态。
    return {
      instructions: explicitCaching ? openAISystemMessage(args.instructions) : args.instructions,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        openai: {
          promptCacheKey,
          ...(explicitCaching ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } } : {}),
          store: false,
        },
      },
      headers: { [OPENAI_SESSION_ID_HEADER]: args.sessionId },
    }
  }

  if (provider === 'moonshotai') {
    // Moonshot 的服务端前缀缓存是自动的，但请求会落到每个 key 的缓存分片上：
    // 把 `prompt_cache_key` 固定为 sessionId 可使对话的每一轮都落在同一分片
    // （Kimi CLI 用的也是这一机制）。两条 Moonshot 路由都会转发它：
    // openai-compatible SDK 会把非标准 providerOptions 键原样展开进请求体，
    // @ai-sdk/moonshotai 继承了该行为。
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        moonshotai: { prompt_cache_key: args.sessionId },
      },
    }
  }

  if (provider === 'xai') {
    // provider registry 会消费这个内部 header，把 key 挪到传输特定的位置，
    // 而不会把 header 泄露到上游。
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      headers: { [XAI_PROMPT_CACHE_KEY_HEADER]: args.sessionId },
    }
  }

  if (provider === 'alibaba') {
    // Alibaba 的显式标记应放在消息内容上。工具定义仍构成稳定前缀的一部分，
    // 但附加在工具上的标记会被 API 契约和当前 provider 适配器同时忽略。
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'alibaba', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: alibabaSystemMessage(args.instructions),
      messages: tagged,
      tools: args.tools,
    }
  }

  // OpenAI-compatible 与 Gemini：无显式标志，仅依赖稳定前缀。
  // 调用方必须确保 buildSystemPrompt 在 LoopState 中被缓存，使每一轮都
  // 重新发送相同的 instructions 字符串。
  return { instructions: args.instructions, messages: args.messages, tools: args.tools }
}

/** 浅克隆 `tools`，并为给定 provider 给最后一个条目附加 cache_control 断点，
 *  使整个 tools schema 进入同一个缓存前缀槽位。没有工具时原样返回输入。 */
function tagLastToolForProvider(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any> | undefined,
  provider: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | undefined {
  if (!tools) return tools
  const names = Object.keys(tools)
  if (names.length === 0) return tools
  const lastName = names[names.length - 1]
  const lastTool = tools[lastName]
  const existing = (lastTool?.providerOptions ?? {}) as Record<string, Record<string, unknown>>
  const tagged = {
    ...lastTool,
    providerOptions: {
      ...existing,
      [provider]: { ...(existing[provider] ?? {}), cacheControl: { type: 'ephemeral' } },
    },
  }
  return { ...tools, [lastName]: tagged }
}

/** 在最后一个工具上附加 Anthropic 的 cache_control。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagLastTool(tools: Record<string, any> | undefined): Record<string, any> | undefined {
  return tagLastToolForProvider(tools, 'anthropic')
}
