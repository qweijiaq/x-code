import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { loadDesktopSettings } from '../src/runtime/desktop-settings.js'

const execFileAsync = promisify(execFile)

let home = ''

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-desktop-settings-lock-'))
  process.env.X_CODE_HOME = home
})

afterAll(() => {
  delete process.env.X_CODE_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

async function saveInChild(field: string): Promise<void> {
  const script = `
    import { saveDesktopSettings } from './packages/desktop/src/runtime/desktop-settings.ts'
    saveDesktopSettings(${field})
  `
  await execFileAsync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, X_CODE_HOME: home },
    timeout: 30_000,
  })
}

describe('desktop settings cross-process lock', () => {
  it('preserves both fields when two windows save at the same time', async () => {
    // 两个独立进程模拟两个 utilityProcess 同时 read-modify-write。
    // 没有 flock 时，后写会覆盖前写；有锁时两个字段都会保留。
    await Promise.all([saveInChild('{ notifications: false }'), saveInChild('{ onboarded: true }')])

    const settings = loadDesktopSettings()
    expect(settings.notifications).toBe(false)
    expect(settings.onboarded).toBe(true)
  })
})
