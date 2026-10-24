// Project checks: detect and run the workspace's own typecheck/lint/test/build
// commands (Node) or cargo check/test (Rust). Checks run with CI=1 so watch
// modes stay one-shot, stop at the first failure by default, and return a
// bounded tail of the output.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const CHECK_TIMEOUT_MS = 10 * 60_000
const OUTPUT_BUFFER = 4 * 1024 * 1024
const OUTPUT_TAIL = 8_000

export type CheckKind = 'node' | 'cargo'
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'timeout'

export interface ProjectCheck {
  id: string
  label: string
  kind: CheckKind
  command: string
  args: string[]
}

export interface CheckResult extends ProjectCheck {
  status: CheckStatus
  exitCode: number | null
  durationMs: number
  output: string
}

function nodeCommand(name: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

async function readPackageJson(root: string): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function detectPackageManager(root: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  try {
    const entries = await fs.readdir(root)
    if (entries.includes('pnpm-lock.yaml') || entries.includes('pnpm-workspace.yaml')) return 'pnpm'
    if (entries.includes('yarn.lock')) return 'yarn'
    if (entries.includes('bun.lockb')) return 'bun'
  } catch {
    // Fall through to npm.
  }
  return 'npm'
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Detect checks in a stable order: typecheck → lint → test → build, then
 *  cargo check → cargo test. */
export async function detectProjectChecks(rootInput: string): Promise<ProjectCheck[]> {
  const root = path.resolve(rootInput)
  const checks: ProjectCheck[] = []
  const packageJson = await readPackageJson(root)
  if (packageJson) {
    const manager = await detectPackageManager(root)
    const addScriptCheck = (id: string, label: string, script: string): void => {
      if (!packageJson.scripts?.[script]) return
      checks.push({ id, label, kind: 'node', command: nodeCommand(manager), args: ['run', script] })
    }
    addScriptCheck('typecheck', '类型检查', 'typecheck')
    if (!checks.some((check) => check.id === 'typecheck') && (await exists(path.join(root, 'tsconfig.json')))) {
      checks.push({
        id: 'typecheck',
        label: '类型检查',
        kind: 'node',
        command: nodeCommand('npm'),
        args: ['exec', '--', 'tsc', '--noEmit'],
      })
    }
    addScriptCheck('lint', '代码检查', 'lint')
    addScriptCheck('test', '测试', 'test')
    addScriptCheck('build', '构建', 'build')
  }

  if (await exists(path.join(root, 'Cargo.toml'))) {
    checks.push({
      id: 'cargo-check',
      label: 'Cargo 检查',
      kind: 'cargo',
      command: 'cargo',
      args: ['check'],
    })
    checks.push({
      id: 'cargo-test',
      label: 'Cargo 测试',
      kind: 'cargo',
      command: 'cargo',
      args: ['test'],
    })
  }
  return checks
}

export function checkCommandLabel(check: ProjectCheck): string {
  return [check.command, ...check.args].join(' ')
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? `…\n${text.slice(-OUTPUT_TAIL)}` : text
}

async function runOne(root: string, check: ProjectCheck): Promise<CheckResult> {
  const started = Date.now()
  return new Promise<CheckResult>((resolve) => {
    const child = execFile(
      check.command,
      check.args,
      {
        cwd: root,
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: OUTPUT_BUFFER,
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        const output = tail(`${stdout ?? ''}${stderr ?? ''}`)
        const timedOut = Boolean((error as { killed?: boolean } | null)?.killed)
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code ?? 1) : 0
        const status: CheckStatus = timedOut ? 'timeout' : error ? 'failed' : 'passed'
        resolve({
          ...check,
          status,
          exitCode: status === 'passed' ? 0 : exitCode || 1,
          durationMs: Date.now() - started,
          output,
        })
      },
    )
    child.on('error', () => {
      // execFile's callback normally handles this; keep a guard for spawn errors.
      if (!child.exitCode && !child.killed) {
        resolve({
          ...check,
          status: 'failed',
          exitCode: 1,
          durationMs: Date.now() - started,
          output: 'Could not start the check command.',
        })
      }
    })
  })
}

export interface RunChecksOptions {
  ids?: string[]
  /** Stop at the first failure and mark the rest skipped (default true). */
  stopOnFailure?: boolean
  onStart?: (check: ProjectCheck) => void
}

export async function runProjectChecks(rootInput: string, options: RunChecksOptions = {}): Promise<CheckResult[]> {
  const root = path.resolve(rootInput)
  const checks = await detectProjectChecks(root)
  const selected = options.ids?.length ? checks.filter((check) => options.ids!.includes(check.id)) : checks
  const stopOnFailure = options.stopOnFailure !== false
  const results: CheckResult[] = []
  let stopped = false
  for (const check of selected) {
    if (stopped) {
      results.push({ ...check, status: 'skipped', exitCode: null, durationMs: 0, output: '' })
      continue
    }
    options.onStart?.(check)
    const result = await runOne(root, check)
    results.push(result)
    if (result.status !== 'passed' && stopOnFailure) stopped = true
  }
  return results
}

export function summarizeCheckResults(results: CheckResult[]): string {
  if (results.length === 0) return 'No project checks detected.'
  const lines = results.map((result) => {
    const icon = result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL'
    return `${icon} ${result.label} (${checkCommandLabel(result)}) — ${result.status}${
      result.status === 'failed' ? ` (exit ${result.exitCode})` : ''
    }`
  })
  return lines.join('\n')
}

export function failuresForAgent(results: CheckResult[]): string {
  const failures = results.filter((result) => result.status === 'failed' || result.status === 'timeout')
  if (failures.length === 0) return ''
  return failures
    .map(
      (result) =>
        `### ${result.label} — ${checkCommandLabel(result)} (${result.status})\n\n\`\`\`\n${result.output.slice(-4_000)}\n\`\`\``,
    )
    .join('\n\n')
}
