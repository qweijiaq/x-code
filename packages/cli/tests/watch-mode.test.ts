import { afterEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AgentOptions, LanguageModel } from '@x-code-cli/core'

import { abortPrintMode } from '../src/print-signals.js'
import { runPrintMode } from '../src/print.js'
import { runWatchMode } from '../src/watch.js'

vi.mock('../src/print.js', () => ({ runPrintMode: vi.fn() }))
vi.mock('../src/print-signals.js', () => ({ abortPrintMode: vi.fn(() => false) }))

const printMock = vi.mocked(runPrintMode)
const abortMock = vi.mocked(abortPrintMode)

const directories: string[] = []
const cleanups: Array<() => void> = []

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-watch-mode-'))
  directories.push(dir)
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1\n')
  return dir
}

function watchDeps(cwd: string) {
  return {
    cwd,
    paths: [cwd],
    prompt: 'fix the files',
    debounceMs: 5,
    intervalMs: 10,
    model: {} as LanguageModel,
    options: {} as AgentOptions,
  }
}

function captureStdout(): { output: string[] } {
  const output: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  cleanups.push(() => spy.mockRestore())
  return { output }
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到谓词成立（或超时），避免用固定的 sleep 猜测轮询节奏。 */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await tick(5)
  expect(predicate()).toBe(true)
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  printMock.mockReset()
  abortMock.mockReset()
  abortMock.mockReturnValue(false)
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('runWatchMode', () => {
  it('folds the agent’s own edits into the baseline instead of re-triggering', async () => {
    const cwd = await workspace()
    const { output } = captureStdout()
    printMock.mockImplementation(async () => {
      // agent 在本轮里改了工作区文件——不折叠的话这会立刻触发下一轮。
      await fs.writeFile(path.join(cwd, 'b.ts'), 'export const b = 2\n')
      return 0
    })

    const run = runWatchMode(watchDeps(cwd))
    try {
      // 基线在启动时采集：等横幅出现再改文件，否则改动会被折叠进基线。
      await until(() => output.join('').includes('watching'))
      await fs.writeFile(path.join(cwd, 'a.ts'), 'export const a = 2\n')
      await until(() => output.join('').includes('folded into the baseline'))
      // 留出几轮轮询：agent 写的 b.ts 若仍被当作改动，这里会出现第二次运行。
      await tick(150)
      expect(printMock).toHaveBeenCalledTimes(1)
    } finally {
      process.emit('SIGINT', 'SIGINT')
      await run
    }
  })

  it('aborts the in-flight run on the first Ctrl+C and hard-exits on the second', async () => {
    const cwd = await workspace()
    const { output } = captureStdout()
    const exitMock = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    cleanups.push(() => exitMock.mockRestore())

    let finishRun: (() => void) | null = null
    printMock.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishRun = () => resolve(0)
        }),
    )

    const run = runWatchMode(watchDeps(cwd))
    try {
      await until(() => output.join('').includes('watching'))
      await fs.writeFile(path.join(cwd, 'a.ts'), 'export const a = 2\n')
      await until(() => printMock.mock.calls.length === 1)

      // 一轮可能持续数分钟，用户不该被锁在里面：第一次 Ctrl+C 中止当前轮，
      // 第二次直接退出。
      process.emit('SIGINT', 'SIGINT')
      process.emit('SIGINT', 'SIGINT')
      expect(abortMock).toHaveBeenCalledTimes(1)
      expect(exitMock).toHaveBeenCalledWith(130)
      expect(output.join('')).not.toContain('run exited')
    } finally {
      finishRun?.()
      await expect(run).resolves.toBe(0)
    }
  })
})
