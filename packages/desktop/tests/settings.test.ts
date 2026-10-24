import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listInstalledPlugins } from '@x-code-cli/core'

import { loadDesktopSettings, saveDesktopSettings } from '../src/runtime/desktop-settings.js'
import {
  installPluginWithConsent,
  normalizeInstallCommand,
  previewPluginInstall,
} from '../src/runtime/plugin-install.js'
import {
  clearProviderKey,
  loadSecrets,
  providerSecretStatus,
  saveProviderKey,
  secretStorageKind,
  setSecretCipher,
} from '../src/runtime/secrets.js'
import type { SecretCipher } from '../src/runtime/secrets.js'
import { parseSkillInstallCommand, parseSkillSource } from '../src/runtime/skill-install-command.js'

let home = ''

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-desktop-settings-'))
  process.env.X_CODE_HOME = home
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_COMPATIBLE_API_KEY
  delete process.env.OPENAI_COMPATIBLE_BASE_URL
})

afterAll(() => {
  delete process.env.X_CODE_HOME
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_COMPATIBLE_API_KEY
  delete process.env.OPENAI_COMPATIBLE_BASE_URL
  fs.rmSync(home, { recursive: true, force: true })
})

function mockCipher(): SecretCipher {
  return {
    available: async () => true,
    encrypt: async (text) => Buffer.from(`enc:${text}`, 'utf8').toString('base64'),
    decrypt: async (data) => {
      const decoded = Buffer.from(data, 'base64').toString('utf8')
      if (!decoded.startsWith('enc:')) throw new Error('bad ciphertext')
      return decoded.slice(4)
    },
  }
}

describe('desktop API-key storage', () => {
  const secretsFile = (): string => path.join(home, 'desktop-secrets.json')

  beforeEach(() => {
    setSecretCipher(null)
    fs.rmSync(secretsFile(), { force: true })
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_COMPATIBLE_API_KEY
    delete process.env.OPENAI_COMPATIBLE_BASE_URL
  })

  it('persists keys with 0600, injects them, and only exposes a hint', async () => {
    await saveProviderKey('anthropic', 'sk-test-abcd')

    const parsed = JSON.parse(fs.readFileSync(secretsFile(), 'utf-8')) as {
      version: number
      providers: Record<string, { plain?: string }>
    }
    expect(parsed.version).toBe(2)
    expect(parsed.providers.anthropic?.plain).toBe('sk-test-abcd')
    expect(fs.statSync(secretsFile()).mode & 0o777).toBe(0o600)
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-abcd')
    expect(providerSecretStatus('anthropic')).toMatchObject({ source: 'stored', hint: '••••abcd' })
    expect(secretStorageKind()).toBe('plain')
  })

  it('clears a stored key and restores the environment', async () => {
    await saveProviderKey('anthropic', 'sk-clear-9999')
    await clearProviderKey('anthropic')
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(providerSecretStatus('anthropic').source).toBe('none')
  })

  it('detects keys supplied through the environment', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key-1234'
    expect(providerSecretStatus('anthropic').source).toBe('env')
    delete process.env.ANTHROPIC_API_KEY
  })

  it('stores the custom provider key and base URL together', async () => {
    await saveProviderKey('custom', 'sk-custom-5678', 'https://example.com/v1')
    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe('sk-custom-5678')
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBe('https://example.com/v1')
    expect(providerSecretStatus('custom')).toMatchObject({
      source: 'stored',
      hint: '••••5678',
      baseUrl: 'https://example.com/v1',
    })

    await clearProviderKey('custom')
    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined()
  })

  it('encrypts values when the cipher is available', async () => {
    setSecretCipher(mockCipher())
    await saveProviderKey('anthropic', 'sk-secret-wxyz')

    const raw = fs.readFileSync(secretsFile(), 'utf8')
    expect(raw).not.toContain('sk-secret-wxyz')
    const parsed = JSON.parse(raw) as { providers: Record<string, { enc?: string; plain?: string }> }
    expect(parsed.providers.anthropic?.enc).toBeTruthy()
    expect(parsed.providers.anthropic?.plain).toBeUndefined()
    expect(secretStorageKind()).toBe('encrypted')
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-secret-wxyz')
    expect(providerSecretStatus('anthropic')).toMatchObject({ source: 'stored', hint: '••••wxyz' })

    // Re-reading from disk decrypts through the cipher.
    await loadSecrets()
    expect(providerSecretStatus('anthropic')).toMatchObject({ source: 'stored', hint: '••••wxyz' })
  })

  it('migrates legacy plaintext entries to enc on load', async () => {
    fs.writeFileSync(secretsFile(), JSON.stringify({ providers: { anthropic: 'sk-legacy-1234' }, baseUrls: {} }))
    setSecretCipher(mockCipher())

    await loadSecrets()

    const parsed = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as {
      providers: Record<string, { enc?: string }>
    }
    expect(parsed.providers.anthropic?.enc).toBeTruthy()
    expect(providerSecretStatus('anthropic')).toMatchObject({ source: 'stored', hint: '••••1234' })
  })
})

