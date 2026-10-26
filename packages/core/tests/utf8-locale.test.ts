import { describe, expect, it } from 'vitest'

import { applyUtf8Locale, isUtf8Locale } from '../src/utils/utf8-locale.js'

describe('UTF-8 locale normalization', () => {
  it('fills a missing locale', () => {
    const env: Record<string, string | undefined> = {}
    applyUtf8Locale(env)
    expect(env).toEqual({ LANG: 'en_US.UTF-8' })
  })

  it('replaces C and other non-UTF-8 locales', () => {
    const env: Record<string, string | undefined> = { LANG: 'C', LC_CTYPE: 'C', LC_ALL: 'C' }
    applyUtf8Locale(env)
    expect(env).toEqual({ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
  })

  it("keeps the user's UTF-8 locale", () => {
    const env: Record<string, string | undefined> = { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' }
    applyUtf8Locale(env)
    expect(env).toEqual({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })
  })

  it('treats empty locale variables as unset', () => {
    expect(isUtf8Locale('')).toBe(false)
    const env: Record<string, string | undefined> = { LANG: '', LC_ALL: '' }
    applyUtf8Locale(env)
    expect(env).toEqual({ LANG: 'en_US.UTF-8', LC_ALL: '' })
  })
})
