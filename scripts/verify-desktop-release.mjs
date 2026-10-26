#!/usr/bin/env node
/**
 * 在发布之前校验打包好的桌面发布版。
 *
 * 检查 RELEASE.json/SHA256SUMS、latest-mac.yml feed、dmg/zip 完整性、
 * 代码签名和公证，然后在无头 smoke 模式下启动打包应用。对于有意不签名的
 * 构建，签名检查会报告为 NOT EXECUTED，除非传入 --require-signed。
 *
 * 用法：
 *   node scripts/verify-desktop-release.mjs [--allow-dirty] [--require-signed]
 *                                          [--skip-smoke] [--ui] [--e2e]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const desktopDir = path.join(root, 'packages/desktop')
const releaseDir = path.join(desktopDir, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf-8'))
const args = process.argv.slice(2)
const allowDirty = args.includes('--allow-dirty')
const requireSigned = args.includes('--require-signed')
const skipSmoke = args.includes('--skip-smoke')
const runUiSmoke = args.includes('--ui')
const runE2e = args.includes('--e2e')

const results = []
const hashCache = new Map()

function record(name, status, detail = '') {
  results.push({ name, status, detail })
  console.log(`${status.padEnd(13)} ${name}${detail ? ` — ${detail}` : ''}`)
}

function passed(name, detail) {
  record(name, 'PASSED', detail)
}

function failed(name, detail) {
  record(name, 'FAILED', detail)
}

function skipped(name, detail) {
  record(name, 'NOT EXECUTED', detail)
}

function check(name, fn) {
  try {
    const detail = fn()
    passed(name, detail)
    return true
  } catch (error) {
    failed(name, error instanceof Error ? error.message : String(error))
    return false
  }
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: 'utf-8',
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeout,
    env: { ...process.env, ...(options.env ?? {}) },
  })
}

/** 有些工具（如 codesign）成功时会把有用输出打印到 stderr。 */
function runCombined(command, commandArgs, timeout) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf-8',
    timeout,
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function lastLines(error, count = 8) {
  const text = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n').trim()
  return text.split('\n').slice(-count).join(' | ')
}

/** Electron smoke 的首次启动可能因临时的窗口/PTY 初始化而失败；
 *  用捕获到的输出重试一次，让发布门禁保持确定性。 */
function runAppSmoke(binary, smokeArgs, timeout, env) {
  let firstError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const output = run(binary, smokeArgs, { timeout, env })
      return { output, retried: attempt > 1 }
    } catch (error) {
      if (attempt === 1) {
        firstError = error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
      } else {
        throw new Error(`attempt 1: ${lastLines(firstError)}; attempt 2: ${lastLines(error)}`)
      }
    }
  }
  throw new Error(lastLines(firstError))
}

