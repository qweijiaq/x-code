// 会话级持久 shell 的回归测试。只覆盖 POSIX；Windows 仍走受管 shell。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  PersistentShell,
  PersistentShellBusyError,
  shouldUsePersistentShell,
} from '../src/tools/shell-session/persistent-shell.js'
import type { PreparedShellRequest } from '../src/tools/shell-session/types.js'

const shells: PersistentShell[] = []
const directories: string[] = []

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-persistent-shell-'))
  directories.push(dir)
  return dir
}

function shellAt(cwd: string): PersistentShell {
  const shell = new PersistentShell(cwd)
  shells.push(shell)
  return shell
}

afterEach(async () => {
  for (const shell of shells.splice(0)) shell.dispose()
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function prepared(command: string, overrides: Partial<PreparedShellRequest> = {}): PreparedShellRequest {
  return {
    command,
    effectiveCwd: process.cwd(),
    projectCwd: process.cwd(),
    initialWait: { kind: 'timed', ms: 10_000 },
    tty: false,
    maxOutputBytes: 20 * 1024 * 1024,
    hookInput: { command },
    ...overrides,
  }
}

describe.skipIf(process.platform === 'win32')('persistent shell', () => {
  it('keeps cwd and exported variables across commands', async () => {
    const dir = await workspace()
    await fs.mkdir(path.join(dir, 'sub'))
    const shell = shellAt(dir)

    const changed = await shell.run({ command: 'cd sub && export XCODE_PS=kept', cwd: dir })
    expect(changed.exitCode).toBe(0)
    expect(shell.currentCwd.endsWith('/sub')).toBe(true)

    const next = await shell.run({ command: 'pwd; printf "%s" "$XCODE_PS"' })
    expect(next.output).toContain('sub')
    expect(next.output).toContain('kept')
  })

  it('captures stderr and propagates a non-zero exit code', async () => {
    const dir = await workspace()
    const shell = shellAt(dir)

    const result = await shell.run({ command: 'echo boom >&2; exit 7' })

    expect(result.exitCode).toBe(7)
    expect(result.output).toContain('boom')
    expect(result.timedOut).toBe(false)
  })

  it('runs multiline heredocs in the persistent shell', async () => {
    const dir = await workspace()
    const shell = shellAt(dir)

    const result = await shell.run({
      command: `cat <<'EOF'\nline one\nline two\nEOF`,
      cwd: dir,
    })

    expect(result.output).toContain('line one')
    expect(result.output).toContain('line two')
  })

  it('times out, restarts, and accepts the next command', async () => {
    const dir = await workspace()
    const shell = shellAt(dir)
    const started = Date.now()

    const timedOut = await shell.run({ command: 'sleep 5', cwd: dir, timeoutMs: 200 })
    expect(timedOut.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(shell.busy).toBe(false)

    const next = await shell.run({ command: 'echo after-timeout' })
    expect(next.output).toContain('after-timeout')
  })

  it('rejects a second command while one is running', async () => {
    const dir = await workspace()
    const shell = shellAt(dir)

    const first = shell.run({ command: 'sleep 0.4', cwd: dir })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(shell.run({ command: 'echo nope' })).rejects.toBeInstanceOf(PersistentShellBusyError)
    await first
  })
})

describe('persistent shell routing', () => {
  it('uses the persistent shell for ordinary commands', () => {
    expect(shouldUsePersistentShell(prepared('pnpm test'))).toBe(true)
    expect(shouldUsePersistentShell(prepared('git status && git diff'))).toBe(true)
  })

  it('leaves servers, background commands, and TTY to the managed shell', () => {
    expect(shouldUsePersistentShell(prepared('pnpm dev'))).toBe(false)
    expect(shouldUsePersistentShell(prepared('npm run start:desktop'))).toBe(false)
    expect(shouldUsePersistentShell(prepared('vite'))).toBe(false)
    expect(shouldUsePersistentShell(prepared('npm test > log.txt &'))).toBe(false)
    expect(shouldUsePersistentShell(prepared('bash', { tty: true }))).toBe(false)
    expect(shouldUsePersistentShell(prepared('ls', { initialWait: { kind: 'immediate' } }))).toBe(false)
    expect(shouldUsePersistentShell(prepared('ls', { initialWait: { kind: 'timed', ms: 5_000 } }))).toBe(false)
  })
})
