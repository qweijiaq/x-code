import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pluginManifestJsonSchema, validatePlugin } from '../src/index.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
let root = ''

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(repoRoot, '.plugin-validate-test-'))
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(dir, '.x-code-plugin'), { recursive: true })
  await fs.writeFile(path.join(dir, '.x-code-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8')
}

describe('validatePlugin', () => {
  it('accepts a valid manifest with existing contribution paths', async () => {
    const dir = path.join(root, 'valid')
    await writeManifest(dir, {
      name: 'valid-plugin',
      version: '1.2.3',
      skills: 'skills',
      agents: 'agents',
    })
    await fs.mkdir(path.join(dir, 'skills', 'demo'), { recursive: true })
    await fs.writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), '# Demo\n', 'utf8')
    await fs.mkdir(path.join(dir, 'agents'), { recursive: true })

    const result = await validatePlugin(dir)
    expect(result.errors).toEqual([])
    expect(result.manifest.name).toBe('valid-plugin')
    expect(result.format).toBe('native')
  })

  it('reports missing contribution paths and duplicate config keys', async () => {
    const dir = path.join(root, 'invalid')
    await writeManifest(dir, {
      name: 'invalid-plugin',
      version: '1.0.0',
      skills: 'missing-skills',
      userConfig: [
        { key: 'token', type: 'string' },
        { key: 'token', type: 'string' },
      ],
      futureField: true,
    })

    const result = await validatePlugin(dir)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('skills path does not exist'),
        expect.stringContaining('duplicate key: token'),
      ]),
    )
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('futureField')]))
  })

  it('exposes the same manifest contract as JSON Schema', () => {
    const schema = pluginManifestJsonSchema as {
      required?: string[]
      properties?: Record<string, unknown>
      definitions?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>
    }
    const manifest = schema.definitions?.XCodePluginManifest ?? schema
    expect(manifest.required).toContain('name')
    expect(manifest.properties).toHaveProperty('skills')
    expect(manifest.properties).toHaveProperty('mcpServers')
  })
})