function hash(file, algorithm, encoding = 'hex') {
  const key = `${algorithm}:${encoding}:${file}`
  const cached = hashCache.get(key)
  if (cached) return cached
  const value = createHash(algorithm).update(fs.readFileSync(file)).digest(encoding)
  hashCache.set(key, value)
  return value
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function findPackagedApp() {
  const dirs = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : []
  for (const dir of dirs) {
    if (!dir.startsWith('mac-')) continue
    const candidate = path.join(releaseDir, dir, 'X-Code.app')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function findAppBinary(appPath) {
  const macosDir = path.join(appPath, 'Contents', 'MacOS')
  if (!fs.existsSync(macosDir)) return null
  const direct = path.join(macosDir, 'X-Code')
  if (fs.existsSync(direct)) return direct
  const entries = fs.readdirSync(macosDir)
  return entries.length > 0 ? path.join(macosDir, entries[0]) : null
}

function feedField(text, field) {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

function feedFileField(text, field) {
  const match = text.match(new RegExp(`^\\s*-?\\s*${field}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

console.log(`Desktop release verification — v${pkg.version}\n`)

if (!fs.existsSync(releaseDir)) {
  console.error(`Release directory not found: ${releaseDir}`)
  process.exit(1)
}

let release = null
let zipName
let dmgName
check('RELEASE.json is readable', () => {
  release = readJson(path.join(releaseDir, 'RELEASE.json'))
  return `version=${release.version} arch=${release.arch} signed=${release.signed} notarized=${release.notarized}`
})

if (release) {
  check('Version matches package.json', () => {
    if (release.version !== pkg.version) throw new Error(`RELEASE.json=${release.version} package.json=${pkg.version}`)
    return pkg.version
  })

  check('Commit matches HEAD', () => {
    const head = run('git', ['rev-parse', 'HEAD']).trim()
    if (release.commit !== head) throw new Error(`RELEASE.json=${release.commit.slice(0, 7)} HEAD=${head.slice(0, 7)}`)
    return head.slice(0, 7)
  })

  check('Working tree is clean', () => {
    const dirty = run('git', ['status', '--porcelain']).trim()
    if (dirty && !allowDirty) throw new Error(`uncommitted changes: ${dirty.split('\n')[0]}`)
    return dirty
      ? `uncommitted changes present; allowed by --allow-dirty (${dirty.split('\n').length} file(s))`
      : 'clean'
  })

  check('Release artifacts exist and match metadata', () => {
    if (!Array.isArray(release.artifacts) || release.artifacts.length === 0) throw new Error('no artifacts listed')
    for (const artifact of release.artifacts) {
      const file = path.join(releaseDir, artifact.file)
      if (!fs.existsSync(file)) throw new Error(`missing ${artifact.file}`)
      const size = fs.statSync(file).size
      if (size !== artifact.size) throw new Error(`${artifact.file} size ${size} != ${artifact.size}`)
      const digest = hash(file, 'sha256')
      if (digest !== artifact.sha256) throw new Error(`${artifact.file} sha256 mismatch`)
    }
    return `${release.artifacts.length} artifact(s) verified`
  })

  check('SHA256SUMS matches artifacts', () => {
    const sumsPath = path.join(releaseDir, 'SHA256SUMS')
    if (!fs.existsSync(sumsPath)) throw new Error('SHA256SUMS missing')
    const lines = fs
      .readFileSync(sumsPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const listed = new Map()
    for (const line of lines) {
      const match = line.match(/^([0-9a-f]{64})\s+(.+)$/)
      if (!match) throw new Error(`malformed line: ${line}`)
      listed.set(match[2], match[1])
    }
    for (const entry of lines) {
      const match = entry.match(/^([0-9a-f]{64})\s+(.+)$/)
      const file = path.join(releaseDir, match[2])
      if (!fs.existsSync(file)) throw new Error(`missing ${match[2]}`)
      if (hash(file, 'sha256') !== match[1]) throw new Error(`${match[2]} sha256 mismatch`)
    }
    for (const artifact of release.artifacts) {
      if (!listed.has(artifact.file)) throw new Error(`${artifact.file} missing from SHA256SUMS`)
    }
    return `${listed.size} file(s) verified`
  })

  zipName = release.artifacts.find((entry) => entry.file.endsWith('.zip') && !entry.file.endsWith('.blockmap'))?.file
  dmgName = release.artifacts.find((entry) => entry.file.endsWith('.dmg'))?.file
  check('dmg and zip are present', () => {
    if (!dmgName) throw new Error('dmg artifact missing')
    if (!zipName) throw new Error('zip artifact missing')
    return `${dmgName}, ${zipName}`
  })

  check('latest-mac.yml matches the zip feed', () => {
    const feedPath = path.join(releaseDir, 'latest-mac.yml')
    if (!fs.existsSync(feedPath)) throw new Error('latest-mac.yml missing')
    const feed = fs.readFileSync(feedPath, 'utf-8')
    const version = feedField(feed, 'version')
    const feedPathValue = feedField(feed, 'path')
    const feedSha512 = feedField(feed, 'sha512')
    const fileUrl = feedFileField(feed, 'url')
    const fileSize = Number(feedFileField(feed, 'size'))
    if (version !== release.version) throw new Error(`feed version ${version} != ${release.version}`)
    if (feedPathValue !== zipName) throw new Error(`feed path ${feedPathValue} != ${zipName}`)
    if (fileUrl !== zipName) throw new Error(`feed url ${fileUrl} != ${zipName}`)
    const zipPath = path.join(releaseDir, zipName)
    const sha512 = hash(zipPath, 'sha512', 'base64')
    if (feedSha512 !== sha512) throw new Error('feed sha512 mismatch')
    if (fileSize !== fs.statSync(zipPath).size) throw new Error('feed size mismatch')
    return `version=${version} file=${zipName}`
  })
}

if (process.platform !== 'darwin') {
  skipped('dmg integrity (hdiutil verify)', 'not macOS')
} else {
  check('dmg integrity (hdiutil verify)', () => {
    if (!dmgName) throw new Error('dmg artifact missing')
    run('hdiutil', ['verify', path.join(releaseDir, dmgName)], { timeout: 120_000 })
    return dmgName
  })
}

check('zip integrity (unzip -t)', () => {
  if (!zipName) throw new Error('zip artifact missing')
  run('unzip', ['-tq', path.join(releaseDir, zipName)], { timeout: 120_000 })
  return zipName
})

const appPath = findPackagedApp()
if (!appPath) {
  skipped('Bundle signature integrity', 'packaged .app not found')
  skipped('Developer ID signing', 'packaged .app not found')
  skipped('Gatekeeper assessment', 'packaged .app not found')
} else {
  const signed = release?.signed === true
  check('Bundle signature integrity', () => {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { timeout: 60_000 })
    const info = runCombined('codesign', ['-dv', '--verbose=4', appPath], 60_000)
    return /Signature=adhoc/.test(info) ? 'valid ad-hoc signature' : 'valid Developer ID signature'
  })

  if (!signed) {
    const detail = requireSigned
      ? 'RELEASE.json says signed=false and --require-signed was passed'
      : 'RELEASE.json says signed=false; ad-hoc community build'
    if (requireSigned) failed('Developer ID signing', detail)
    else skipped('Developer ID signing', detail)
  } else {
    check('Developer ID signing', () => {
      const info = runCombined('codesign', ['-dv', '--verbose=4', appPath], 60_000)
      const authority = info.match(/^Authority=(.+)$/m)?.[1]?.trim()
      const team = info.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
      return [authority, team ? `team ${team}` : ''].filter(Boolean).join(', ') || 'valid signature'
    })
  }

  if (process.platform === 'darwin') {
    if (!signed && !requireSigned) {
      skipped('Gatekeeper assessment', 'unsigned build (expected)')
    } else {
      check('Gatekeeper assessment', () => {
        run('spctl', ['--assess', '--type', 'execute', appPath], { timeout: 60_000 })
        return 'accepted'
      })
    }
  } else {
    skipped('Gatekeeper assessment', 'not macOS')
  }
}

if (release) {
  if (!release.notarized) {
    if (requireSigned) failed('Notarization ticket', 'RELEASE.json says notarized=false')
    else skipped('Notarization ticket', 'RELEASE.json says notarized=false; unsigned builds cannot notarize')
  } else if (dmgName) {
    check('Notarization ticket', () => {
      run('xcrun', ['stapler', 'validate', path.join(releaseDir, dmgName)], { timeout: 120_000 })
      return dmgName
    })
  }
}

if (skipSmoke) {
  skipped('Packaged app headless smoke', 'skipped by --skip-smoke')
  if (runUiSmoke) skipped('Packaged app UI smoke', 'skipped by --skip-smoke')
} else if (appPath && process.platform === 'darwin') {
  const binary = findAppBinary(appPath)
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-release-smoke-'))
  try {
    if (!binary) {
      failed('Packaged app headless smoke', 'app executable not found')
    } else {
      check('Packaged app headless smoke', () => {
        const result = runAppSmoke(binary, ['--smoke-test'], 240_000, { X_CODE_HOME: smokeHome })
        const line = result.output.split('\n').find((entry) => entry.startsWith('SMOKE_RESULT '))
        if (!line) throw new Error('SMOKE_RESULT missing')
        const report = JSON.parse(line.slice('SMOKE_RESULT '.length))
        if (report.ok !== true) throw new Error('smoke reported ok=false')
        return `SMOKE_RESULT ok=true${result.retried ? ' (passed on retry)' : ''}`
      })
    }
    if (runUiSmoke) {
      check('Packaged app UI smoke', () => {
        const result = runAppSmoke(binary, ['--ui-smoke'], 300_000, { X_CODE_HOME: smokeHome })
        const line = result.output.split('\n').find((entry) => entry.startsWith('UI_SMOKE_RESULT '))
        if (!line) throw new Error('UI_SMOKE_RESULT missing')
        const report = JSON.parse(line.slice('UI_SMOKE_RESULT '.length))
        if (report.ok !== true)
          throw new Error(`ui smoke reported ok=false (${Object.keys(report.checks ?? {}).length} checks)`)
        return `${Object.keys(report.checks ?? {}).length} checks passed${result.retried ? ' (passed on retry)' : ''}`
      })
    } else {
      skipped('Packaged app UI smoke', 'pass --ui to run it')
    }
  } finally {
    fs.rmSync(smokeHome, { recursive: true, force: true })
  }
} else {
  skipped(
    'Packaged app headless smoke',
    process.platform === 'darwin' ? 'packaged .app not found' : 'packaged macOS app can only run on macOS',
  )
}

if (runE2e) {
  check('Real-LLM E2E', () => {
    run('pnpm', ['test:e2e'], { timeout: 30 * 60_000, stdio: 'inherit' })
    return 'pnpm test:e2e'
  })
} else {
  skipped('Real-LLM E2E', 'not run by default; use --e2e with provider credentials and accept token cost')
}

const credentialNames = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'ALIBABA_API_KEY',
  'XAI_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
].filter((name) => Boolean(process.env[name]))
skipped(
  'Provider credentials for E2E',
  credentialNames.length > 0
    ? `${credentialNames.join(', ')} present (values not read)`
    : 'no provider key in the environment',
)

let remote = ''
try {
  remote = run('git', ['remote', '-v']).trim()
} catch {
  remote = ''
}
skipped(
  'Published CI artifacts',
  remote
    ? 'git remote configured; verify the CI run separately'
    : 'no git remote configured; commit is not pushed and CI has not run',
)

const failedCount = results.filter((entry) => entry.status === 'FAILED').length
const passedCount = results.filter((entry) => entry.status === 'PASSED').length
const skippedCount = results.filter((entry) => entry.status === 'NOT EXECUTED').length
const productionReady =
  failedCount === 0 &&
  release?.signed === true &&
  release?.notarized === true &&
  results.some((entry) => entry.name === 'Real-LLM E2E' && entry.status === 'PASSED')

console.log(`\nSummary: ${passedCount} passed, ${failedCount} failed, ${skippedCount} not executed`)
console.log(`Production signed/notarized release: ${productionReady ? 'PASSED' : 'NOT READY'}`)
process.exit(failedCount > 0 ? 1 : 0)
