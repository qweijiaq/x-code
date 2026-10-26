// tools/utils.ts 的回归测试
//
// 背景：之前的实现在一个 ESM 模块里直接使用 `require('@vscode/ripgrep')`。
// 运行时那会抛 `ReferenceError: require is not defined` —— 调用落入 catch
// 分支，静默回退到 `'rg'`，随后在未安装系统级 ripgrep 的机器上以
// `spawn rg ENOENT` 失败。现在 `tools/utils.ts` 使用
// `createRequire(import.meta.url)`，让 require 调用真正生效。
import { describe, expect, it } from 'vitest'

import fs from 'node:fs'
import path from 'node:path'

import { getRipgrepPath } from '../src/tools/utils.js'

describe('getRipgrepPath', () => {
  it('resolves to an existing absolute @vscode/ripgrep binary', () => {
    const p = getRipgrepPath()
    // 如果解析出的路径不存在，glob/grep 会在首次调用时把
    // `spawn ... ENOENT` 暴露给模型。这个测试是金丝雀：它同时捕获
    // ESM/CJS 回归（require 失败后我们静默回退）和
    // @vscode/ripgrep 安装损坏（require 成功但 postinstall 没有
    // 放置二进制文件）。
    expect(path.isAbsolute(p)).toBe(true)
    expect(fs.existsSync(p)).toBe(true)
  })
})
