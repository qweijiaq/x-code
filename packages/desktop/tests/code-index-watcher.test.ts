import { describe, expect, it } from 'vitest'

import { isWatchedCodePath } from '../src/runtime/code-index-watcher.js'

describe('code index watcher filter', () => {
  it('accepts code files', () => {
    expect(isWatchedCodePath('src/auth.ts')).toBe(true)
    expect(isWatchedCodePath('packages/core/src/loop.tsx')).toBe(true)
    expect(isWatchedCodePath(undefined)).toBe(true)
  })

  it('rejects non-code files and skipped directories', () => {
    expect(isWatchedCodePath('README.md')).toBe(false)
    expect(isWatchedCodePath('node_modules/pkg/index.js')).toBe(false)
    expect(isWatchedCodePath('dist/bundle.js')).toBe(false)
    expect(isWatchedCodePath('.git/config.ts')).toBe(false)
    expect(isWatchedCodePath('src/.cache/generated.ts')).toBe(false)
  })
})
