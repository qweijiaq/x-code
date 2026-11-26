// @x-code-cli/cli — CLI 版本号。
//
// 在构建期通过 esbuild 的 `define` 解析。全局 `__CLI_VERSION__` 由
// esbuild.config.js 从 package.json 注入，因此零运行时开销。对
// `tsx src/index.ts` 开发模式，回退为读取本地 package.json。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __CLI_VERSION__: string | undefined

/** packages/cli 的候选包名。包再次改名时同步维护这里。 */
const CLI_PACKAGE_NAMES: ReadonlySet<string> = new Set(['@qweijiaq/x-code-cli', '@x-code-cli/cli'])
/** 向上查找 package.json 的最大层级：`dist/` 或 `src/` → 包根 → workspace 根 →
 *  仓库根，再往上就不属于本仓库了。 */
const MAX_PACKAGE_WALK_LEVELS = 8

function resolveVersion(): string {
  // 构建期 define 优先
  if (typeof __CLI_VERSION__ === 'string' && __CLI_VERSION__) {
    return __CLI_VERSION__
  }
  // 开发模式回退（tsx）：向上查找 package.json
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < MAX_PACKAGE_WALK_LEVELS; i++) {
      // 直接读并捕获异常，不用 `existsSync` + `readFileSync` 的两次 stat：
      // 中间被删掉时会抛，这一层当作「没有」继续向上。
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      } catch {
        raw = undefined
      }
      if (raw !== null && typeof raw === 'object') {
        const pkg = raw as { name?: unknown; version?: unknown }
        // `version` 必须真的是非空字符串：package.json 里写成数字/对象时，把它当
        // string 返回会破坏 `VERSION` 的类型契约，下游的版本比较与 `--version`
        // 打印都会出现难以定位的异常。
        if (
          typeof pkg.name === 'string' &&
          CLI_PACKAGE_NAMES.has(pkg.name) &&
          typeof pkg.version === 'string' &&
          pkg.version !== ''
        ) {
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
