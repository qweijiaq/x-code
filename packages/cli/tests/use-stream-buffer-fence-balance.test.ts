import { marked } from 'marked'
import { describe, expect, it } from 'vitest'

import { balanceFenceChunk, hasOpenCodeFence } from '../src/ui/agent/use-stream-buffer.js'

/** 一条 streamingChunk 消息被 marked 单独词法分析后，正文是否落在代码块里。 */
function proseIsInsideCodeBlock(message: string, prose: string): boolean {
  const tokens = marked.lexer(message) as Array<{ type: string; raw?: string; text?: string }>
  return tokens.some((token) => token.type === 'code' && `${token.text ?? ''}`.includes(prose))
}

describe('stream buffer fence balancing', () => {
  it('closes the fence it carries out of the buffer', () => {
    // 强制中间提交：开栏行随代码一起送走，这条消息必须自己闭合。
    const balanced = balanceFenceChunk('```ts\nconst a = 1\n', false)
    expect(balanced).toBe('```ts\nconst a = 1\n```\n')
    expect(hasOpenCodeFence(balanced)).toBe(false)
  })

  it('reopens the fence for interior lines that no longer carry their opening line', () => {
    const balanced = balanceFenceChunk('const a = 1\nconst b = 2\n', true)
    expect(balanced).toBe('```\nconst a = 1\nconst b = 2\n```\n')
    expect(hasOpenCodeFence(balanced)).toBe(false)
    // 包进围栏里也避免围栏内的 `*` / `_` 被当成行内 markdown 渲染。
    expect(proseIsInsideCodeBlock(balanced, 'const b = 2')).toBe(true)
  })

  it('does not let a closing fence swallow the prose that follows it', () => {
    // 旧行为：缓冲里只剩围栏内部的行 + 闭栏 + 其后正文，闭栏在独立消息里被当成
    // 开栏，`Prose after.` 整段渲染成代码块。
    const chunk = 'const b = 2\n```\nProse after.\n'
    expect(proseIsInsideCodeBlock(chunk, 'Prose after.')).toBe(true)

    const balanced = balanceFenceChunk(chunk, true)
    expect(balanced).toBe('```\nconst b = 2\n```\nProse after.\n')
    expect(hasOpenCodeFence(balanced)).toBe(false)
    expect(proseIsInsideCodeBlock(balanced, 'Prose after.')).toBe(false)
  })

  it('leaves chunks that carry no unclosed fence untouched', () => {
    expect(balanceFenceChunk('plain paragraph\n', false)).toBe('plain paragraph\n')
  })

  it('treats ~~~ and indented fences as fences', () => {
    expect(balanceFenceChunk('~~~\nconst a = 1\n', false)).toBe('~~~\nconst a = 1\n```\n')
    expect(balanceFenceChunk('  ```ts\nconst a = 1\n', false)).toBe('  ```ts\nconst a = 1\n```\n')
    expect(hasOpenCodeFence('  ```ts\ncode\n')).toBe(true)
    expect(hasOpenCodeFence('~~~\ncode\n')).toBe(true)
  })
})
