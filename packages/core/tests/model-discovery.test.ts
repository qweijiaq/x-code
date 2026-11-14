import { afterEach, describe, expect, it } from 'vitest'

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { listOpenAICompatibleModels, normalizeModelsUrl } from '../src/providers/model-discovery.js'

const servers: http.Server[] = []

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe('normalizeModelsUrl', () => {
  it('accepts host, /v1 and full chat endpoints', () => {
    expect(normalizeModelsUrl('https://api.example.com')).toBe('https://api.example.com/models')
    expect(normalizeModelsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models')
    expect(normalizeModelsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models')
    expect(normalizeModelsUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1/models')
  })

  it('rejects non-http protocols', () => {
    expect(() => normalizeModelsUrl('file:///tmp/models')).toThrow('http')
  })
})

describe('listOpenAICompatibleModels', () => {
  it('reads OpenAI data entries, sends the bearer key and sorts/dedupes ids', async () => {
    const base = await serve(async (request, response) => {
      const body = await readBody(request)
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          data: [{ id: 'beta' }, { id: 'alpha' }, { id: 'alpha' }],
          authorization: request.headers.authorization,
          body,
        }),
      )
    })
    const models = await listOpenAICompatibleModels({ baseUrl: `${base}/v1`, apiKey: 'sk-test' })
    expect(models).toEqual(['alpha', 'beta'])
  })

  it('accepts a models array and string entries', async () => {
    const base = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ models: ['z', { id: 'a' }] }))
    })
    expect(await listOpenAICompatibleModels({ baseUrl: `${base}/v1` })).toEqual(['a', 'z'])
  })

  it('surfaces HTTP errors without leaking the key', async () => {
    const base = await serve((_request, response) => {
      response.statusCode = 401
      response.end('unauthorized')
    })
    await expect(listOpenAICompatibleModels({ baseUrl: `${base}/v1`, apiKey: 'sk-secret' })).rejects.toThrow('HTTP 401')
  })

  it('rejects an empty model list', async () => {
    const base = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [] }))
    })
    await expect(listOpenAICompatibleModels({ baseUrl: `${base}/v1` })).rejects.toThrow('为空')
  })
})
