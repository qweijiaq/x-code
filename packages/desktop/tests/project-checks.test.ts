import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkCommandLabel, detectProjectChecks, runProjectChecks } from '../src/runtime/project-checks.js'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-checks-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function packageJson(scripts: Record<string, string>, name = 'fixture'): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts }))
}

describe('project checks detection', () => {
  it('detects Node scripts in a stable order', async () => {
    packageJson({
      build: 'node -e "0"',
      test: 'node -e "0"',
      lint: 'node -e "0"',
      typecheck: 'node -e "0"',
    })

    const checks = await detectProjectChecks(root)

    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'lint', 'test', 'build'])
    expect(checkCommandLabel(checks[0]!)).toContain('run typecheck')
  })

  it('falls back to tsc when only a tsconfig exists', async () => {
    packageJson({ test: 'node -e "0"' })
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')

    const checks = await detectProjectChecks(root)

    expect(checks[0]?.id).toBe('typecheck')
    expect(checkCommandLabel(checks[0]!)).toContain('tsc')
  })

  it('detects cargo checks', async () => {
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "fixture"\n')

    const checks = await detectProjectChecks(root)

    expect(checks.map((check) => check.id)).toEqual(['cargo-check', 'cargo-test'])
  })

  it('returns no checks for an empty folder', async () => {
    expect(await detectProjectChecks(root)).toEqual([])
  })
})

describe('project checks execution', () => {
  it('stops at the first failure and marks the rest skipped', async () => {
    packageJson({
      typecheck: 'node -e "process.exit(1)"',
      test: 'node -e "process.exit(0)"',
    })

    const results = await runProjectChecks(root)

    expect(results.map((result) => result.status)).toEqual(['failed', 'skipped'])
    expect(results[0]?.exitCode).toBe(1)
  })

  it('runs every check when stopOnFailure is false', async () => {
    packageJson({
      typecheck: 'node -e "console.error(\'boom\'); process.exit(1)"',
      test: 'node -e "process.exit(0)"',
    })

    const results = await runProjectChecks(root, { stopOnFailure: false })

    expect(results.map((result) => result.status)).toEqual(['failed', 'passed'])
    expect(results[0]?.output).toContain('boom')
  })
})
