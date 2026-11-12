// @x-code-cli/core — 变更影响分析（MVP）
//
// 不依赖 LSP/类型信息：扫描工作区代码文件里的相对 import/require，构建反向
// 依赖图，从 git 变更（或显式文件）出发做有界 BFS，并尽量找出相关测试文件。
// 这是启发式结果，不是所有语言/别名都覆盖；调用方应把它当作导航提示。
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { CODE_INDEX_SKIP_DIRS, isCodeIndexFile, scanCodeFiles } from '../code-index/index.js'
import { inferProjectRoot } from '../lsp/format.js'
import { getTypeScriptService } from '../lsp/typescript-service.js'

const execFileAsync = promisify(execFile)
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
const TEST_PATTERN = /(?:^|[\\/])(?:__tests__|tests?|spec)(?:[\\/]|$)|\.(?:test|spec)\.[^\\/]+$/i

export interface ImpactReport {
  cwd: string
  changed: string[]
  directDependents: string[]
  transitiveDependents: string[]
  semanticReferences: string[]
  tests: string[]
  scannedFiles: number
  notes: string[]
}

export interface ImpactOptions {
  cwd: string
  files?: string[]
  maxDepth?: number
  /** 没有显式文件时是否回退到 git status（默认 true）。 */
  useGit?: boolean
  /** 额外查询 TypeScript LSP references（默认 false；较慢）。 */
  lsp?: boolean
}

function relative(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || path.basename(filePath)
}

function extractImports(text: string): string[] {
  const specs = new Set<string>()
  const patterns = [
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1]) specs.add(match[1])
  }
  return [...specs]
}

interface AliasConfig {
  baseUrl: string
  paths: Array<{ pattern: string; targets: string[] }>
}

function stripJsonComments(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    const next = input[index + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        output += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index++
      continue
    }
    output += char
  }
  return output
}

async function findTsConfig(cwd: string): Promise<string | null> {
  let dir = cwd
  for (let depth = 0; depth < 6; depth++) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(dir, name)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // 继续查找。
      }
    }
    try {
      await fs.access(path.join(dir, '.git'))
      break
    } catch {
      // 继续向上。
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function loadAliases(cwd: string): Promise<AliasConfig | null> {
  const configPath = await findTsConfig(cwd)
  if (!configPath) return null
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(stripJsonComments(raw).replace(/,\s*([}\]])/g, '$1')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
    }
    const options = parsed.compilerOptions ?? {}
    const baseUrl = path.resolve(path.dirname(configPath), options.baseUrl ?? '.')
    const paths = Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
      pattern,
      targets: Array.isArray(targets) ? targets : [],
    }))
    return { baseUrl, paths }
  } catch {
    return null
  }
}

interface WorkspacePackage {
  name: string
  root: string
  entries: string[]
}

function packageEntries(root: string, pkg: Record<string, unknown>): string[] {
  const entries = new Set<string>()
  for (const field of ['main', 'module', 'types', 'source']) {
    if (typeof pkg[field] === 'string') entries.add(path.resolve(root, pkg[field] as string))
  }
  const exportsField = pkg.exports
  if (typeof exportsField === 'string') entries.add(path.resolve(root, exportsField))
  else if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dot = (exportsField as Record<string, unknown>)['.']
    if (typeof dot === 'string') entries.add(path.resolve(root, dot))
    else if (dot && typeof dot === 'object') {
      for (const key of ['import', 'require', 'default', 'types']) {
        const value = (dot as Record<string, unknown>)[key]
        if (typeof value === 'string') entries.add(path.resolve(root, value))
      }
    }
  }
  for (const fallback of ['src/index', 'index']) {
    for (const extension of EXTENSIONS) entries.add(path.resolve(root, `${fallback}${extension}`))
  }
  return [...entries]
}

