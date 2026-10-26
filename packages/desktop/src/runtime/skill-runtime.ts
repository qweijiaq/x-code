// Isolated per-skill dependency runtime.
//
// Skills are instructions plus optional scripts/manifests. Historically the
// model ran `pip install` / `npm install` from the project cwd, which dropped
// venvs and node_modules into the user's repository. This module gives every
// skill a stable directory under `~/.x-code/skill-runtime/<slug>-<hash>` and
// installs dependencies there on explicit user request.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { userXcodeDir } from '@x-code-cli/core'

import type { SkillRuntimeView } from '../shared/protocol.js'

const execFileAsync = promisify(execFile)
const INSTALL_TIMEOUT_MS = 10 * 60_000
const MAX_BUFFER = 20 * 1024 * 1024

export interface SkillManifest {
  file: string
  kind: 'python' | 'node' | 'other'
}

interface RuntimeMeta {
  installedAt: number
  manifests: Record<string, number>
  python?: boolean
  node?: boolean
  lastError?: string
}

const MANIFESTS: Array<{ file: string; kind: SkillManifest['kind'] }> = [
  { file: 'requirements.txt', kind: 'python' },
  { file: 'pyproject.toml', kind: 'python' },
  { file: 'package.json', kind: 'node' },
  { file: 'Gemfile', kind: 'other' },
  { file: 'go.mod', kind: 'other' },
  { file: 'Cargo.toml', kind: 'other' },
]

export interface SkillRuntimeTarget {
  name: string
  dir: string
}

function slug(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  )
}

function runtimeRoot(): string {
  return path.join(userXcodeDir(), 'skill-runtime')
}

export function skillRuntimeDir(skill: SkillRuntimeTarget): string {
  const digest = createHash('sha1').update(path.resolve(skill.dir)).digest('hex').slice(0, 8)
  return path.join(runtimeRoot(), `${slug(skill.name)}-${digest}`)
}

export function detectSkillManifests(skillDir: string): SkillManifest[] {
  const found: SkillManifest[] = []
  for (const manifest of MANIFESTS) {
    try {
      if (fs.statSync(path.join(skillDir, manifest.file)).isFile()) found.push(manifest)
    } catch {
      // Not present.
    }
  }
  return found
}

function metaPath(dir: string): string {
  return path.join(dir, 'runtime.json')
}

function readMeta(dir: string): RuntimeMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')) as RuntimeMeta
    if (parsed && typeof parsed === 'object' && typeof parsed.installedAt === 'number') return parsed
  } catch {
    // No or malformed metadata.
  }
  return null
}

function writeMeta(dir: string, meta: RuntimeMeta): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

function manifestMtimes(skillDir: string, manifests: SkillManifest[]): Record<string, number> {
  const times: Record<string, number> = {}
  for (const manifest of manifests) {
    try {
      times[manifest.file] = fs.statSync(path.join(skillDir, manifest.file)).mtimeMs
    } catch {
      // Vanished.
    }
  }
  return times
}

