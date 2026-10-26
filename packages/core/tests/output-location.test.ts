import { afterAll, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  isSystemTempPath,
  noteForRecentTempFiles,
  tempPathsInText,
  workspaceOutputNote,
} from '../src/utils/output-location.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-output-location-'))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

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

  it('extracts temp paths from shell commands, including $TMPDIR', () => {
    const paths = tempPathsInText(
      `ffmpeg -i in.wav -t 300 /tmp/first5min.wav && echo "\$TMPDIR/out.txt" && cat /tmp/old.log`,
    )
    expect(paths).toContain('/tmp/first5min.wav')
    expect(paths).toContain(path.join(os.tmpdir(), 'out.txt'))
    expect(paths).toContain('/tmp/old.log')
  })

  it('only reminds about temp files created during the command', async () => {
    const recent = path.join(scratch, 'recent.txt')
    const old = path.join(scratch, 'old.txt')
    fs.writeFileSync(recent, 'new')
    fs.writeFileSync(old, 'old')
    fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))

    const note = await noteForRecentTempFiles(`write ${recent} and read ${old}`, 0, scratch)

    expect(note).toContain(recent)
    expect(note).not.toContain(old)
  })
})
