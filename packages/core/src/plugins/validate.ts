// @x-code-cli/core — author-facing plugin validation
//
// `parseManifest` answers "can this manifest be loaded?". `validatePlugin`
// adds the checks an author needs before publishing: contribution paths must
// exist, unknown top-level fields are reported, and obvious duplicate config
// keys are rejected. It never installs or mutates the plugin.
import fs from 'node:fs/promises'
import path from 'node:path'

import { discoverManifest, parseManifest } from './manifest.js'
import type { ManifestFormat, PluginManifest } from './types.js'

export interface PluginValidation {
  rootDir: string
  manifestPath: string
  format: ManifestFormat
  manifest: PluginManifest
  errors: string[]
  warnings: string[]
}

const KNOWN_MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'name',
  'version',
  'description',
  'author',
  'keywords',
  'homepage',
  'license',
  'skills',
  'agents',
  'commands',
  'mcpServers',
  'hooks',
  'userConfig',
  'dependencies',
  'engines',
])

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function checkContribution(
  rootDir: string,
  field: string,
  value: string | string[] | undefined,
  errors: string[],
): Promise<void> {
  if (!value) return
  const entries = Array.isArray(value) ? value : [value]
  for (const entry of entries) {
    const absolute = path.resolve(rootDir, entry)
    const relative = path.relative(rootDir, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`${field} must stay inside the plugin root: ${entry}`)
      continue
    }
    if (!(await exists(absolute))) {
      errors.push(`${field} path does not exist: ${entry}`)
    }
  }
}

export async function validatePlugin(rootDir: string): Promise<PluginValidation> {
  const root = path.resolve(rootDir)
  const discovery = await discoverManifest(root)
  if (!discovery) {
    throw new Error(
      `No plugin manifest found in ${root}. Expected .x-code-plugin/plugin.json, .claude-plugin/plugin.json, or plugin.json.`,
    )
  }
  if (discovery.format === 'gemini') {
    throw new Error(
      'Gemini extensions are not supported; use a .x-code-plugin/plugin.json or .claude-plugin/plugin.json manifest.',
    )
  }

  const raw = JSON.parse(await fs.readFile(discovery.manifestPath, 'utf8')) as unknown
  const manifest = await parseManifest(discovery.manifestPath)
  const errors: string[] = []
  const warnings: string[] = []

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const unknown = Object.keys(raw as Record<string, unknown>).filter((key) => !KNOWN_MANIFEST_FIELDS.has(key))
    if (unknown.length > 0) warnings.push(`unknown top-level field(s): ${unknown.join(', ')}`)
  }

  const duplicateKeys = new Set<string>()
  for (const item of manifest.userConfig ?? []) {
    if (duplicateKeys.has(item.key)) errors.push(`userConfig contains duplicate key: ${item.key}`)
    duplicateKeys.add(item.key)
  }

  await checkContribution(root, 'skills', manifest.skills, errors)
  await checkContribution(root, 'agents', manifest.agents, errors)
  await checkContribution(root, 'commands', manifest.commands, errors)
  if (typeof manifest.mcpServers === 'string') await checkContribution(root, 'mcpServers', manifest.mcpServers, errors)
  if (typeof manifest.hooks === 'string') await checkContribution(root, 'hooks', manifest.hooks, errors)

  return {
    rootDir: root,
    manifestPath: discovery.manifestPath,
    format: discovery.format,
    manifest,
    errors,
    warnings,
  }
}
