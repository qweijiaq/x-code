import { describe, expect, it } from 'vitest'

import { PROVIDERS } from '../src/providers/catalog.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, MODEL_LIMITS } from '../src/providers/model-limits.js'

describe('model limits table', () => {
  it('registers the OpenCode and OpenDesign gateway providers', () => {
    const names = PROVIDERS.map((provider) => provider.name)
    expect(names).toEqual(expect.arrayContaining(['opencode', 'opencode-go', 'opendesign', 'opendesign-go']))
  })

  it('has an explicit context window for every model in the picker catalog', () => {
    const missing = PROVIDERS.flatMap((provider) =>
      provider.models
        .filter((model) => MODEL_LIMITS.get(model.id)?.contextWindow === undefined)
        .map((model) => model.id),
    )
    expect(missing).toEqual([])
  })

  it('has an explicit context window for every provider default model', () => {
    const missing = PROVIDERS.filter((provider) => MODEL_LIMITS.get(provider.defaultModel)?.contextWindow === undefined)
    expect(missing.map((provider) => provider.defaultModel)).toEqual([])
  })

  it('keeps every limit positive and internally consistent', () => {
    for (const [modelId, limits] of MODEL_LIMITS) {
      expect(modelId, `${modelId} must be provider:model`).toMatch(/^[a-z0-9-]+:[^:]+$/)
      expect(limits.contextWindow, `${modelId} context window`).toBeGreaterThan(0)
      if (limits.maxOutputTokens !== undefined) {
        expect(limits.maxOutputTokens, `${modelId} max output`).toBeGreaterThan(0)
        expect(limits.maxOutputTokens, `${modelId} max output must fit the context window`).toBeLessThanOrEqual(
          limits.contextWindow,
        )
      }
    }
  })

  it('never relies on the default output cap when the catalog lists a model', () => {
    // 输出上限本身可以省略（回退到默认值），但 id 必须已在表中登记，
    // 否则同一个模型会同时得到“默认窗口 + 默认输出”，两处都静默漂移。
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        expect(MODEL_LIMITS.has(model.id), `${model.id} must be registered in MODEL_LIMITS`).toBe(true)
        expect(
          MODEL_LIMITS.get(model.id)?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          `${model.id} output cap`,
        ).toBeGreaterThan(0)
      }
    }
  })
})
