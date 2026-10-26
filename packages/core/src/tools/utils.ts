// @x-code-cli/core — 各工具实现共享的小工具。
//
// 本目录里文件名对应某个工具的文件（glob.ts、grep.ts、shell.ts……）都恰好
// 定义一个工具。较大的共享基础设施有各自命名的模块（progress.ts 是进度
// 上报器注册表、shell-provider.ts 是跨平台 shell 分发、truncate.ts 是
// 工具结果大小上限）。这个文件专门放零散的小东西 —— 不止一个工具用到、
// 但又不足以单独开一个模块的单函数辅助。
//
// 保持克制：优先在这里加个小 helper，而不是在 tools/ 下再建一个
// 每个 helper 一个文件。
import { createRequire } from 'node:module'

// `@x-code-cli/core` 是 ESM 包（`"type": "module"`），运行时没有全局
// `require`。需要 `createRequire` 来加载仅 CJS 的模块，比如
// `@vscode/ripgrep` —— 它通过 `module.exports.rgPath` 暴露二进制路径
// （没有 ESM 构建可用）。
const _require = createRequire(import.meta.url)

/** 缓存的 ripgrep 二进制路径。首次使用时惰性解析，进程后续复用。 */
let _rgPath: string | null = null

/** 解析 `glob` 和 `grep` 工具使用的 ripgrep 二进制路径。优先用
 *  @vscode/ripgrep（每个平台都附带预编译二进制），失败则回退到 PATH 里的
 *  `rg`，这样即使包的 postinstall 失败，装了系统级 ripgrep 的开发机仍可用。 */
export function getRipgrepPath(): string {
  if (_rgPath) return _rgPath
  try {
    const rg = _require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    _rgPath = 'rg'
  }
  return _rgPath
}