function hasLegacyRuntime(skillDir: string): boolean {
  return ['runtime', '.runtime', 'venv', '.venv'].some((name) => {
    try {
      return fs.statSync(path.join(skillDir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

export function skillRuntimeView(skill: SkillRuntimeTarget): SkillRuntimeView {
  const dir = skillRuntimeDir(skill)
  const manifests = detectSkillManifests(skill.dir)
  const legacy = hasLegacyRuntime(skill.dir)
  const meta = readMeta(dir)
  const files = manifests.map((manifest) => manifest.file)
  if (manifests.length === 0) {
    return { dir, status: 'none', manifests: files, legacy }
  }
  if (manifests.some((manifest) => manifest.kind === 'other')) {
    return {
      dir,
      status: 'unsupported',
      manifests: files,
      legacy,
      message: '当前只支持 Python 和 Node 依赖清单',
    }
  }
  if (!meta) return { dir, status: 'none', manifests: files, legacy }
  if (meta.lastError) return { dir, status: 'error', manifests: files, legacy, message: meta.lastError }
  const mtimes = manifestMtimes(skill.dir, manifests)
  const stale = Object.entries(mtimes).some(([file, mtime]) => (meta.manifests[file] ?? 0) < mtime)
  return {
    dir,
    status: stale ? 'stale' : 'ready',
    manifests: files,
    legacy,
    ...(stale ? { message: '依赖清单已变化，请重新安装' } : {}),
  }
}

function venvPython(dir: string): string {
  return process.platform === 'win32'
    ? path.join(dir, 'venv', 'Scripts', 'python.exe')
    : path.join(dir, 'venv', 'bin', 'python')
}

function nodeModulesDir(dir: string): string {
  return path.join(dir, 'node', 'node_modules')
}

/** Activation text appended to SKILL.md. Keeps the model from installing
 *  dependencies in the project workspace. */
export function skillRuntimeHint(skill: SkillRuntimeTarget): string {
  const view = skillRuntimeView(skill)
  const lines = [
    '## Isolated skill runtime',
    `Runtime directory: ${view.dir}`,
    'Install or run skill dependencies only in this runtime directory, never in the project workspace.',
  ]
  if (view.manifests.length > 0) {
    lines.push(`Detected manifests: ${view.manifests.join(', ')}`)
    if (view.manifests.some((file) => file === 'requirements.txt' || file === 'pyproject.toml')) {
      lines.push(`Python interpreter: ${venvPython(view.dir)}`)
    }
    if (view.manifests.includes('package.json')) {
      lines.push(
        `Node modules: ${nodeModulesDir(view.dir)} (prepend ${path.join(view.dir, 'node', 'node_modules', '.bin')} to PATH)`,
      )
    }
    if (view.status === 'ready') lines.push('Dependency status: installed.')
    else lines.push('Dependency status: not installed/stale — ask the user to install it in Settings → Skills first.')
  }
  if (view.legacy) {
    lines.push(
      'Legacy dependency files exist inside the skill directory; do not add more. Prefer the runtime directory above.',
    )
  }
  return lines.join('\n')
}

function installEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      env: installEnv(),
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${command} ${args.join(' ')} failed: ${message.slice(0, 500)}`)
  }
}

/** Install declared dependencies into the isolated runtime directory. */
export async function installSkillRuntime(skill: SkillRuntimeTarget): Promise<SkillRuntimeView> {
  const view = skillRuntimeView(skill)
  if (view.manifests.length === 0)
    throw new Error('该技能没有可识别的依赖清单（requirements.txt / pyproject.toml / package.json）')
  if (view.status === 'unsupported') throw new Error(view.message ?? '不支持的依赖类型')
  const dir = view.dir
  fs.mkdirSync(dir, { recursive: true })
  const manifests = detectSkillManifests(skill.dir)
  const mtimes = manifestMtimes(skill.dir, manifests)
  let python = false
  let node = false
  try {
    if (manifests.some((manifest) => manifest.kind === 'python')) {
      const pythonExe = venvPython(dir)
      if (!fs.existsSync(pythonExe)) {
        await run(process.env.PYTHON?.trim() || 'python3', ['-m', 'venv', path.join(dir, 'venv')], dir)
      }
      if (manifests.some((manifest) => manifest.file === 'requirements.txt')) {
        await run(pythonExe, ['-m', 'pip', 'install', '-r', path.join(skill.dir, 'requirements.txt')], dir)
      } else {
        await run(pythonExe, ['-m', 'pip', 'install', skill.dir], dir)
      }
      python = true
    }
    if (manifests.some((manifest) => manifest.kind === 'node')) {
      const nodeDir = path.join(dir, 'node')
      fs.mkdirSync(nodeDir, { recursive: true })
      for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
        const source = path.join(skill.dir, name)
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(nodeDir, name))
      }
      await run(process.env.NPM?.trim() || 'npm', ['install', '--no-audit', '--no-fund'], nodeDir)
      node = true
    }
    writeMeta(dir, { installedAt: Date.now(), manifests: mtimes, python, node })
    return skillRuntimeView(skill)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeMeta(dir, { installedAt: Date.now(), manifests: mtimes, python, node, lastError: message.slice(0, 500) })
    throw error
  }
}

export function clearSkillRuntime(skill: SkillRuntimeTarget): void {
  fs.rmSync(skillRuntimeDir(skill), { recursive: true, force: true })
}

/** Remove dependency folders that an older/external installer created inside
 *  the skill directory itself. Only the known runtime directory names are
 *  touched; SKILL.md and scripts are never removed. */
export function clearLegacySkillRuntime(skill: SkillRuntimeTarget): string[] {
  const removed: string[] = []
  for (const name of ['runtime', '.runtime', 'venv', '.venv']) {
    const target = path.join(skill.dir, name)
    try {
      if (!fs.statSync(target).isDirectory()) continue
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Not present.
    }
  }
  return removed
}

/** Attach runtime paths to every registry entry before the activation tool
 *  renders SKILL.md. Safe to call after any reload. */
export function applySkillRuntimeHints(registry: {
  listAll(): Array<SkillRuntimeTarget & { runtimeHint?: string }>
}): void {
  for (const entry of registry.listAll()) entry.runtimeHint = skillRuntimeHint(entry)
}
