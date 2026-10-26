// 测试 provider/model 能力查询 —— 特别是每个模型的
// vision 标志，它决定了浏览器智能体的视觉模式。
import { describe, expect, it } from 'vitest'

import {
  capabilitiesOf,
  isModelAcceptedImage,
  isModelAcceptedImageMime,
  modelSupportsVision,
} from '../src/providers/capabilities.js'

describe('modelSupportsVision', () => {
  it('returns the catalog vision flag for listed vision models', () => {
    expect(modelSupportsVision('anthropic:claude-haiku-4-5')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k3')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k2.6')).toBe(true)
    expect(modelSupportsVision('deepseek:deepseek-flash')).toBe(true)
    expect(modelSupportsVision('deepseek:deepseek-v4-flash')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.8-max')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.8-flash')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.7-plus')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.7-flash')).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3-vl-flash')).toBe(true)
    expect(modelSupportsVision('google:gemini-3.8-flash')).toBe(true)
    expect(modelSupportsVision('google:gemini-3.7-flash')).toBe(true)
    expect(modelSupportsVision('xai:grok-4.6')).toBe(true)
    expect(modelSupportsVision('zhipu:glm-5.3-flash')).toBe(true)
    expect(modelSupportsVision('moonshotai:kimi-k2.7-code-highspeed')).toBe(true)
    expect(modelSupportsVision('zhipu:glm-4.6v')).toBe(true)
  })

  it('returns false for listed text-only models even on image-capable providers', () => {
    // alibaba / zhipu 提供方在 API 层面接受图片部分，但这些
    // 特定模型是纯文本的 —— 每个模型的标志必须胜出。
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('zhipu:glm-5.2')).toBe(false)
    expect(modelSupportsVision('deepseek:deepseek-v4-pro')).toBe(false)
  })

  it('expands aliases before lookup', () => {
    expect(modelSupportsVision('opus')).toBe(true) // → anthropic:claude-opus-5
    expect(modelSupportsVision('deepseek')).toBe(true) // → deepseek:deepseek-flash
  })

  it('falls back to provider-level capability for unlisted ids', () => {
    // 不在 catalog 中 → 退回到提供方的图片能力。
    expect(modelSupportsVision('anthropic:claude-some-future-model')).toBe(true)
    expect(modelSupportsVision('deepseek:some-future-model')).toBe(true)
    expect(modelSupportsVision('unknownprovider:whatever')).toBe(false)
  })

  it('provider-level capabilitiesOf stays coarse (provider, not model)', () => {
    // capabilitiesOf 有意保持 provider 级别；两个 Qwen 模型在那里都报告
    // image:true，只有 modelSupportsVision 能区分它们。
    expect(capabilitiesOf('alibaba:qwen3.7-max').image).toBe(true)
    expect(capabilitiesOf('alibaba:qwen3-vl-flash').image).toBe(true)
    expect(modelSupportsVision('alibaba:qwen3.7-max')).toBe(false)
    expect(modelSupportsVision('alibaba:qwen3-vl-flash')).toBe(true)
  })
})

describe('provider image MIME policy', () => {
  it('applies provider MIME and animation policies', () => {
    expect(isModelAcceptedImageMime('image/png', 'xai:grok-4.3')).toBe(true)
    expect(isModelAcceptedImageMime('image/jpeg', 'xai:grok-4.3')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'xai:grok-4.3')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'xai:grok-4.3')).toBe(false)
    expect(isModelAcceptedImageMime('image/gif', 'moonshotai:kimi-k3')).toBe(true)
    expect(isModelAcceptedImageMime('image/webp', 'moonshotai:kimi-k3')).toBe(true)
    expect(isModelAcceptedImageMime('image/gif', 'alibaba:qwen3-vl-flash')).toBe(false)
    expect(isModelAcceptedImageMime('image/webp', 'alibaba:qwen3-vl-flash')).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-5.6-sol' })).toBe(true)
    expect(isModelAcceptedImage('image/gif', { modelId: 'openai:gpt-5.6-sol', animated: true })).toBe(false)
  })
})

describe('toolImageTransport capability', () => {
  it('uses native tool-result media where the provider SDK preserves it', () => {
    for (const id of ['anthropic:claude-sonnet-5', 'openai:gpt-5.6-sol', 'google:gemini-2.5-flash']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('tool-result')
    }
  })

  it('reattaches media in a following user message for Chat Completions providers', () => {
    for (const id of [
      'deepseek:deepseek-flash',
      'moonshotai:kimi-k2.6',
      'alibaba:qwen3-vl-flash',
      'zhipu:glm-4.6v',
      'xai:grok-4.3',
    ]) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('user-message')
    }
  })

  it('marks text-only and unknown providers unsupported', () => {
    for (const id of ['custom:whatever', 'unknownprovider:whatever']) {
      expect(capabilitiesOf(id).toolImageTransport, id).toBe('unsupported')
    }
  })
})
