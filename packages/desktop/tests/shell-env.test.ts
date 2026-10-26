import { describe, expect, it } from 'vitest'

import { applyLoginShellEnv, parseLoginShellEnv } from '../src/runtime/shell-env.js'

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
