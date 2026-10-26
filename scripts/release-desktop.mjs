#!/usr/bin/env node
/**
 * 本地桌面发布：构建、打包（dmg + zip），然后在产物旁写入
 * SHA256SUMS 和 RELEASE.json。
 *
 * 当标准 electron-builder 环境变量存在时，会自动进行签名/公证：
 *   CSC_LINK / CSC_NAME、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID
 * 没有这些变量时，构建会有意地不签名、不公证。
 *
 * 用法：node scripts/release-desktop.mjs [--arch arm64|x64] [--skip-build]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const desktopDir = path.join(root, 'packages/desktop')
const releaseDir = path.join(desktopDir, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf-8'))

const args = process.argv.slice(2)
const archIndex = args.indexOf('--arch')
const arch = archIndex >= 0 ? args[archIndex + 1] : process.arch === 'arm64' ? 'arm64' : 'x64'
const skipBuild = args.includes('--skip-build')
const notarizeWithAppleId = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
)
const notarizeWithApiKey = Boolean(
  process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER,
)
const notarize = notarizeWithAppleId || notarizeWithApiKey
const signing = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  execFileSync(command, commandArgs, {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...(options.env ?? {}) },
  })
}

if (process.platform !== 'darwin') {
  console.error('release-desktop.mjs currently packages macOS builds. Run it on macOS.')
  process.exit(1)
}

if (!skipBuild) {
  run('pnpm', ['--filter', '@x-code-cli/desktop', 'build'])
}

// 打包多语言 Whisper 模型，让首次运行的语音输入可离线工作。
// X_CODE_SKIP_BUNDLED_WHISPER=1 可退出打包（安装包更小，使用时再下载）。
run('node', ['scripts/fetch-whisper-model.mjs'])

const builderArgs = [
  '--filter',
  '@x-code-cli/desktop',
  'exec',
  'electron-builder',
  '--mac',
  'dmg',
  'zip',
  `--${arch}`,
  '--publish',
  'never',
]
if (notarize) builderArgs.push('-c.mac.notarize=true')

run('pnpm', builderArgs, {
  env: { CSC_IDENTITY_AUTO_DISCOVERY: signing ? 'true' : 'false' },
})

const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const artifactPattern = new RegExp(`^X-Code-${escapedVersion}-.*\\.(dmg|zip|blockmap)$`)
const files = fs.existsSync(releaseDir)
  ? fs
      .readdirSync(releaseDir)
      .filter((file) => artifactPattern.test(file))
      .map((file) => path.join(releaseDir, file))
      .filter((file) => fs.statSync(file).isFile())
  : []

if (files.length === 0) {
  console.error(`No desktop artifacts found in ${releaseDir}`)
  process.exit(1)
}

const artifacts = files.map((file) => {
  const data = fs.readFileSync(file)
  return {
    file: path.basename(file),
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
})

// electron-builder 仅在发布时才写 latest-mac.yml；这里自行生成相同格式的
// feed，让手动和自动更新检查都能使用它。
const zipArtifact = artifacts.find((entry) => entry.file.endsWith('.zip') && !entry.file.endsWith('.blockmap'))
if (!zipArtifact) {
  console.error('No zip artifact found; latest-mac.yml cannot be generated.')
  process.exit(1)
}
const zipPath = path.join(releaseDir, zipArtifact.file)
const zipSha512 = createHash('sha512').update(fs.readFileSync(zipPath)).digest('base64')
const releaseDate = new Date().toISOString()
const feed = [
  `version: ${pkg.version}`,
  'files:',
  `  - url: ${zipArtifact.file}`,
  `    sha512: ${zipSha512}`,
  `    size: ${zipArtifact.size}`,
  `path: ${zipArtifact.file}`,
  `sha512: ${zipSha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n')
fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), feed)
const feedData = fs.readFileSync(path.join(releaseDir, 'latest-mac.yml'))
artifacts.push({
  file: 'latest-mac.yml',
  size: feedData.length,
  sha256: createHash('sha256').update(feedData).digest('hex'),
})

const sums = artifacts.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n') + '\n'
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), sums)

let commit = ''
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim()
} catch {
  // 不是 Git 检出目录。
}

const releaseInfo = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  commit,
  platform: 'darwin',
  arch,
  signed: signing,
  notarized: notarize,
  artifacts,
}
fs.writeFileSync(path.join(releaseDir, 'RELEASE.json'), JSON.stringify(releaseInfo, null, 2) + '\n')

console.log(`\nDesktop release v${pkg.version} (${arch})`)
console.log(`  signed=${signing} notarized=${notarize}`)
for (const entry of artifacts) {
  console.log(`  ${entry.file}  ${(entry.size / 1024 / 1024).toFixed(1)} MB  ${entry.sha256.slice(0, 12)}…`)
}
console.log(`\nArtifacts: ${releaseDir}`)
