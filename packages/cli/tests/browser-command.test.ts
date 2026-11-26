import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentOptions } from '@x-code-cli/core'

import { createBrowserCommandHandler } from '../src/ui/app/commands/browser.js'

const browserMocks = vi.hoisted(() => ({
  config: { browser: { enabled: false, visualCheck: true, headless: true } } as Record<string, any>,
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
  shutdownBrowserMcp: vi.fn(async () => undefined),
}))

vi.mock('@x-code-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@x-code-cli/core')>()
  return {
    ...actual,
    loadUserConfig: browserMocks.loadUserConfig,
    saveUserConfig: browserMocks.saveUserConfig,
    shutdownBrowserMcp: browserMocks.shutdownBrowserMcp,
  }
})

function setup(interactive: boolean, visualCheck: boolean) {
  let interactiveEnabled = interactive
  const options = {
    browserVisualCheckEnabled: visualCheck,
    subAgentRegistry: {
      names: () => (interactiveEnabled ? ['browser'] : []),
      setBrowserEnabled: (enabled: boolean) => {
        interactiveEnabled = enabled
      },
    },
  } as unknown as AgentOptions
  const addCommandMessage = vi.fn()
  const addCommandResult = vi.fn()
  const invalidateSystemPromptCache = vi.fn()
  const { handleBrowser } = createBrowserCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    invalidateSystemPromptCache,
  })
  return { options, handleBrowser, addCommandMessage, addCommandResult, invalidateSystemPromptCache }
}

describe('/browser command', () => {
  beforeEach(() => {
    browserMocks.config = { browser: { enabled: false, visualCheck: true, headless: true } }
    browserMocks.loadUserConfig.mockReset()
    browserMocks.loadUserConfig.mockImplementation(() => browserMocks.config)
    browserMocks.saveUserConfig.mockReset()
    browserMocks.shutdownBrowserMcp.mockClear()
  })

  it('toggles automatic visual checks independently and preserves other browser settings', async () => {
    const command = setup(false, true)

    await command.handleBrowser('/browser check-off', 'check-off')

    expect(command.options.browserVisualCheckEnabled).toBe(false)
    expect(browserMocks.saveUserConfig).toHaveBeenCalledWith({
      browser: { enabled: false, visualCheck: false, headless: true },
    })
    expect(browserMocks.shutdownBrowserMcp).toHaveBeenCalledOnce()
    expect(command.invalidateSystemPromptCache).toHaveBeenCalledOnce()
  })

  it('keeps the shared browser alive when Browser Use turns off but visual checks remain on', async () => {
    const command = setup(true, true)

    await command.handleBrowser('/browser off', 'off')

    expect(browserMocks.shutdownBrowserMcp).not.toHaveBeenCalled()
    expect(command.addCommandResult.mock.calls[0]?.[0]).toContain('stays available')
  })

  it('reports both independent states', async () => {
    const command = setup(false, true)

    await command.handleBrowser('/browser', '')

    expect(command.addCommandMessage).toHaveBeenCalledWith(
      '/browser',
      'Interactive Browser Use is OFF; automatic local visual checks are ON.',
    )
  })

  it('still applies the toggle when the config write throws', async () => {
    const command = setup(false, true)
    browserMocks.loadUserConfig.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    await command.handleBrowser('/browser check-off', 'check-off')

    expect(command.options.browserVisualCheckEnabled).toBe(false)
    expect(command.addCommandMessage).toHaveBeenCalledWith(
      '/browser check-off',
      'Automatic local visual checks OFF (this session only — config could not be saved).',
    )
  })

  it('does not report a failed toggle when only the prompt-cache refresh throws', async () => {
    const command = setup(false, false)
    command.invalidateSystemPromptCache.mockImplementation(() => {
      throw new Error('cache exploded')
    })

    await command.handleBrowser('/browser on', 'on')

    // agent 已经切换成功：不能再报「Failed to enable」。
    expect(command.addCommandMessage).toHaveBeenCalledWith(
      '/browser on',
      'Interactive browser agent ON (this session only).',
    )
    expect(command.addCommandResult.mock.calls[0]?.[0]).toContain('system prompt cache could not be refreshed')
  })

  it('gives up on a hung shared-browser shutdown instead of hanging the command', async () => {
    vi.useFakeTimers()
    try {
      const command = setup(false, true)
      browserMocks.shutdownBrowserMcp.mockImplementationOnce(() => new Promise<never>(() => {}))

      const pending = command.handleBrowser('/browser check-off', 'check-off')
      await vi.advanceTimersByTimeAsync(5_000)
      await pending

      expect(command.addCommandResult.mock.calls[0]?.[0]).toContain('could not be closed')
    } finally {
      vi.useRealTimers()
    }
  })
})
