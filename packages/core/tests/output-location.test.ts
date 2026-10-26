import { describe, expect, it } from 'vitest'

import os from 'node:os'
import path from 'node:path'

import { isSystemTempPath, workspaceOutputNote } from '../src/utils/output-location.js'

describe('workspace output location', () => {
  it('detects the OS temp directory and its common macOS aliases', () => {
    expect(isSystemTempPath(path.join(os.tmpdir(), 'report.txt'))).toBe(true)
    if (process.platform === 'darwin') {
      expect(isSystemTempPath('/tmp/report.txt')).toBe(true)
      expect(isSystemTempPath('/private/tmp/report.txt')).toBe(true)
      expect(isSystemTempPath('/var/tmp/report.txt')).toBe(true)
    }
  })

  it('does not treat a workspace file or a lookalike path as temp', () => {
    expect(isSystemTempPath('/Users/someone/project/report.txt')).toBe(false)
    expect(isSystemTempPath('/tmp-not-temp/report.txt')).toBe(false)
  })

  it('adds a workspace reminder only for temp outputs', () => {
    const note = workspaceOutputNote('/tmp/transcript.txt', '/Users/someone/project')
    expect(note).toContain('/Users/someone/project')
    expect(note).toContain('temporary directory')
    expect(workspaceOutputNote('/Users/someone/project/transcript.txt', '/Users/someone/project')).toBe('')
  })
})
