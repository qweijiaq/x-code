import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cli = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8'))
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const expected = process.argv[2]

if (cli.version !== core.version) {
  console.error(`Package versions differ: cli=${cli.version}, core=${core.version}`)
  process.exit(1)
}
if (expected && expected !== cli.version && expected !== `v${cli.version}`) {
  console.error(`Release tag/version mismatch: expected v${cli.version}, got ${expected}`)
  process.exit(1)
}

console.log(`Release version OK: v${cli.version} (${cli.name}, ${core.name})`)
