import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectShell, renderCompletion, runCompletionCommand } from '../src/completion.js'

describe('shell completion', () => {
  it('renders a bash completion script with subcommands, options and value choices', () => {
    const script = renderCompletion('bash')
    expect(script).toContain('_xc()')
    expect(script).toContain('complete -F _xc xc x-code')
    expect(script).toContain('watch trace audit plugin login logout completion')
    expect(script).toContain('--output-format')
    expect(script).toContain('text json jsonl')
    expect(script).toContain('--external-content-policy')
    expect(script).toContain('off approve')
    expect(script).toContain('marketplace')
  })

  it('renders a zsh completion script', () => {
    const script = renderCompletion('zsh')
    expect(script).toContain('#compdef xc x-code')
    expect(script).toContain("_values 'command' watch trace audit plugin login logout completion")
    expect(script).toContain("_values 'plugin command'")
    expect(script).toContain('_xc "$@"')
  })

  it('renders a fish completion script for both binary names', () => {
    const script = renderCompletion('fish')
    expect(script).toContain('complete -c xc -f')
    expect(script).toContain('complete -c x-code -f')
    expect(script).toContain("__fish_use_subcommand' -a trace")
    expect(script).toContain("__fish_seen_subcommand_from plugin' -a install")
    expect(script).toContain('-l output-format')
  })

  it('detects the shell from $SHELL and falls back to bash', () => {
    expect(detectShell('/bin/zsh')).toBe('zsh')
    expect(detectShell('/usr/local/bin/fish')).toBe('fish')
    expect(detectShell('/bin/bash')).toBe('bash')
    expect(detectShell('/bin/sh')).toBe('bash')
    expect(detectShell('')).toBe('bash')
  })
})

describe('completion subcommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function captureStdout(): () => string {
    let written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return () => written
  }

  it('falls back to the $SHELL script instead of shipping fish to zsh users', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const read = captureStdout()

    expect(runCompletionCommand([])).toBe(0)
    expect(read()).toContain('#compdef xc x-code')
    expect(read()).not.toContain('complete -c xc -f')
  })

  it('accepts a case-insensitive shell name', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const read = captureStdout()

    expect(runCompletionCommand(['ZSH'])).toBe(0)
    expect(read()).toContain('#compdef xc x-code')
  })

  it('rejects an unknown shell', () => {
    const stdout = captureStdout()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runCompletionCommand(['tcsh'])).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown shell: tcsh'))
    expect(stdout()).toBe('')
  })
})
