import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConsentPreview, InstalledPluginRecord } from '@x-code-cli/core'

import { updateInstalledPlugin } from '../src/plugins/update.js'

const coreMocks = vi.hoisted(() => ({
  installPlugin: vi.fn(),
}))

vi.mock('@x-code-cli/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@x-code-cli/core')>()
  return { ...original, installPlugin: coreMocks.installPlugin }
})

const record: InstalledPluginRecord = {
  id: 'demo@market',
  name: 'demo',
  marketplace: 'market',
  version: '1.0.0',
  source: { kind: 'github', owner: 'acme', repo: 'demo' },
  installedAt: '2026-01-01T00:00:00.000Z',
  installScope: 'user',
}

describe('shared plugin update operation', () => {
  beforeEach(() => {
    coreMocks.installPlugin.mockReset()
  })

  it('reports unchanged when the remote version matches', async () => {
    coreMocks.installPlugin.mockResolvedValue({ manifest: { version: '1.0.0' } })
    await expect(updateInstalledPlugin(record)).resolves.toMatchObject({
      status: 'unchanged',
      version: '1.0.0',
    })
  })

  it('reports the new version when updated', async () => {
    coreMocks.installPlugin.mockResolvedValue({ manifest: { version: '2.0.0' } })
    await expect(updateInstalledPlugin(record)).resolves.toMatchObject({
      status: 'updated',
      version: '2.0.0',
    })
  })

  it('turns install errors into a failed result instead of throwing', async () => {
    coreMocks.installPlugin.mockRejectedValue(new Error('network down'))
    await expect(updateInstalledPlugin(record)).resolves.toMatchObject({
      status: 'failed',
      error: 'network down',
    })
  })

  it('passes the consent callback through', async () => {
    const consent = vi.fn(async (_preview: ConsentPreview) => true)
    coreMocks.installPlugin.mockResolvedValue({ manifest: { version: '1.0.1' } })
    await updateInstalledPlugin(record, { consent })
    expect(coreMocks.installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ consent, expectedName: 'demo', marketplace: 'market' }),
    )
  })
})
