import { describe, expect, it } from 'vitest'

import { detectShell, renderCompletion } from '../src/completion.js'

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
