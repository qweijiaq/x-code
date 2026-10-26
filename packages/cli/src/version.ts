// @x-code-cli/cli — CLI 版本号。
//
// 在构建期通过 esbuild 的 `define` 解析。全局 `__CLI_VERSION__` 由
// esbuild.config.js 从 package.json 注入，因此零运行时开销。对
// `tsx src/index.ts` 开发模式，回退为读取本地 package.json。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __CLI_VERSION__: string | undefined

function resolveVersion(): string {
  // 构建期 define 优先
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) {
    return __CLI_VERSION__
  }
  // 开发模式回退（tsx）：向上查找 package.json
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === '@x-code-cli/cli' && pkg.version) {
          return pkg.version
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 落到兜底
  }
  return '0.0.0-dev'
}

export const VERSION = resolveVersion()
