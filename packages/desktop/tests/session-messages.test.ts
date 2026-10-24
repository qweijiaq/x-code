import { describe, expect, it } from 'vitest'

import type { ModelMessage } from '@x-code-cli/core'

import { toSessionMessages } from '../src/runtime/sessions.js'

function userMessage(content: unknown[]): ModelMessage[] {
  return [{ role: 'user', content }] as unknown as ModelMessage[]
}

describe('desktop session message conversion', () => {
  it('restores image attachments and keeps only the user prompt', () => {
    const messages = userMessage([
      { type: 'text', text: '请分析这张图\n\n@"/tmp/shot.png"' },
      { type: 'text', text: '<<file kind="image" path="/tmp/shot.png">>' },
      { type: 'file', data: 'aGVsbG8=', mediaType: 'image/png', filename: 'shot.png' },
      {
        type: 'text',
        text: '[Built-in local media processing succeeded. Analyze the supplied content directly.]',
      },
    ])

    const out = toSessionMessages(messages)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'user', text: '请分析这张图' })
    expect(out[0]?.attachmentViews).toEqual([
      {
        name: 'shot.png',
        path: '/tmp/shot.png',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,aGVsbG8=',
      },
    ])
  })

  it('restores path-only images when ingestion fell back to a text notice', () => {
    const messages = userMessage([
      { type: 'text', text: 'image attachment smoke\n\n@"/tmp/corrupt.png"' },
      { type: 'text', text: '[Image /tmp/corrupt.png is corrupt or could not be decoded locally.]' },
    ])

    const out = toSessionMessages(messages)
    expect(out[0]).toMatchObject({ role: 'user', text: 'image attachment smoke' })
    expect(out[0]?.attachmentViews).toEqual([{ name: 'corrupt.png', path: '/tmp/corrupt.png', mime: 'image/png' }])
  })

  it('skips plugin context and renders non-image file parts as chips', () => {
    const messages = userMessage([
      { type: 'text', text: '<plugin_context>\nprivate context\n</plugin_context>\n\n' },
      { type: 'text', text: '总结这个 PDF' },
      { type: 'text', text: '<<file kind="pdf" path="/tmp/report.pdf">>' },
      { type: 'file', data: { type: 'data', data: 'JVBERi0=' }, mediaType: 'application/pdf', filename: 'report.pdf' },
    ])

    const out = toSessionMessages(messages)
    expect(out[0]).toMatchObject({ role: 'user', text: '总结这个 PDF' })
    expect(out[0]?.attachmentViews).toEqual([{ name: 'report.pdf', mime: 'application/pdf', path: '/tmp/report.pdf' }])
  })

  it('restores legacy image parts using the media tag filename', () => {
    const messages = userMessage([
      { type: 'text', text: 'describe' },
      { type: 'text', text: '<<file kind="image" path="/tmp/legacy.jpg">>' },
      { type: 'image', image: 'aGVsbG8=', mediaType: 'image/jpeg' },
    ])

    const out = toSessionMessages(messages)
    expect(out[0]?.attachmentViews).toEqual([
      {
        name: 'legacy.jpg',
        path: '/tmp/legacy.jpg',
        mime: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
      },
    ])
  })

  it('keeps every merged queued prompt but drops wrapped attachment text', () => {
    const messages = userMessage([
      { type: 'text', text: 'New input arrived while you were working:\n' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'first queued' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'second queued' },
      { type: 'text', text: '<<file kind="pdf" path="/tmp/doc.pdf">>\nextracted body\n<</file>>' },
      { type: 'text', text: '\n\nIMPORTANT: address the input above.' },
    ])

    const text = toSessionMessages(messages)[0]?.text ?? ''
    expect(text).toContain('first queued')
    expect(text).toContain('second queued')
    expect(text).toContain('IMPORTANT: address the input above.')
    expect(text).not.toContain('extracted body')
    expect(text).not.toContain('<<file')
  })
})
