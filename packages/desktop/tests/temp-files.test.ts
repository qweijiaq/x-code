import { afterAll, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isTempSourcePath, moveTempFilesIntoWorkspace } from '../src/runtime/temp-files.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-temp-files-'))
const workspace = fs.mkdtempSync(path.join(scratch, 'workspace-'))
const sources = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-temp-sources-'))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.rmSync(sources, { recursive: true, force: true })
})

describe('temp deliverable moves', () => {
  it('only accepts files under the system temp directory', () => {
    expect(isTempSourcePath(path.join(os.tmpdir(), 'x.txt'))).toBe(true)
    expect(isTempSourcePath('/tmp/x.txt')).toBe(true)
    expect(isTempSourcePath('/Users/someone/project/x.txt')).toBe(false)
    expect(isTempSourcePath('/tmp-not-temp/x.txt')).toBe(false)
  })

  it('copies into the workspace, removes the source, and preserves the name', async () => {
    const source = path.join(sources, 'transcript.txt')
    fs.writeFileSync(source, 'hello')

    const result = await moveTempFilesIntoWorkspace([source], workspace)

    expect(result.errors).toEqual([])
    expect(result.moved).toHaveLength(1)
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.readFileSync(result.moved[0]!.to, 'utf8')).toBe('hello')
    expect(path.basename(result.moved[0]!.to)).toBe('transcript.txt')
  })

  it('never overwrites an existing workspace file', async () => {
    const source = path.join(sources, 'report.md')
    fs.writeFileSync(source, 'new')
    fs.writeFileSync(path.join(workspace, 'report.md'), 'existing')

    const result = await moveTempFilesIntoWorkspace([source], workspace)

    expect(result.errors).toEqual([])
    expect(path.basename(result.moved[0]!.to)).toBe('report (1).md')
    expect(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8')).toBe('existing')
    expect(fs.readFileSync(result.moved[0]!.to, 'utf8')).toBe('new')
  })

  it('reports outside-workspace sources and directories without moving them', async () => {
    const outside = path.join(os.homedir(), 'xcode-test-outside', 'already-here.txt')
    const directory = path.join(sources, 'folder')
    fs.mkdirSync(directory)

    const result = await moveTempFilesIntoWorkspace([outside, directory], workspace)

    expect(result.moved).toEqual([])
    expect(result.errors).toHaveLength(2)
    expect(fs.existsSync(directory)).toBe(true)
  })
})
