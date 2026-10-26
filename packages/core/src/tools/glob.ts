// @x-code-cli/core — glob 工具（按模式搜索文件，底层走 ripgrep）
//
// 实际的文件遍历交给 ripgrep（`rg --files --glob ...`），而不是用 Node 的
// glob 库。三个原因：
//   1. ripgrep 已经是 `grep` 工具的依赖 —— 复用它能让跨工具的占用保持很小。
//   2. ripgrep 遍历超大目录树很快（Rust + 并行目录遍历），且默认尊重
//      .gitignore。
//   3. ripgrep 的 `--sortr=modified` 给我们确定性的最近优先排序 —— 这正是
//      结果被截断时模型所需要的：最相关的文件能在上限内存活。
//
// 这让 glob 的实际行为与它的描述字符串一致：之前描述承诺按 mtime 排序，
// 但实际解析到了库默认排序（经 globby 的字母序）。
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

const MAX_GLOB_RESULTS = 200
const RG_MAX_BUFFER = 4 * 1024 * 1024

export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns absolute file paths sorted by modification time, most recent first. ` +
    `Results are capped at ${MAX_GLOB_RESULTS} files — use a more specific pattern if truncated.`,
  inputSchema: z.object({
    pattern: z.string().min(1).max(4096).describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().max(4096).optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }, { toolCallId, abortSignal }) => {
    try {
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `Matching ${pattern}`)
      // ripgrep 标志：
      //   --files          — 列出文件而不是搜索内容
      //   --sortr=modified — 按 mtime 排序，最近优先
      //   --hidden         — 包含 .eslintrc / .prettierrc 之类的点文件
      //   --glob '!.git'   — 显式排除 git 元数据目录。
      //                      .gitignore 通常不会列出 .git/（git 内部自己管理
      //                      它），所以没有这个标志的话，`--hidden` 会愉快地
      //                      走进 .git/objects，把成千上万个内部哈希文件翻出来。
      //   --glob <pattern> — 用户的 glob 过滤器（相对搜索目录）
      //
      // 有两个模式需要特殊处理，因为它们和 ripgrep 白名单式的 --glob 语义
      // 冲突得厉害：
      //
      //   • 通配全部的模式（"**/*"、"**"、"*"）会被丢弃：`--glob "**/*"` 会被
      //     读成一个显式白名单，覆盖掉 .gitignore，于是结果里包含
      //     node_modules / dist / 等等 —— 通常是成千上万条纯噪音文件。
      //     我们整个丢弃用户的 --glob，让 ripgrep 默认的文件遍历生效
      //     （它尊重 .gitignore）。
      const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
      const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']
      if (!isCatchAll) {
        args.push('--glob', pattern)
      }
      const { stdout } = await execFileAsync(getRipgrepPath(), args, {
        cwd: searchDir,
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
        signal: abortSignal,
        windowsHide: true,
      })
      const out = stdout.trim()
      if (!out) return 'No files found matching the pattern.'
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${absolutes.length - MAX_GLOB_RESULTS} more files not shown — ${absolutes.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      // 没有文件匹配时 ripgrep 以退出码 1 结束 —— 把它当作空结果呈现而不是
      // 错误，这样模型会把“无匹配”当成正常结果，而不是需要重试的工具失败。
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No files found matching the pattern.'
      }
      return formatToolError('searching files', err)
    }
  },
})
