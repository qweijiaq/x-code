import { describe, expect, it } from 'vitest'

import { parsePageTexts } from '../src/runtime/document-view.js'

describe('document-view page parsing', () => {
  it('splits the --- Page N --- blocks emitted by readDocument', () => {
    const pages = parsePageTexts('--- Page 1 ---\nhello\n\n--- Page 2 ---\nworld\n')
    expect(pages.get(1)).toBe('hello')
    expect(pages.get(2)).toBe('world')
  })

  it('returns an empty map when there are no page markers', () => {
    expect(parsePageTexts('plain text').size).toBe(0)
  })
})
