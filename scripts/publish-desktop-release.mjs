#!/usr/bin/env node
/**
 * Publish the verified desktop release to GitHub.
 *
 * The release artifacts are produced by `pnpm release:desktop` and checked by
 * `pnpm verify:desktop-release`. This script creates the matching GitHub
 * release, uploads the artifacts, and publishes it. It uses the credential
 * already stored by Git (macOS Keychain, `gh auth setup-git`, or a credential
 * manager) and never prints the token.
 *
 * Usage:
 *   pnpm publish:desktop            # create/upload/publish v<package version>
 *   pnpm publish:desktop -- --draft # stop after upload, publish from GitHub
 *
 * Set HTTPS_PROXY if GitHub is only reachable through a proxy.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const draftOnly = process.argv.includes('--draft')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const releaseDir = path.join(root, 'packages/desktop/release')
const notesPath = path.join(root, 'docs/releases', `${tag}.md`)
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || ''

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function readRepo() {
  let remote = ''
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    fail('no git remote named origin')
  }
  const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote)
  if (!match) fail(`origin is not a GitHub repository: ${remote}`)
  return `${match[1]}/${match[2]}`
}

function releaseBody() {
  if (!fs.existsSync(notesPath)) fail(`missing release notes: ${path.relative(root, notesPath)}`)
  return fs
    .readFileSync(notesPath, 'utf8')
    .replace(
      '](../desktop-install-unsigned.en.md)',
      `](https://github.com/${repo}/blob/${tag}/docs/desktop-install-unsigned.en.md)`,
    )
    .replace('](../../CHANGELOG.md)', `](https://github.com/${repo}/blob/${tag}/CHANGELOG.md)`)
}

const repo = readRepo()
const tagCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', `${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    fail(`tag ${tag} does not exist; create it at the packaged commit first`)
  }
})()
const releaseJson = path.join(releaseDir, 'RELEASE.json')
if (!fs.existsSync(releaseJson)) fail('RELEASE.json missing; run pnpm release:desktop first')
const releaseInfo = JSON.parse(fs.readFileSync(releaseJson, 'utf8'))
if (releaseInfo.version !== version) fail(`RELEASE.json is ${releaseInfo.version}, package is ${version}`)
if (releaseInfo.commit !== tagCommit) {
  fail(`RELEASE.json commit ${releaseInfo.commit} does not match tag ${tag} (${tagCommit})`)
}

const assets = [
  `X-Code-${version}-arm64.dmg`,
  `X-Code-${version}-arm64.zip`,
  `X-Code-${version}-arm64.dmg.blockmap`,
  `X-Code-${version}-arm64.zip.blockmap`,
  'SHA256SUMS',
  'RELEASE.json',
  'latest-mac.yml',
].map((name) => path.join(releaseDir, name))
for (const file of assets) if (!fs.existsSync(file)) fail(`missing asset: ${path.relative(root, file)}`)

const credentials = (() => {
  try {
    return execFileSync('git', ['credential', 'fill'], {
      cwd: root,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } catch {
    fail('no GitHub credential available; sign in with `gh auth login` or run `git push` once')
  }
})()
const token = /^password=(.*)$/m.exec(credentials)?.[1]
if (!token) fail('Git credential helper returned no password/token')

const configPath = path.join(os.tmpdir(), `xcode-gh-curl-${process.pid}.cfg`)
const payloadPath = path.join(os.tmpdir(), `xcode-gh-release-${process.pid}.json`)
fs.writeFileSync(configPath, `header = "Authorization: Bearer ${token}"\n${proxy ? `proxy = "${proxy}"\n` : ''}`, {
  mode: 0o600,
})
process.on('exit', () => {
  fs.rmSync(configPath, { force: true })
  fs.rmSync(payloadPath, { force: true })
})

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function api(method, url, bodyPath, options = {}) {
  const isUpload = url.includes('uploads.github.com')
  const args = [
    '--config',
    configPath,
    isUpload ? '--progress-bar' : '--silent',
    '--show-error',
    '--fail-with-body',
    '--max-time',
    '1800',
  ]
  args.push('-X', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28')
  if (isUpload) {
    // HTTP/2 uploads intermittently reset behind proxies; HTTP/1.1 is slower
    // but reliable for 200 MB+ assets.
    args.push('--http1.1', '-H', 'Content-Type: application/octet-stream')
  }
  if (bodyPath) args.push('--data-binary', `@${bodyPath}`)
  args.push(url)
  const attempts = options.retries ?? 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(
      'curl',
      args,
      isUpload
        ? { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 10 * 1024 * 1024 }
        : { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    )
    if (result.status === 0) return result.stdout ? JSON.parse(result.stdout) : null
    const body = (result.stdout || '').trim()
    if (options.allow404 && /"status"\s*:\s*"404"/.test(body)) return null
    const detail = (body || result.stderr || '').trim().slice(0, 400)
    if (attempt < attempts) {
      console.log(`upload attempt ${attempt}/${attempts} failed (${detail}); retrying in 5s`)
      sleepSync(5_000)
      continue
    }
    fail(`${method} ${url} failed after ${attempts} attempt(s): ${detail}`)
  }
}

fs.writeFileSync(
  payloadPath,
  JSON.stringify({
    tag_name: tag,
    target_commitish: 'main',
    name: `X-Code ${version}`,
    body: releaseBody(),
    draft: true,
    prerelease: false,
  }),
)

const releases = api('GET', `https://api.github.com/repos/${repo}/releases?per_page=100`)
const existingRelease = releases.find((entry) => entry.tag_name === tag)
let release = null
if (existingRelease && !existingRelease.draft) {
  console.log(`release ${tag} is already published: ${existingRelease.html_url}`)
  process.exit(0)
}
if (existingRelease?.draft) {
  release = existingRelease
  console.log(`reusing draft release ${release.id}`)
} else {
  release = api('POST', `https://api.github.com/repos/${repo}/releases`, payloadPath)
  console.log(`created draft release ${release.id}`)
}

const uploaded = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))
for (const file of assets) {
  const name = path.basename(file)
  const size = fs.statSync(file).size
  const existing = uploaded.get(name)
  if (existing && existing.state === 'uploaded' && existing.size === size) {
    console.log(`skip ${name} (already uploaded)`)
    continue
  }
  if (existing) {
    console.log(`removing incomplete ${name} (state=${existing.state}, size=${existing.size})`)
    api('DELETE', `https://api.github.com/repos/${repo}/releases/assets/${existing.id}`)
  }
  console.log(`uploading ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  const asset = api(
    'POST',
    `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    file,
    { retries: 4 },
  )
  console.log(`uploaded ${asset.name} (${asset.size} bytes)`)
}

const finalRelease = api('GET', `https://api.github.com/repos/${repo}/releases/${release.id}`)
const finalAssets = new Map((finalRelease.assets ?? []).map((asset) => [asset.name, asset]))
for (const file of assets) {
  const name = path.basename(file)
  const asset = finalAssets.get(name)
  if (!asset || asset.size !== fs.statSync(file).size) {
    fail(`asset missing or incomplete after upload: ${name}`)
  }
}

if (draftOnly) {
  console.log(`draft ready: ${finalRelease.html_url}`)
  process.exit(0)
}

fs.writeFileSync(payloadPath, JSON.stringify({ draft: false, prerelease: false }))
const published = api('PATCH', `https://api.github.com/repos/${repo}/releases/${release.id}`, payloadPath)
console.log(`published: ${published.html_url}`)