describe('desktop tool settings', () => {
  it('round-trips tool enablement and always-allow settings', () => {
    saveDesktopSettings({
      disabledTools: ['shell', 'webSearch'],
      autoAllowedTools: ['writeFile'],
      alwaysAllowAll: true,
    })
    expect(loadDesktopSettings()).toMatchObject({
      disabledTools: ['shell', 'webSearch'],
      autoAllowedTools: ['writeFile'],
      alwaysAllowAll: true,
    })
  })
})

describe('plugin install command parsing', () => {
  it('extracts the target from xc/claude install commands', () => {
    expect(normalizeInstallCommand('xc plugin install name@marketplace')).toBe('name@marketplace')
    expect(normalizeInstallCommand('claude plugin install github:owner/repo#main')).toBe('github:owner/repo#main')
    expect(normalizeInstallCommand('github:owner/repo')).toBe('github:owner/repo')
  })

  it('rejects unsupported extra arguments instead of executing a shell', () => {
    expect(() => normalizeInstallCommand('xc plugin install foo --dangerous')).toThrow()
  })
})

describe('plugin consent preview', () => {
  it('captures a preview without installing the plugin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-plugin-preview-'))
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'preview-test', version: '1.0.0', description: 'fixture' }),
    )

    const preview = await previewPluginInstall({ kind: 'path', path: root })
    expect(preview).toMatchObject({
      pluginId: 'preview-test@local',
      version: '1.0.0',
      marketplace: 'local',
      verified: false,
    })
    expect((await listInstalledPlugins()).some((plugin) => plugin.id === 'preview-test@local')).toBe(false)

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('installs only after explicit confirmation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-plugin-install-'))
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'confirm-test', version: '1.0.0' }),
    )

    const info = await installPluginWithConsent({ kind: 'path', path: root })
    expect(info.pluginId).toBe('confirm-test@local')
    expect((await listInstalledPlugins()).some((plugin) => plugin.id === 'confirm-test@local')).toBe(true)

    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('skill install command parsing', () => {
  it('parses npx skills add forms with --skill and bare sources', () => {
    expect(parseSkillInstallCommand('npx skills add owner/repo --skill demo')).toEqual({
      source: 'owner/repo',
      skillName: 'demo',
      all: false,
    })
    expect(parseSkillInstallCommand('pnpm dlx add-skill https://github.com/o/r --all')).toEqual({
      source: 'https://github.com/o/r',
      skillName: undefined,
      all: true,
    })
    expect(parseSkillInstallCommand('github:owner/repo#main')).toMatchObject({
      source: 'github:owner/repo#main',
      all: false,
    })
  })

  it('maps GitHub tree and blob URLs to clone/download sources', () => {
    expect(parseSkillSource('https://github.com/o/r/tree/main/skills/x')).toEqual({
      kind: 'git',
      url: 'https://github.com/o/r.git',
      ref: 'main',
      subpath: 'skills/x',
    })
    expect(parseSkillSource('https://github.com/o/r/blob/main/skills/x/SKILL.md')).toEqual({
      kind: 'file',
      url: 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md',
    })
  })

  it('rejects unknown extra arguments', () => {
    expect(() => parseSkillInstallCommand('npx skills add owner/repo unexpected')).toThrow()
  })
})
