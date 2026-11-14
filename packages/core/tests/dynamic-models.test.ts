import { afterEach, describe, expect, it } from 'vitest'

import { clearDynamicProviderModels, setDynamicProviderModels } from '../src/providers/dynamic-models.js'
import { getProviderModels } from '../src/providers/openai-chatgpt-models.js'

afterEach(() => {
  clearDynamicProviderModels()
})

describe('dynamic provider models', () => {
  it('appends discovered models after the static catalog without duplicates', () => {
    setDynamicProviderModels('opendesign', ['deepseek-v4.1-flash', 'brand-new-model'])

    const models = getProviderModels().opendesign ?? []
    expect(models.some((model) => model.id === 'opendesign:deepseek-v4.1-flash')).toBe(true)
    expect(models.filter((model) => model.id === 'opendesign:deepseek-v4.1-flash')).toHaveLength(1)
    expect(models.at(-1)?.id).toBe('opendesign:brand-new-model')
    expect(models.at(-1)?.label).toBe('brand-new-model')
  })

  it('clears discovery back to the static catalog', () => {
    setDynamicProviderModels('opencode', ['only-dynamic'])
    expect(getProviderModels().opencode?.some((model) => model.id === 'opencode:only-dynamic')).toBe(true)
    clearDynamicProviderModels()
    expect(getProviderModels().opencode?.some((model) => model.id === 'opencode:only-dynamic')).toBe(false)
  })
})
