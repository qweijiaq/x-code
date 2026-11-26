import { describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { restoreInvocationCwd } from '../src/launch-cwd.js'

describe('restoreInvocationCwd', () => {
  // 唯一的生产调用点是 `restoreInvocationCwd()`，走的是默认 chdir 参数。裸
  // `process.chdir` 解绑后调用会抛 `ERR_INVALID_THIS` 并被 catch 吞掉，返回
  // false——注入 mock 的用例永远测不到这条路径，所以这里用真实目录跑一遍。
  it('restores the process cwd when chdir is not injected', () => {
    const original = process.cwd()
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-launch-cwd-'))
    try {
      expect(restoreInvocationCwd(target)).toBe(true)
      expect(process.cwd()).toBe(fs.realpathSync(target))
    } finally {
      process.chdir(original)
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it('restores an absolute package-manager invocation directory', () => {
    const chdir = vi.fn()
    const invocationCwd = path.resolve('workspace')

    expect(restoreInvocationCwd(invocationCwd, chdir)).toBe(true)
    expect(chdir).toHaveBeenCalledWith(invocationCwd)
  })

  it('ignores missing and relative INIT_CWD values', () => {
    const chdir = vi.fn()

    expect(restoreInvocationCwd('', chdir)).toBe(false)
    expect(restoreInvocationCwd('relative/path', chdir)).toBe(false)
    expect(chdir).not.toHaveBeenCalled()
  })

  it('keeps the current directory when chdir fails', () => {
    const chdir = vi.fn(() => {
      throw new Error('missing directory')
    })

    expect(restoreInvocationCwd(path.resolve('missing'), chdir)).toBe(false)
  })
})
