import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDocumentAccess, physicalPath } from '../src/runtime/document-access.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

async function writeFile(file: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

describe('document access policy', () => {
  it('allows files inside the workspace', async () => {
    const workspace = await tempDir('xcode-doc-access-workspace-')
    const inside = path.join(workspace, 'notes.md')
    await writeFile(inside)
    const access = createDocumentAccess({ workspaceRoot: () => workspace, recentPaths: () => [] })

    expect(access.assert(inside)).toBe(physicalPath(inside))
  })

  it('rejects files outside the workspace until they are granted', async () => {
    const workspace = await tempDir('xcode-doc-access-workspace-')
    const outside = path.join(await tempDir('xcode-doc-access-outside-'), 'secret.md')
    await writeFile(outside)
    const access = createDocumentAccess({ workspaceRoot: () => workspace, recentPaths: () => [] })

    expect(() => access.assert(outside)).toThrow('document-path-not-allowed')
    access.grant(outside)
    expect(access.assert(outside)).toBe(physicalPath(outside))
  })

  it('allows paths that are already in the recent-documents list', async () => {
    const workspace = await tempDir('xcode-doc-access-workspace-')
    const outside = path.join(await tempDir('xcode-doc-access-outside-'), 'paper.pdf')
    await writeFile(outside)
    const access = createDocumentAccess({ workspaceRoot: () => workspace, recentPaths: () => [outside] })

    expect(access.assert(outside)).toBe(physicalPath(outside))
  })

  it('rejects a workspace symlink that resolves outside the workspace', async () => {
    const workspace = await tempDir('xcode-doc-access-workspace-')
    const outside = await tempDir('xcode-doc-access-outside-')
    const target = path.join(outside, 'secret.md')
    await writeFile(target)
    const link = path.join(workspace, 'link.md')
    await fs.symlink(target, link)
    const access = createDocumentAccess({ workspaceRoot: () => workspace, recentPaths: () => [] })

    expect(() => access.assert(link)).toThrow('document-path-not-allowed')
  })

  it('evicts the oldest grants when the cap is reached', async () => {
    const workspace = await tempDir('xcode-doc-access-workspace-')
    const first = path.join(await tempDir('xcode-doc-access-first-'), 'a.md')
    const second = path.join(await tempDir('xcode-doc-access-second-'), 'b.md')
    await writeFile(first)
    await writeFile(second)
    const access = createDocumentAccess({ workspaceRoot: () => workspace, recentPaths: () => [], maxGrants: 1 })

    access.grant(first)
    access.grant(second)
    expect(() => access.assert(first)).toThrow('document-path-not-allowed')
    expect(access.assert(second)).toBe(physicalPath(second))
  })
})
