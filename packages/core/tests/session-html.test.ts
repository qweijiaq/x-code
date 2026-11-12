import { describe, expect, it } from 'vitest'

import { renderSessionHtml } from '../src/export/session-html.js'

describe('renderSessionHtml', () => {
  it('renders messages, tool details and usage without injecting raw HTML', () => {
    const html = renderSessionHtml(
      {
        title: 'Demo <session>',
        sessionId: 's1',
        modelId: 'test:model',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      [
        { role: 'user', text: 'show <script>alert(1)</script>' },
        { role: 'assistant', text: 'done' },
        { role: 'system', text: 'system note' },
        { role: 'error', text: 'boom' },
        {
          role: 'tool',
          text: '',
          toolName: 'readFile',
          toolInput: { filePath: '/tmp/a.ts' },
          toolOutput: 'const a = 1',
          toolStatus: 'completed',
        },
      ],
    )
    expect(html).toContain('Demo &lt;session&gt;')
    expect(html).toContain('class="user"')
    expect(html).toContain('class="tool"')
    expect(html).toContain('readFile')
    expect(html).toContain('const a = 1')
    expect(html).toContain('↑10 ↓20')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('omits usage when the session has no token counts', () => {
    const html = renderSessionHtml({ title: 't', sessionId: 's2' }, [{ role: 'user', text: 'hi' }])
    expect(html).not.toContain('↑')
    expect(html).toContain('<h1>t</h1>')
  })
})
