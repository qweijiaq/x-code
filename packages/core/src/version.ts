// @x-code-cli/core — 运行时解析的包版本。
//
// Core 通过 `tsc -b`（无打包器）构建，因此无法像 CLI 那样使用构建期定义。
// 我们改从 `import.meta.url` 向上查找最近的 `@x-code-cli/*` package.json 并
// 读取其 `version` 字段。
//
// 需要处理两种情况：
//
// 1. 开发/未打包——core 的编译产物位于 `<core>/dist/**/*.js`；向上查找会找到
//    `<core>/package.json`（name = `@x-code-cli/core`）。
// 2. 打包后的 CLI——CLI 用 esbuild 把 core 源码打成一个 `<cli>/dist/cli.js`。
//    `import.meta.url` 指向该包内，因此最近的 package.json 是
//    `<cli>/package.json`（name = `@x-code-cli/cli`）。
//
// `core` 和 `cli` 由 `scripts/release.mjs` 同步发布，因此两种匹配都能得到
// 正确版本。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK_VERSION = '0.0.0-dev'

function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if ((pkg.name === '@x-code-cli/core' || pkg.name === '@x-code-cli/cli') && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 直接落到兜底
  }
  return FALLBACK_VERSION
}

export const VERSION = resolveVersion()
