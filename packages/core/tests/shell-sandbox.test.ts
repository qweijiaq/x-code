import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { executeHook } from '../src/hooks/executor.js'
import type { HookEvent, RegisteredHook } from '../src/hooks/types.js'
import { getShellProvider } from '../src/tools/shell-provider.js'
import { sandboxProfileText, sanitizeShellEnv, setShellSandbox } from '../src/utils/shell-sandbox.js'

const itDarwin = it.runIf(process.platform === 'darwin')

afterEach(() => {
  setShellSandbox({ enabled: false, allowNetwork: false, workspace: process.cwd(), includeExtensions: false })
})

describe('macOS shell sandbox profile', () => {
  it('restricts writes to the workspace and temp and denies network by default', () => {
    const profile = sandboxProfileText({
      enabled: true,
      workspace: '/tmp/work space',
      allowNetwork: false,
      includeExtensions: false,
    })

    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(subpath "/tmp/work space")')
    expect(profile).toContain('/private/tmp')
    expect(profile).toContain('skill-runtime')
    expect(profile).toContain('.ssh')
    expect(profile).toContain('desktop-secrets.json')
  })

  it('omits the network deny when the user allows network', () => {
    const profile = sandboxProfileText({
      enabled: true,
      workspace: '/tmp/w',
      allowNetwork: true,
      includeExtensions: false,
    })

    expect(profile).not.toContain('(deny network*)')
  })
})

describe('shell environment scrubbing', () => {
  itDarwin('strips credential variables while keeping ordinary ones', () => {
    const env = sanitizeShellEnv(
      {
        PATH: '/bin',
        HOME: '/tmp',
        ANTHROPIC_API_KEY: 'x',
        GITHUB_TOKEN: 'y',
        AWS_SECRET_ACCESS_KEY: 'z',
        NORMAL: 'kept',
      },
      { enabled: true, workspace: '/tmp', allowNetwork: false, includeExtensions: false },
    )

    expect(env).toEqual({ PATH: '/bin', HOME: '/tmp', NORMAL: 'kept' })
  })

  it('leaves the environment untouched when the sandbox is off', () => {
    const env = { ANTHROPIC_API_KEY: 'x' }
    expect(
      sanitizeShellEnv(env, { enabled: false, workspace: '/tmp', allowNetwork: false, includeExtensions: false }),
    ).toBe(env)
  })
})

describe('sandboxed shell execution', () => {
  itDarwin('allows writes inside the workspace and blocks writes outside it', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-sandbox-'))
    setShellSandbox({ enabled: true, workspace, allowNetwork: false, includeExtensions: false })
    const provider = getShellProvider()

    const inside = await provider.spawn('echo ok > inside.txt', {
      timeout: 15_000,
      cwd: workspace,
      env: process.env,
    })
    expect(inside.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8').trim()).toBe('ok')

    const escape = path.join(os.homedir(), `x-code-sandbox-escape-${process.pid}.txt`)
    fs.rmSync(escape, { force: true })
    const outside = await provider.spawn(`echo bad > "${escape}"`, {
      timeout: 15_000,
      cwd: workspace,
      env: process.env,
    })
    expect(fs.existsSync(escape)).toBe(false)
    expect(outside.exitCode).not.toBe(0)

    fs.rmSync(escape, { force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  itDarwin('does not pass API keys into sandboxed commands', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-sandbox-env-'))
    setShellSandbox({ enabled: true, workspace, allowNetwork: false, includeExtensions: false })

    const result = await getShellProvider().spawn('printf %s "$ANTHROPIC_API_KEY"', {
      timeout: 15_000,
      cwd: workspace,
      env: { ...process.env, ANTHROPIC_API_KEY: 'super-secret' },
    })

    expect(result.stdout).toBe('')
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  itDarwin('sandboxes hook commands when extension sandboxing is enabled', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-hook-sandbox-'))
    setShellSandbox({ enabled: true, workspace, allowNetwork: false, includeExtensions: true })
    const escape = path.join(os.homedir(), `x-code-hook-sandbox-escape-${process.pid}.txt`)
    fs.rmSync(escape, { force: true })

    const hook: RegisteredHook = {
      pluginId: 'user',
      pluginDir: workspace,
      event: 'SessionStart',
      entry: { command: `echo ok > hook-inside.txt; echo bad > "${escape}"` },
    }
    const event: HookEvent = {
      name: 'SessionStart',
      session: { cwd: workspace, modelId: 'demo:mock' },
    }
    await executeHook(hook, event)

    expect(fs.existsSync(path.join(workspace, 'hook-inside.txt'))).toBe(true)
    expect(fs.existsSync(escape)).toBe(false)

    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(escape, { force: true })
  })
})
