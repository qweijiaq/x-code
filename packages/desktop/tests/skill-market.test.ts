import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assertGitHubSkillUrl,
  clearSkillMarketCache,
  extractZipBuffer,
  installSkillHubSkill,
  parseSkillHubId,
  parseSkillHubSearch,
  parseSkillsMpSearch,
  searchSkillMarket,
} from '../src/runtime/skill-market.js'

// Minimal stored (uncompressed) ZIP writer for extraction tests.
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
  mode?: number
}

function buildZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(entry.data.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    local.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.length + name.length + entry.data.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuffer, end])
}

let root = ''
let previousHome: string | undefined

beforeEach(() => {
  clearSkillMarketCache()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-skill-market-'))
  previousHome = process.env.X_CODE_HOME
  process.env.X_CODE_HOME = path.join(root, 'home')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  delete process.env.SKILLSMP_API_KEY
  fs.rmSync(root, { recursive: true, force: true })
})

describe('SkillHub catalog', () => {
  it('parses install ids and search results', () => {
    expect(parseSkillHubId('@clawhub_user/pdf-extract')).toEqual({
      namespace: 'clawhub_user',
      slug: 'pdf-extract',
    })
    expect(parseSkillHubId('pdf-extract')).toEqual({ slug: 'pdf-extract' })
    expect(() => parseSkillHubId('../escape')).toThrow('无效')

    const entries = parseSkillHubSearch(
      {
        results: [
          {
            slug: 'pdf-image-text-extractor',
            displayName: 'PDF提取',
            description: 'English description',
            description_zh: '中文说明',
            version: '1.0.13',
            owner_name: 'user_5f9c21aa',
            stars: 190,
            downloads: 279720,
            category: 'office-efficiency',
            homepage: 'https://api.skillhub.cn/user_5f9c21aa/pdf-image-text-extractor',
            labels: { requires_api_key: 'true' },
            namespace: {
              handle: 'user_5f9c21aa',
              publicSlug: 'pdf-image-text-extractor',
            },
          },
        ],
      },
      new Set(['pdf提取']),
    )
    expect(entries).toEqual([
      {
        id: '@user_5f9c21aa/pdf-image-text-extractor',
        provider: 'skillhub',
        name: 'PDF提取',
        description: 'English description',
        descriptionZh: '中文说明',
        author: 'user_5f9c21aa',
        version: '1.0.13',
        stars: 190,
        downloads: 279720,
        category: 'office-efficiency',
        homepage: 'https://skillhub.cn/skills/@user_5f9c21aa/pdf-image-text-extractor',
        requiresKey: true,
        installed: true,
      },
    ])
    expect(parseSkillHubSearch({ results: [{ slug: 'plain' }] }, new Set())[0]?.homepage).toBe(
      'https://skillhub.cn/skills/plain',
    )
  })

  it('searches with q/limit and reuses the in-memory cache', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(
        JSON.stringify({
          results: [{ slug: 'pdf', displayName: 'pdf', description: 'PDF tools', version: '1.0.0' }],
          total: 1,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const first = await searchSkillMarket('skillhub', 'pdf', 20, new Set(), { fetchImpl })
    const second = await searchSkillMarket('skillhub', 'pdf', 20, new Set(), { fetchImpl })
    expect(first.entries[0]?.name).toBe('pdf')
    expect(second.entries).toEqual(first.entries)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('q=pdf')
    expect(urls[0]).toContain('limit=20')
  })

  it('rejects an empty query', async () => {
    await expect(searchSkillMarket('skillhub', '   ', 20, new Set())).rejects.toThrow('搜索关键词')
  })
})

describe('SkillsMP catalog', () => {
  it('parses tool output into entries', () => {
    const entries = parseSkillsMpSearch(
      {
        skills: [
          {
            id: 'affaan-m-ecc-agents-skills-e2e-testing-skill-md',
            name: 'e2e-testing',
            author: 'affaan-m',
            description: 'Playwright patterns',
            githubUrl: 'https://github.com/affaan-m/ECC/tree/main/.agents/skills/e2e-testing',
            skillUrl: 'https://skillsmp.com/creators/affaan-m/ecc/agents-skills-e2e-testing',
            stars: 279616,
          },
        ],
      },
      new Set(['e2e-testing']),
    )
    expect(entries[0]).toMatchObject({
      id: 'affaan-m-ecc-agents-skills-e2e-testing-skill-md',
      provider: 'skillsmp',
      name: 'e2e-testing',
      author: 'affaan-m',
      stars: 279616,
      sourceUrl: 'https://github.com/affaan-m/ECC/tree/main/.agents/skills/e2e-testing',
      installed: true,
    })
  })

  it('initializes the MCP session and calls search_skills', async () => {
    const calls: Array<{ body: Record<string, unknown>; auth?: string }> = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({
        body,
        ...(init?.headers ? { auth: (init.headers as Record<string, string>).Authorization } : {}),
      })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  skills: [
                    {
                      id: 'demo',
                      name: 'demo-skill',
                      description: 'Demo',
                      githubUrl: 'https://github.com/acme/skills/tree/main/demo',
                    },
                  ],
                }),
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    process.env.SKILLSMP_API_KEY = 'test-key'
    const view = await searchSkillMarket('skillsmp', 'demo', 5, new Set(), { fetchImpl })
    expect(view.entries[0]?.name).toBe('demo-skill')
    expect(calls.map((call) => call.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect((calls[2]!.body.params as { name: string }).name).toBe('search_skills')
    expect(calls.every((call) => call.auth === 'Bearer test-key')).toBe(true)
  })

  it('reads SSE responses and surfaces tool errors', async () => {
    let call = 0
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      call += 1
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"skills":[]}' }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch
    await expect(searchSkillMarket('skillsmp', 'empty', 5, new Set(), { fetchImpl })).resolves.toMatchObject({
      entries: [],
    })
    expect(call).toBe(3)
    expect(() => parseSkillsMpSearch({ skills: 'bad' }, new Set())).not.toThrow()
  })
})

describe('SkillHub install', () => {
  it('extracts a zip and copies the skill into the user directory', async () => {
    const zip = buildZip([
      {
        name: 'SKILL.md',
        data: Buffer.from('---\nname: demo-skill\ndescription: Demo skill\n---\n\nBody\n'),
      },
      { name: 'scripts/run.py', data: Buffer.from('print("hi")\n') },
    ])
    const requested: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response(zip, { headers: { 'content-type': 'application/zip' } })
    }) as typeof fetch

    const copied = await installSkillHubSkill('@acme/demo-skill', '1.2.3', { fetchImpl })
    expect(copied.sourceName).toBe('demo-skill')
    expect(requested[0]).toContain('slug=demo-skill')
    expect(requested[0]).toContain('namespace=acme')
    expect(requested[0]).toContain('version=1.2.3')
    expect(fs.existsSync(path.join(copied.dir, 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(copied.dir, 'scripts', 'run.py'), 'utf-8')).toBe('print("hi")\n')
    expect(copied.dir.startsWith(path.join(root, 'home', 'skills'))).toBe(true)
  })

  it('extracts nested archives and rejects traversal and symlinks', async () => {
    const nested = buildZip([{ name: 'demo/SKILL.md', data: Buffer.from('---\nname: nested\n---\n') }])
    const extracted = path.join(root, 'nested')
    await extractZipBuffer(nested, extracted)
    expect(fs.existsSync(path.join(extracted, 'demo', 'SKILL.md'))).toBe(true)

    const traversal = buildZip([{ name: '../escape.txt', data: Buffer.from('nope') }])
    await expect(extractZipBuffer(traversal, path.join(root, 'traversal'))).rejects.toThrow(
      /不安全|invalid relative path/,
    )
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false)

    const link = buildZip([{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }])
    await expect(extractZipBuffer(link, path.join(root, 'link'))).rejects.toThrow('符号链接')
  })

  it('validates GitHub install URLs for SkillsMP', () => {
    expect(assertGitHubSkillUrl('https://github.com/acme/skills/tree/main/demo')).toBe(
      'https://github.com/acme/skills/tree/main/demo',
    )
    expect(() => assertGitHubSkillUrl('https://evil.example/acme/skills')).toThrow('github.com')
    expect(() => assertGitHubSkillUrl('http://github.com/acme/skills')).toThrow('github.com')
    expect(() => assertGitHubSkillUrl('https://github.com/only-owner')).toThrow('无效')
  })
})
