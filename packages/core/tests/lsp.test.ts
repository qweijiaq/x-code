import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TypeScriptService, resolveTsserverPath } from '../src/lsp/typescript-service.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
let projectRoot = ''
let service: TypeScriptService

beforeAll(async () => {
  projectRoot = await fs.mkdtemp(path.join(repoRoot, '.lsp-test-'))
  await fs.writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'lsp-fixture', private: true }),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
    }),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'a.ts'),
    ['export const value = 1', 'export function add(a: number, b: number) {', '  return a + b', '}', ''].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'b.ts'),
    ["import { add } from './a.js'", 'const total = add(1, 2)', 'export { total }', ''].join('\n'),
    'utf8',
  )
  await fs.writeFile(path.join(projectRoot, 'broken.ts'), 'const broken: string = 1\n', 'utf8')
  service = new TypeScriptService(projectRoot, resolveTsserverPath(repoRoot))
}, 30_000)

afterAll(async () => {
  service?.dispose()
  if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true })
})

describe('TypeScriptService', () => {
  it('returns semantic diagnostics', async () => {
    const diagnostics = await service.diagnostics('broken.ts')
    expect(diagnostics.some((item) => item.severity === 'error' && item.message.includes('string'))).toBe(true)
  }, 30_000)

  it('finds definitions across files', async () => {
    const locations = await service.definition('b.ts', 2, 15)
    expect(locations.some((item) => item.file.endsWith('a.ts') && item.line === 2)).toBe(true)
  }, 30_000)

  it('finds references across files', async () => {
    const locations = await service.references('b.ts', 2, 15)
    expect(locations.some((item) => item.file.endsWith('a.ts'))).toBe(true)
    expect(locations.some((item) => item.file.endsWith('b.ts'))).toBe(true)
  }, 30_000)

  it('previews rename locations without writing', async () => {
    const edits = await service.rename('a.ts', 2, 17, 'sum')
    expect(edits.length).toBeGreaterThan(0)
    expect(edits.every((item) => item.newText === 'sum')).toBe(true)
    expect(edits.some((item) => item.file.endsWith('b.ts'))).toBe(true)
    expect(await fs.readFile(path.join(projectRoot, 'a.ts'), 'utf8')).toContain('function add')
  }, 30_000)

  it('sees edits made after a file was first opened', async () => {
    await service.references('b.ts', 2, 15)
    await fs.appendFile(path.join(projectRoot, 'b.ts'), 'export const later = add(3, 4)\n', 'utf8')
    const locations = await service.references('b.ts', 2, 15)
    expect(locations.some((item) => item.file.endsWith('b.ts') && item.line === 4)).toBe(true)
  }, 30_000)
})
