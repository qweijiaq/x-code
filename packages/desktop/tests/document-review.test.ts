import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applyDocumentHunks,
  documentDiff,
  ensureBaseline,
  saveCurrentBaseline,
} from '../src/runtime/document-review.js'

let root = ''
let previousHome: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-doc-review-'))
  previousHome = process.env.X_CODE_HOME
  process.env.X_CODE_HOME = path.join(root, 'home')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  fs.rmSync(root, { recursive: true, force: true })
})

function makeLines(alpha: string, omega: string): string {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
  lines[1] = alpha
  lines[18] = omega
  return `${lines.join('\n')}\n`
}

describe('document review', () => {
  it('captures a baseline on first open and reports later changes', async () => {
    const file = path.join(root, 'notes.md')
    fs.writeFileSync(file, 'first version\n')

    const initial = await ensureBaseline(file)
    expect(initial.editable).toBe(true)
    expect(initial.changed).toBe(false)

    fs.writeFileSync(file, 'second version\n')
    const changed = await ensureBaseline(file)
    expect(changed.changed).toBe(true)
    expect(changed.hash).toBe(initial.hash)
  })

  it('diffs against the baseline and applies only the accepted hunks', async () => {
    const file = path.join(root, 'doc.md')
    fs.writeFileSync(file, makeLines('alpha', 'omega'))
    await ensureBaseline(file)

    fs.writeFileSync(file, makeLines('ALPHA', 'OMEGA'))
    const diff = await documentDiff(file)
    expect(diff).not.toBeNull()
    expect(diff!.hunks).toHaveLength(2)
    expect(diff!.additions).toBe(2)
    expect(diff!.removals).toBe(2)

    const applied = await applyDocumentHunks(file, [0], diff!.hash)
    expect(applied.applied).toBe(1)

    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('ALPHA')
    expect(content).toContain('omega')
    expect(content).not.toContain('OMEGA')

    // 基线此时已匹配应用后的内容，因此审查是干净的。
    expect(await documentDiff(file)).toBeNull()
  })

  it('refuses to apply when the file changed after the diff', async () => {
    const file = path.join(root, 'race.md')
    fs.writeFileSync(file, makeLines('alpha', 'omega'))
    await ensureBaseline(file)
    fs.writeFileSync(file, makeLines('ALPHA', 'omega'))
    const diff = await documentDiff(file)

    fs.writeFileSync(file, makeLines('ALPHA', 'omega') + 'external edit\n')

    await expect(applyDocumentHunks(file, [0], diff!.hash)).rejects.toThrow('File changed')
  })

  it('can take the current content as the new baseline', async () => {
    const file = path.join(root, 'accept.md')
    fs.writeFileSync(file, 'before\n')
    await ensureBaseline(file)
    fs.writeFileSync(file, 'after\n')

    await saveCurrentBaseline(file)

    expect(await documentDiff(file)).toBeNull()
    expect((await ensureBaseline(file)).changed).toBe(false)
  })
})
