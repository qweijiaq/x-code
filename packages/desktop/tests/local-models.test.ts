import { afterEach, describe, expect, it, vi } from 'vitest'

import { discoverLocalModels, isLocalModelId, localModelInfos, withLocalModels } from '../src/runtime/local-models.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local model discovery', () => {
  it('probes Ollama and LM Studio and builds provider-qualified ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3.2:latest' }] })
        if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'qwen2.5-coder-7b' }] })
        return new Response('not found', { status: 404 })
      }),
    )

    const models = await discoverLocalModels(true)
    expect(models.map((model) => model.id)).toEqual(['ollama:llama3.2:latest', 'lmstudio:qwen2.5-coder-7b'])
    expect(isLocalModelId('ollama:llama3.2:latest')).toBe(true)
    expect(isLocalModelId('anthropic:claude-sonnet-5')).toBe(false)
    expect(localModelInfos()).toHaveLength(2)
  })

  it('treats unreachable servers as no models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused')
      }),
    )
    await expect(discoverLocalModels(true)).resolves.toEqual([])
  })

  it('delegates non-local ids to the wrapped registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3.2' }] })
        return new Response('not found', { status: 404 })
      }),
    )
    await discoverLocalModels(true)
    const fallback = { marker: 'remote' }
    const base = {
      languageModel: vi.fn((id: string) => (id === 'ollama:llama3.2' ? { marker: 'should-not-use-base' } : fallback)),
    }
    const wrapped = withLocalModels(base as never) as unknown as { languageModel(id: string): unknown }
    expect(wrapped.languageModel('ollama:llama3.2')).not.toBe(base.languageModel('ollama:llama3.2'))
    expect(wrapped.languageModel('anthropic:claude-sonnet-5')).toBe(fallback)
  })
})
