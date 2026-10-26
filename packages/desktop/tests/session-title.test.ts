import { describe, expect, it } from 'vitest'

import { cleanSessionTitle } from '../src/runtime/session-title.js'

describe('cleanSessionTitle', () => {
  it('strips quotes, prefixes, code fences and trailing punctuation', () => {
    expect(cleanSessionTitle('Title: "修复登录超时。"')).toBe('修复登录超时')
    expect(cleanSessionTitle('```\nRefactor auth flow\n```')).toBe('Refactor auth flow')
    expect(cleanSessionTitle('标题：插件市场安装失败')).toBe('插件市场安装失败')
  })

  it('keeps the first non-empty line and caps length', () => {
    expect(cleanSessionTitle('\n\n  Fix the build  \nsecond line')).toBe('Fix the build')
    expect(cleanSessionTitle('a'.repeat(100))).toHaveLength(60)
    expect(cleanSessionTitle('   ')).toBe('')
  })
})
