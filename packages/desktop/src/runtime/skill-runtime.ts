// 每个技能隔离的依赖运行时。
//
// 技能是说明加上可选的脚本/清单。历史上模型从项目 cwd 运行
// `pip install` / `npm install`，把 venv 和 node_modules 落到用户的
// 仓库里。这个模块为每个技能在
// `~/.x-code/skill-runtime/<slug>-<hash>` 下提供稳定目录，并只在
// 用户显式请求时在那里安装依赖。
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
      // 不存在。
    }
  }
  return found
}

function metaPath(dir: string): string {
  return path.join(dir, 'runtime.json')
}

function readMeta(dir: string): RuntimeMeta | null {
  try {
    // 元数据是磁盘上的外部输入（旧版本写入 / 被截断 / 人工改坏），
    // `manifests` 缺失时调用方会直接抛 TypeError，必须在这里归一化。
    const parsed = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')) as Partial<RuntimeMeta> | null
    if (parsed && typeof parsed === 'object' && typeof parsed.installedAt === 'number') {
      const recorded = parsed.manifests
      const manifests: Record<string, number> = {}
      if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
        for (const [file, mtime] of Object.entries(recorded)) {
          if (typeof mtime === 'number') manifests[file] = mtime
        }
      }
      return { ...parsed, installedAt: parsed.installedAt, manifests }
    }
  } catch {
    // 没有元数据或元数据格式损坏。
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
      // 已消失。
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

/** 追加到 SKILL.md 的激活文本。防止模型在项目工作区
 *  安装依赖。 */
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
    // execFile 不走 shell，message 里通常只有命令名；把 stderr 摘要一并给出，
    // 用户才能看出是哪个包 / 哪一步失败。
    const failure = error as { message?: string; stderr?: string }
    const detail = (failure.stderr?.trim() || failure.message || String(error)).trim()
    throw new Error(`${command} ${args.join(' ')} failed: ${detail.slice(0, 500)}`)
  }
}

/** 把声明的依赖安装到隔离的运行时目录中。 */
async function installSkillRuntimeOnce(skill: SkillRuntimeTarget): Promise<SkillRuntimeView> {
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
        // Windows 的官方安装包提供的是 `python` / `py`，没有 `python3`。
        await run(
          process.env.PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3'),
          ['-m', 'venv', path.join(dir, 'venv')],
          dir,
        )
      }
      // 两个清单都要装：只装 requirements.txt 会让 pyproject.toml 里的
      // 依赖永远缺失，而 mtimes 却把两者都记成“已安装”。
      if (manifests.some((manifest) => manifest.file === 'requirements.txt')) {
        await run(pythonExe, ['-m', 'pip', 'install', '-r', path.join(skill.dir, 'requirements.txt')], dir)
      }
      if (manifests.some((manifest) => manifest.file === 'pyproject.toml')) {
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
      // Windows 上裸 `npm` 无法被 execFile 解析（实际可执行文件是 npm.cmd）。
      await run(
        process.env.NPM?.trim() || (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
        ['install', '--no-audit', '--no-fund'],
        nodeDir,
      )
      node = true
    }
    writeMeta(dir, { installedAt: Date.now(), manifests: mtimes, python, node })
    return skillRuntimeView(skill)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      writeMeta(dir, { installedAt: Date.now(), manifests: mtimes, python, node, lastError: message.slice(0, 500) })
    } catch {
      // 记录失败不应覆盖真正的安装错误。
    }
    throw error
  }
}

/** 同一个运行时目录同时只允许一次安装：连点两次或两个窗口同时安装会并发
 *  跑 pip/npm 并互相覆盖 runtime.json。 */
const installsInFlight = new Map<string, Promise<SkillRuntimeView>>()

export function installSkillRuntime(skill: SkillRuntimeTarget): Promise<SkillRuntimeView> {
  const dir = skillRuntimeDir(skill)
  const running = installsInFlight.get(dir)
  if (running) return running
  const task: Promise<SkillRuntimeView> = installSkillRuntimeOnce(skill).finally(() => {
    if (installsInFlight.get(dir) === task) installsInFlight.delete(dir)
  })
  installsInFlight.set(dir, task)
  return task
}

export function clearSkillRuntime(skill: SkillRuntimeTarget): void {
  fs.rmSync(skillRuntimeDir(skill), { recursive: true, force: true })
}

/** 删除旧版/外部安装器在技能目录内部创建的依赖文件夹。
 *  只触及已知的运行时目录名；SKILL.md 和脚本
 *  绝不会被删除。 */
export function clearLegacySkillRuntime(skill: SkillRuntimeTarget): string[] {
  const removed: string[] = []
  for (const name of ['runtime', '.runtime', 'venv', '.venv']) {
    const target = path.join(skill.dir, name)
    try {
      if (!fs.statSync(target).isDirectory()) continue
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // 不存在。
    }
  }
  return removed
}

/** 在激活工具渲染 SKILL.md 之前，把运行时路径附加到每个注册表条目。
 *  在任何重载后调用都安全。 */
export function applySkillRuntimeHints(registry: {
  listAll(): Array<SkillRuntimeTarget & { runtimeHint?: string }>
}): void {
  for (const entry of registry.listAll()) entry.runtimeHint = skillRuntimeHint(entry)
}
