/**
 * pnpm 10 会阻止未经白名单允许的依赖构建脚本，因此 node-pty 的
 * 安装步骤不会给其预编译的 `spawn-helper` 设置可执行位。缺少可执行位时，
 * `pty.spawn()` 会在 macOS/Linux 上以 "posix_spawnp failed" 失败。
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function chmodIfPresent(file) {
  if (!existsSync(file)) return
  chmodSync(file, 0o755)
  console.log(`[desktop postinstall] chmod +x ${path.relative(root, file)}`)
}

if (process.platform !== 'win32') {
  const ptyRoot = path.join(root, 'node_modules/node-pty')
  const prebuilds = path.join(ptyRoot, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const target of readdirSync(prebuilds)) {
      chmodIfPresent(path.join(prebuilds, target, 'spawn-helper'))
    }
  }
  chmodIfPresent(path.join(ptyRoot, 'build/Release/spawn-helper'))
}
