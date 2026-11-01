import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { saveDesktopSettings } from '../src/runtime/desktop-settings.js'
import { createStorageController } from '../src/runtime/storage-controller.js'

const OLD = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
const directories: string[] = []
let previousHome: string | undefined

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(dir)
  return dir
}

async function writeFile(filePath: string, content: string, mtime = new Date()): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
  await fs.utimes(filePath, mtime, mtime)
}

beforeEach(async () => {
  previousHome = process.env.X_CODE_HOME
  const home = await temporaryDirectory('xc-storage-home-')
  process.env.X_CODE_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = previousHome
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('storage controller', () => {
  it('reports the five storage categories with sizes', async () => {
    const workspace = await temporaryDirectory('xc-storage-workspace-')
    const sessions = path.join(workspace, '.x-code', 'sessions')
    await writeFile(path.join(sessions, 'a.jsonl'), '12345')
    const controller = createStorageController({
      workspace: () => workspace,
      isBusy: () => false,
      activeSessionPath: () => null,
    })

    const usage = await controller.usage()
    expect(usage.categories.map((category) => category.id)).toEqual([
      'sessions',
      'library',
      'attachments',
      'whisper',
      'logs',
    ])
    expect(usage.categories[0]?.bytes).toBe(5)
    expect(usage.totalBytes).toBe(5)
  })

  it('deletes old sessions and attachments but keeps active and pinned sessions', async () => {
    const workspace = await temporaryDirectory('xc-storage-workspace-')
    const home = process.env.X_CODE_HOME!
    const sessions = path.join(workspace, '.x-code', 'sessions')
    const oldSession = path.join(sessions, 'old.jsonl')
    const freshSession = path.join(sessions, 'fresh.jsonl')
    const pinnedSession = path.join(sessions, 'pinned.jsonl')
    const activeSession = path.join(sessions, 'active.jsonl')
    await writeFile(oldSession, 'old', OLD)
    await writeFile(freshSession, 'fresh')
    await writeFile(pinnedSession, 'pinned', OLD)
    await writeFile(activeSession, 'active', OLD)
    saveDesktopSettings({ pinnedSessions: [pinnedSession] })

    const oldAttachment = path.join(home, 'attachments', 'pasted-old.png')
    const freshAttachment = path.join(home, 'attachments', 'pasted-fresh.png')
    const unrelated = path.join(home, 'attachments', 'keep.txt')
    await writeFile(oldAttachment, 'old-image', OLD)
    await writeFile(freshAttachment, 'fresh-image')
    await writeFile(unrelated, 'keep', OLD)

    const controller = createStorageController({
      workspace: () => workspace,
      isBusy: () => false,
      activeSessionPath: () => activeSession,
    })

    const result = await controller.cleanup({ sessionsOlderThanDays: 1, attachmentsOlderThanDays: 1 })
    expect(result.deletedFiles).toBe(2)
    expect(result.freedBytes).toBe(3 + 9)

    await expect(fs.access(oldSession)).rejects.toThrow()
    await expect(fs.access(oldAttachment)).rejects.toThrow()
    for (const kept of [freshSession, pinnedSession, activeSession, freshAttachment, unrelated]) {
      await expect(fs.access(kept)).resolves.toBeUndefined()
    }
  })

  it('refuses to clean while a turn is running', async () => {
    const workspace = await temporaryDirectory('xc-storage-workspace-')
    const controller = createStorageController({
      workspace: () => workspace,
      isBusy: () => true,
      activeSessionPath: () => null,
    })
    await expect(controller.cleanup({ sessionsOlderThanDays: 1 })).rejects.toThrow('turn-busy')
  })
})
