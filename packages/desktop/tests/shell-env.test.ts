import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyLoginShellEnv, parseLoginShellEnv } from '../src/runtime/shell-env.js'
import { ptyEnv } from '../src/runtime/shell.js'

describe('login shell environment', () => {
  it('parses the marker-delimited NUL-separated snapshot', () => {
    const stdout =
      'rc noise\n__XCODE_ENV_BEGIN__PATH=/opt/homebrew/bin:/usr/bin\0FOO=a=b\0EMPTY=\0__XCODE_ENV_END__prompt'
    expect(parseLoginShellEnv(stdout)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      FOO: 'a=b',
      EMPTY: '',
    })
  })

  it('ignores output without markers', () => {
    expect(parseLoginShellEnv('PATH=/usr/bin\0')).toBeNull()
  })

  it('updates PATH and adds missing variables without clobbering app values', () => {
    const current: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      DEEPSEEK_API_KEY: 'stored-key',
      X_CODE_HOME: '/tmp/x-code',
    }
    const result = applyLoginShellEnv(current, {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      DEEPSEEK_API_KEY: 'shell-key',
      X_CODE_HOME: '/home/someone/.x-code',
      HF_TOKEN: 'hf_123',
      PWD: '/Users/someone',
      _: '/bin/zsh',
    })

    expect(current.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(current.DEEPSEEK_API_KEY).toBe('stored-key')
    expect(current.X_CODE_HOME).toBe('/tmp/x-code')
    expect(current.HF_TOKEN).toBe('hf_123')
    expect(current.PWD).toBeUndefined()
    expect(current._).toBeUndefined()
    expect(result).toEqual({ added: 1, updated: ['PATH'] })
  })
})

describe('terminal environment', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults a GUI-launched shell to UTF-8', () => {
    vi.stubEnv('LANG', '')
    vi.stubEnv('LC_CTYPE', '')
    vi.stubEnv('LC_ALL', '')

    const env = ptyEnv()

    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.TERM).toBe('xterm-256color')
  })

  it('replaces a non-UTF-8 locale instead of keeping C', () => {
    vi.stubEnv('LANG', 'C')
    vi.stubEnv('LC_CTYPE', 'C')
    vi.stubEnv('LC_ALL', 'C')

    expect(ptyEnv()).toMatchObject({ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
  })

  it('preserves a UTF-8 locale chosen by the user', () => {
    vi.stubEnv('LANG', 'zh_CN.UTF-8')
    vi.stubEnv('LC_CTYPE', 'zh_CN.UTF-8')
    vi.stubEnv('LC_ALL', '')

    expect(ptyEnv()).toMatchObject({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })
  })
})
