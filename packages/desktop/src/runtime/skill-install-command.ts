import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { importSkillIntoUserDir } from './skill-import.js'
import { systemProxyEnv } from './system-proxy.js'

const execFileAsync = promisify(execFile)
const MAX_SKILLS = 20

export interface SkillInstallRequest {
  source: string
  skillName?: string
  all: boolean
}

type SkillSource =
  | { kind: 'local'; path: string }
  | { kind: 'file'; url: string }
  | { kind: 'git'; url: string; ref?: string; subpath?: string }

export interface CopiedSkill {
  dir: string
  sourceName: string
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function isPluginInstallCommand(command: string): boolean {
  return /^(?:xc|x-code|claude)\s+plugin\s+install\b/i.test(command.trim())
}

/**
 * 解析常见市场技能安装命令而不运行它们：
 *   npx skills add <source> [--skill <name>] [--all]
 *   npx add-skill <source> [--skill <name>]
 *   xc skill install <source>
 * 也接受裸 source。
 */
export function parseSkillInstallCommand(command: string): SkillInstallRequest {
  let tokens = tokenize(command)
  if (tokens.length === 0) throw new Error('安装命令为空')

  if (tokens[0] === 'npx' || tokens[0] === 'bunx') {
    tokens = tokens.slice(1)
  } else if ((tokens[0] === 'pnpm' || tokens[0] === 'yarn') && tokens[1] === 'dlx') {
    tokens = tokens.slice(2)
  }

  if (tokens[0] === 'skills' && tokens[1] === 'add') {
    tokens = tokens.slice(2)
  } else if (tokens[0] === 'add-skill') {
    tokens = tokens.slice(1)
  } else if (
    (tokens[0] === 'xc' || tokens[0] === 'x-code' || tokens[0] === 'claude') &&
    tokens[1] === 'skill' &&
    tokens[2] === 'install'
  ) {
    tokens = tokens.slice(3)
  }

  let source = ''
  let skillName: string | undefined
  let all = false

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--skill' || token === '-s') {
      skillName = tokens[++index]
      continue
    }
    if (token.startsWith('--skill=')) {
      skillName = token.slice('--skill='.length)
      continue
    }
    if (token === '--all') {
      all = true
      continue
    }
    if (['--yes', '-y', '--global', '-g'].includes(token)) continue
    if (token === '--agent' || token === '-a') {
      index++
      continue
    }
    if (token.startsWith('--')) continue
    if (!source) {
      source = token
      continue
    }
    throw new Error(`无法识别的参数: ${token}`)
  }

  if (!source) throw new Error('安装命令缺少来源')
  if (skillName !== undefined && !skillName.trim()) throw new Error('--skill 缺少技能名')
  return { source, skillName: skillName?.trim(), all }
}

function isLocalPath(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
}

export function parseSkillSource(raw: string): SkillSource {
  const trimmed = raw.trim()

  const tree = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i)
  if (tree) {
    return {
      kind: 'git',
      url: `https://github.com/${tree[1]}/${tree[2]}.git`,
      ref: tree[3],
      subpath: tree[4],
    }
  }

  const blob = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.md)$/i)
  if (blob) {
    return {
      kind: 'file',
      url: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`,
    }
  }

  const github = trimmed.match(/^github:([^/]+)\/([^/]+?)(?:#(.+))?$/i)
  if (github) {
    return {
      kind: 'git',
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      ref: github[3],
    }
  }

  const repo = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (repo) {
    return { kind: 'git', url: `https://github.com/${repo[1]}/${repo[2]}.git` }
  }

  const pair = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:#(.+))?$/)
  if (pair && !trimmed.includes('://')) {
    return {
      kind: 'git',
      url: `https://github.com/${pair[1]}/${pair[2]}.git`,
      ref: pair[3],
    }
  }

  if (isLocalPath(trimmed)) return { kind: 'local', path: path.resolve(trimmed) }
  if (/^file:\/\//i.test(trimmed)) return { kind: 'git', url: trimmed }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('git@')) {
    return trimmed.toLowerCase().endsWith('.md') ? { kind: 'file', url: trimmed } : { kind: 'git', url: trimmed }
  }

  throw new Error('无法识别的技能来源。支持 npx skills add owner/repo、GitHub URL、Git URL 或本地路径')
}

async function cloneRepo(source: Extract<SkillSource, { kind: 'git' }>): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xcode-skill-repo-'))
  const args = ['clone', '--depth', '1']
  if (source.ref) args.push('--branch', source.ref, '--single-branch')
  args.push(source.url, dir)
  try {
    await execFileAsync('git', args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...systemProxyEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    })
    return dir
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true })
    const err = error as { stderr?: string; message?: string }
    const detail = (err.stderr ?? err.message ?? String(error)).trim().split('\n').slice(-3).join('\n')
    throw new Error(`git clone 失败：${detail}`)
  }
}

async function findSkillDirs(root: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor'])

  while (queue.length > 0 && found.length < 100) {
    const current = queue.shift()!
    if (fs.existsSync(path.join(current.dir, 'SKILL.md'))) {
      found.push(current.dir)
      continue
    }
    if (current.depth >= 5) continue
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return found
}

function skillNameOf(skillDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const line = frontmatter?.[1].match(/^name:\s*(.+)$/m)
    return line?.[1]?.trim().replace(/^["']|["']$/g, '') || path.basename(skillDir)
  } catch {
    return path.basename(skillDir)
  }
}

async function downloadSkillFile(url: string): Promise<CopiedSkill> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xcode-skill-file-'))
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const body = await response.text()
    const skillDir = path.join(dir, 'skill')
    await fs.promises.mkdir(skillDir, { recursive: true })
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8')
    return await importSkillIntoUserDir(skillDir)
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

/** 解析安装命令，获取 source，并把匹配的技能复制到
 *  用户技能目录。返回复制的目标目录。 */
export async function installSkillsFromCommand(command: string): Promise<CopiedSkill[]> {
  const request = parseSkillInstallCommand(command)
  const source = parseSkillSource(request.source)

  if (source.kind === 'local') {
    return [await importSkillIntoUserDir(source.path)]
  }
  if (source.kind === 'file') {
    return [await downloadSkillFile(source.url)]
  }

  const repoDir = await cloneRepo(source)
  try {
    const root = source.subpath ? path.join(repoDir, source.subpath) : repoDir
    if (!fs.existsSync(root)) throw new Error(`仓库中不存在路径：${source.subpath}`)

    const skillDirs = await findSkillDirs(root)
    if (skillDirs.length === 0) throw new Error('该来源中没有找到 SKILL.md')

    let selected = skillDirs
    if (request.skillName) {
      const wanted = request.skillName.toLowerCase()
      selected = skillDirs.filter(
        (dir) => skillNameOf(dir).toLowerCase() === wanted || path.basename(dir).toLowerCase() === wanted,
      )
      if (selected.length === 0) {
        const available = skillDirs.map(skillNameOf).join('、')
        throw new Error(`未找到技能 ${request.skillName}。可用技能：${available}`)
      }
    } else if (skillDirs.length > MAX_SKILLS) {
      throw new Error(`来源包含 ${skillDirs.length} 个技能，请用 --skill <name> 指定要安装的技能`)
    }

    const copied: CopiedSkill[] = []
    for (const dir of selected) copied.push(await importSkillIntoUserDir(dir))
    return copied
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }
}
