/**
 * pnpm 10 blocks dependency build scripts unless allowlisted, so node-pty's
 * install step never chmods its prebuilt `spawn-helper`. Without the execute
 * bit, `pty.spawn()` fails with "posix_spawnp failed" on macOS/Linux.
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