async function loadWorkspacePackages(cwd: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (CODE_INDEX_SKIP_DIRS.has(entry.name)) continue
        await walk(target, depth + 1)
        continue
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue
      try {
        const pkg = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>
        if (typeof pkg.name !== 'string' || !pkg.name.trim()) continue
        const root = path.dirname(target)
        packages.push({ name: pkg.name.trim(), root, entries: packageEntries(root, pkg) })
      } catch {
        // 忽略损坏的 package.json。
      }
    }
  }
  await walk(cwd, 0)
  return packages.sort((a, b) => b.name.length - a.name.length)
}

function resolveBase(base: string, known: Set<string>): string | null {
  for (const extension of EXTENSIONS) {
    const candidate = path.normalize(`${base}${extension}`)
    if (known.has(candidate)) return candidate
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.normalize(path.join(base, `index${extension}`))
    if (known.has(candidate)) return candidate
  }
  return null
}

function matchAlias(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === spec ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null
  return spec.slice(prefix.length, spec.length - suffix.length)
}

function resolveImport(
  fromFile: string,
  spec: string,
  known: Set<string>,
  aliases: AliasConfig | null,
  workspacePackages: readonly WorkspacePackage[],
): string | null {
  if (spec.startsWith('.')) {
    return resolveBase(path.resolve(path.dirname(fromFile), spec), known)
  }
  for (const pkg of workspacePackages) {
    if (spec === pkg.name) {
      for (const entry of pkg.entries) {
        const resolved = resolveBase(entry, known)
        if (resolved) return resolved
      }
    } else if (spec.startsWith(`${pkg.name}/`)) {
      const subpath = spec.slice(pkg.name.length + 1)
      const resolved = resolveBase(path.resolve(pkg.root, subpath), known)
      if (resolved) return resolved
    }
  }
  if (!aliases) return null
  for (const alias of aliases.paths) {
    const capture = matchAlias(alias.pattern, spec)
    if (capture === null) continue
    for (const target of alias.targets) {
      const resolved = resolveBase(path.resolve(aliases.baseUrl, target.replace('*', capture)), known)
      if (resolved) return resolved
    }
  }
  // baseUrl 的裸导入（非 paths）也支持。
  return resolveBase(path.resolve(aliases.baseUrl, spec), known)
}

export function extractExportedSymbols(text: string): Array<{ name: string; line: number; column: number }> {
  const symbols: Array<{ name: string; line: number; column: number }> = []
  const pattern =
    /export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (!name || match.index === undefined) continue
    const before = text.slice(0, match.index)
    const line = before.split('\n').length
    const column = match.index - before.lastIndexOf('\n')
    symbols.push({ name, line, column })
  }
  return symbols
}

async function lspReferencesForChanged(changed: readonly string[], notes: string[]): Promise<string[]> {
  const references = new Set<string>()
  let attempted = false
  for (const file of changed) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file)) continue
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const symbols = extractExportedSymbols(text).slice(0, 12)
    if (symbols.length === 0) continue
    attempted = true
    try {
      const service = getTypeScriptService(inferProjectRoot(file))
      for (const symbol of symbols) {
        try {
          const locations = await service.references(file, symbol.line, symbol.column, undefined, true, 120)
          for (const location of locations) {
            const target = path.resolve(location.file)
            if (target !== path.resolve(file)) references.add(target)
          }
        } catch {
          // 单个符号失败不影响其他符号。
        }
      }
    } catch {
      notes.push('TypeScript LSP unavailable; --lsp references were skipped.')
      break
    }
  }
  if (attempted && references.size === 0) notes.push('TypeScript LSP found no external symbol references.')
  return [...references]
}

async function gitChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const files: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let target = line.slice(3).trim()
    if (target.includes(' -> ')) target = target.split(' -> ').pop()!.trim()
    if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1)
    if (!target) continue
    const absolute = path.resolve(cwd, target)
    if (isCodeIndexFile(absolute)) files.push(absolute)
  }
  return files
}

