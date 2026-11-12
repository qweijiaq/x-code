import { describe, expect, it } from 'vitest'

import { renderSessionHtml } from '../src/runtime/session-export.js'
import type { LoadedSessionView } from '../src/shared/protocol.js'

const view: LoadedSessionView = {
  sessionId: 's1',
  filePath: '/tmp/s1.jsonl',
  modelId: 'test:model',
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, currentContextTokens: 30 },
  messages: [
    { id: 'm1', role: 'user', text: 'show <script>alert(1)</script>' },
    { id: 'm2', role: 'assistant', text: 'done' },
    {
      id: 'm3',
      role: 'tool',
      text: '',
      toolName: 'readFile',
      toolInput: { filePath: '/tmp/a.ts' },
      toolOutput: 'const a = 1',
      toolStatus: 'completed',
    },
  ],
}

describe('session HTML replay export', () => {
  it('renders messages and tool details without injecting raw HTML', () => {
    const html = renderSessionHtml(view, 'Demo session')
    expect(html).toContain('Demo session')
    expect(html).toContain('class="user"')
    expect(html).toContain('class="tool"')
    expect(html).toContain('readFile')
    expect(html).toContain('const a = 1')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
