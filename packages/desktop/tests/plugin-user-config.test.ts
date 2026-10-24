import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getPluginUserConfig } from '@x-code-cli/core'

import { buildUserConfigValues, installPluginWithConsent, previewPluginInstall } from '../src/runtime/plugin-install.js'

let root = ''
let pluginDir = ''
let previousHome: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-plugin-config-'))
  previousHome = process.env.X_CODE_HOME
  process.env.X_CODE_HOME = path.join(root, 'home')
  pluginDir = path.join(root, 'smoke-plugin')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: 'smoke-plugin',
      version: '1.0.0',
      description: 'Plugin with user configuration',
      userConfig: [
        { key: 'SMOKE_TOKEN', type: 'string', sensitive: true, prompt: 'Token' },
        { key: 'SMOKE_REGION', type: 'string', default: 'cn', required: true, prompt: 'Region' },
        { key: 'SMOKE_RETRIES', type: 'number', default: 3 },
        { key: 'SMOKE_ENABLED', type: 'boolean', default: true },
      ],
    }),
  )
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  fs.rmSync(root, { recursive: true, force: true })
})

describe('plugin userConfig', () => {
  it('includes declared fields in the consent preview', async () => {
    const preview = await previewPluginInstall({ kind: 'path', path: pluginDir })
    expect(preview.userConfig?.map((field) => field.key)).toEqual([
      'SMOKE_TOKEN',
      'SMOKE_REGION',
      'SMOKE_RETRIES',
      'SMOKE_ENABLED',
    ])
    expect(preview.userConfig?.find((field) => field.key === 'SMOKE_TOKEN')?.sensitive).toBe(true)
  })

  it('persists collected values on install', async () => {
    await installPluginWithConsent(
      { kind: 'path', path: pluginDir },
      { SMOKE_TOKEN: 'secret', SMOKE_REGION: 'us', SMOKE_RETRIES: 5, SMOKE_ENABLED: false },
    )

    const stored = await getPluginUserConfig('smoke-plugin@local')
    expect(stored).toEqual({ SMOKE_TOKEN: 'secret', SMOKE_REGION: 'us', SMOKE_RETRIES: 5, SMOKE_ENABLED: false })
  })

  it('falls back to manifest defaults for omitted fields', async () => {
    await installPluginWithConsent({ kind: 'path', path: pluginDir }, { SMOKE_TOKEN: 'secret' })

    const stored = await getPluginUserConfig('smoke-plugin@local')
    expect(stored).toEqual({ SMOKE_TOKEN: 'secret', SMOKE_REGION: 'cn', SMOKE_RETRIES: 3, SMOKE_ENABLED: true })
  })

  it('coerces values by field type and keeps empty sensitive fields unset', () => {
    const fields = [
      { key: 'TOKEN', type: 'string' as const, sensitive: true },
      { key: 'COUNT', type: 'number' as const },
      { key: 'FLAG', type: 'boolean' as const },
      { key: 'MODE', type: 'string' as const, default: 'auto' },
    ]

    expect(buildUserConfigValues(fields, { TOKEN: '', COUNT: '7', FLAG: 'true' })).toEqual({
      COUNT: 7,
      FLAG: true,
      MODE: 'auto',
    })
  })
})