export async function analyzeChangeImpact(options: ImpactOptions): Promise<ImpactReport> {
  const cwd = path.resolve(options.cwd)
  const notes: string[] = []
  let changed = (options.files ?? []).map((file) => path.resolve(cwd, file))
  if (changed.length === 0 && options.useGit !== false) {
    try {
      changed = await gitChangedFiles(cwd)
    } catch {
      notes.push('git status unavailable; pass explicit files to analyze.')
    }
  }
  if (changed.length === 0) {
    return {
      cwd,
      changed: [],
      directDependents: [],
      transitiveDependents: [],
      semanticReferences: [],
      tests: [],
      scannedFiles: 0,
      notes: [...notes, 'No changed code files found.'],
    }
  }

  const files = await scanCodeFiles(cwd)
  const known = new Set(files.map((file) => file.path))
  const aliases = await loadAliases(cwd)
  const workspacePackages = await loadWorkspacePackages(cwd)
  const importers = new Map<string, Set<string>>()
  let unresolved = 0
  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file.path, 'utf8')
    } catch {
      continue
    }
    for (const spec of extractImports(text)) {
      const target = resolveImport(file.path, spec, known, aliases, workspacePackages)
      if (!target) {
        if (spec.startsWith('.')) unresolved++
        continue
      }
      const set = importers.get(target) ?? new Set<string>()
      set.add(file.path)
      importers.set(target, set)
    }
  }

  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 8))
  const visited = new Set(changed)
  const direct = new Set<string>()
  let frontier = changed
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = []
    for (const file of frontier) {
      for (const importer of importers.get(file) ?? []) {
        if (visited.has(importer)) continue
        visited.add(importer)
        next.push(importer)
        if (depth === 0) direct.add(importer)
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  const transitive = [...visited].filter((file) => !changed.includes(file) && !direct.has(file))
  const semanticReferences = options.lsp ? await lspReferencesForChanged(changed, notes) : []
  const affected = new Set<string>([...changed, ...direct, ...transitive, ...semanticReferences])
  const tests = [...affected]
    .filter((file) => TEST_PATTERN.test(file))
    .concat(
      files
        .map((file) => file.path)
        .filter((file) => TEST_PATTERN.test(file))
        .filter((test) => {
          if (affected.has(test)) return false
          const imported = new Set<string>()
          for (const [target, sources] of importers) {
            if (sources.has(test)) imported.add(target)
          }
          return [...imported].some((target) => affected.has(target))
        }),
    )
    .filter((file, index, all) => all.indexOf(file) === index)

  if (direct.size === 0) notes.push('No direct dependents found in scanned code files.')
  if (unresolved > 0) notes.push(`${unresolved} relative import(s) could not be resolved.`)
  if (tests.length === 0) notes.push('No related test files detected.')

  return {
    cwd,
    changed: changed.map((file) => relative(cwd, file)).sort(),
    directDependents: [...direct].map((file) => relative(cwd, file)).sort(),
    transitiveDependents: transitive.map((file) => relative(cwd, file)).sort(),
    semanticReferences: semanticReferences.map((file) => relative(cwd, file)).sort(),
    tests: tests.map((file) => relative(cwd, file)).sort(),
    scannedFiles: files.length,
    notes,
  }
}

export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = []
  lines.push(`**Change impact** — ${report.changed.length} changed, ${report.scannedFiles} scanned`)
  lines.push('')
  const section = (title: string, files: string[]): void => {
    if (files.length === 0) return
    lines.push(`**${title}**`)
    for (const file of files) lines.push(`- ${file}`)
    lines.push('')
  }
  section('Changed', report.changed)
  section('Direct dependents', report.directDependents)
  section('Transitive dependents', report.transitiveDependents)
  section('LSP references', report.semanticReferences)
  section('Related tests', report.tests)
  for (const note of report.notes) lines.push(`_${note}_`)
  return lines.join('\n').trim()
}
