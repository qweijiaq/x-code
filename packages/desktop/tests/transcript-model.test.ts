import { describe, expect, it } from 'vitest'

import {
  attachmentName,
  extractSourceUrls,
  formatContextTokens,
  formatDuration,
  normalizeTaskMode,
  sessionTitle,
  summarizeInput,
  taskBranchName,
  tempDeliverables,
  toolEnvironmentHint,
} from '../src/renderer/transcript-model.js'

describe('transcript model', () => {
  it('normalizes task modes with a coding fallback', () => {
    expect(normalizeTaskMode('writing')).toBe('writing')
    expect(normalizeTaskMode('office')).toBe('office')
    expect(normalizeTaskMode('unknown')).toBe('coding')
    expect(normalizeTaskMode(undefined)).toBe('coding')
  })

  it('builds a task-scoped branch name', () => {
    expect(taskBranchName('Fix the Login Bug!')).toMatch(/^x-code\/fix-the-login-bug-[a-z0-9]{1,5}$/)
    expect(taskBranchName('中文任务')).toMatch(/^x-code\/task-[a-z0-9]{1,5}$/)
  })

  it('summarizes the first useful tool input and truncates long values', () => {
    expect(summarizeInput(undefined)).toBe('')
    expect(summarizeInput({ command: 'npm test', filePath: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(summarizeInput({ path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    const long = summarizeInput({ query: 'x'.repeat(200) })
    // slice(0, 87) + 省略号 = 88 个字符
    expect(long).toHaveLength(88)
    expect(long.endsWith('…')).toBe(true)
  })

  it('falls back through the session title fields', () => {
    expect(sessionTitle({ name: 'Named', title: 'Title', firstPrompt: 'Prompt', sessionId: 'id' } as never)).toBe(
      'Named',
    )
    expect(sessionTitle({ name: '', title: 'Title', firstPrompt: 'Prompt', sessionId: 'id' } as never)).toBe('Title')
    expect(sessionTitle({ name: '', title: '', firstPrompt: '', sessionId: 'id' } as never)).toBe('id')
  })

  it('formats context sizes and durations', () => {
    expect(formatContextTokens(999)).toBe('999')
    expect(formatContextTokens(1500)).toBe('1.5k')
    expect(formatContextTokens(2_400_000)).toBe('2.4m')
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(125)).toBe('2:05')
  })

  it('extracts a basename from POSIX and Windows paths', () => {
    expect(attachmentName('/tmp/report.pdf')).toBe('report.pdf')
    expect(attachmentName('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
  })

  it('classifies sandbox and command failures', () => {
    expect(toolEnvironmentHint('Could not resolve host: example.com', true)).toBe('network')
    expect(toolEnvironmentHint('Operation not permitted', true)).toBe('write')
    expect(toolEnvironmentHint('sh: foo: not found', false)).toBe('command')
    expect(toolEnvironmentHint('all good', true)).toBeNull()
    // 沙箱关闭时网络/写入错误不归因于沙箱。
    expect(toolEnvironmentHint('Operation not permitted', false)).toBeNull()
  })

  it('extracts temp deliverables from the tool output marker', () => {
    const text =
      '[Output location] /tmp/a/out.pdf is in the system temporary directory\n' +
      '[Output location] /tmp/b/out.xlsx is in the system temporary directory\n' +
      '[Output location] /tmp/a/out.pdf is in the system temporary directory'
    expect(tempDeliverables(text)).toEqual(['/tmp/a/out.pdf', '/tmp/b/out.xlsx'])
    expect(tempDeliverables(undefined)).toEqual([])
  })

  it('extracts unique https sources and drops trailing punctuation', () => {
    const text = 'see https://example.com/a, and https://example.com/a and http://insecure.test and https://b.test/x.'
    expect(extractSourceUrls(text)).toEqual(['https://example.com/a', 'https://b.test/x'])
  })
})
