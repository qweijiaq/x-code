// @x-code-cli/cli — 启动时的 stderr 消息（无 API 密钥、无网页搜索、恢复提示、
// 更新检查）。从 index.ts 中移出来，让主流程读起来像编排，而不是五十行
// chalk 格式化的散文。
import { Chalk } from 'chalk'

import fs from 'node:fs'
import path from 'node:path'

import { PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, userXcodeDir } from '@x-code-cli/core'

import { detectShell, formatPersistCommand } from './shell.js'
import type { ShellType } from './shell.js'
import { getSessionExitInfo } from './ui/app/session-exit.js'
import { VERSION } from './version.js'

const chalk = new Chalk({ level: process.stderr.isTTY && !process.env.NO_COLOR ? 3 : 0 })

export function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s)
  const comment = (s: string) => chalk.gray(s)
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No model provider configured.') + '\n')
  console.error(`Use your ChatGPT subscription:\n\n  ${code('xc login')}\n`)
  console.error('Or set at least one provider API key via environment variable:\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    const provider = envKey
      .replace(/_API_KEY$/, '')
      .replace('GOOGLE_GENERATIVE_AI', 'google')
      .replace('MOONSHOT', 'moonshotai')
      .toLowerCase()
    const url = PROVIDER_KEY_URLS[provider] ?? ''
    console.error(`  ${envName(envKey.padEnd(32))} ${chalk.dim(url)}`)
  }
  console.error(
    `\n  ${envName('OPENAI_COMPATIBLE_API_KEY'.padEnd(32))} ${chalk.dim('(custom OpenAI-compatible endpoint)')}`,
  )

  const shell = detectShell()
  const restartHint: Record<ShellType, string> = {
    powershell: '# restart PowerShell, then run:',
    cmd: ':: restart CMD, then run:',
    zsh: '',
    bash: '',
    fish: '',
    sh: '',
  }
  console.error(`\nDetected shell: ${chalk.bold(shell)}`)
  console.error('Persist it so you do not need to set it every session:\n')
  console.error(`  ${code(formatPersistCommand('ANTHROPIC_API_KEY', 'sk-ant-...', shell))}`)
  const hint = restartHint[shell]
  if (hint) console.error(`  ${comment(hint)}  ${code('xc')}`)
  console.error(`\nAlternatively, put keys in a project-local ${chalk.bold('.env')} file (loaded from cwd upward).`)
}

export function printNoWebSearchKeyHint(): void {
  const shell = detectShell()
  const yellow = chalk.yellow
  const bold = chalk.bold
  const dim = chalk.gray
  const code = chalk.cyan

  console.error(yellow('Note:') + ' WebSearch is disabled — no search API key configured.')
  console.error(dim('  (WebFetch still works key-less; the hint is only for web search.)'))
  console.error('  Pick any (Tavily recommended — free, signup only):')
  console.error(`    ${bold('TAVILY_API_KEY')}      ${dim('1000/month free — https://tavily.com')}`)
  console.error(`    ${bold('BRAVE_API_KEY')}       ${dim('paid — https://api.search.brave.com')}`)
  console.error(`    ${bold('EXA_API_KEY')}         ${dim('1000/month free — https://exa.ai')}`)
  console.error(`    ${bold('PERPLEXITY_API_KEY')}  ${dim('paid — https://www.perplexity.ai/settings/api')}`)
  console.error(`    ${bold('FIRECRAWL_API_KEY')}   ${dim('free credits — https://firecrawl.dev')}`)
  console.error(dim("  DeepSeek models need no extra key — DeepSeek's built-in search is used automatically."))

  const cmd = formatPersistCommand('TAVILY_API_KEY', 'tvly-...', shell)
  console.error(`  ${dim(`(${shell})`)}  ${code(cmd)}\n`)
}

/** 在 Ink 卸载、终端重置之后打印一条可复制粘贴的恢复提示。镜像 Claude Code
 *  的退出行为，让关闭聊天的用户确切看到如何回到同一个会话。会话 id 是时间戳
 *  形状，与新的 jsonl 文件名匹配。
 *
 *  当会话还没有任何消息时（用户启动了但从未提交）会被抑制——否则我们会指向
 *  一个空的 jsonl。 */
export function printResumeHint(): void {
  const info = getSessionExitInfo()
  if (!info) return
  const cmd = chalk.cyan(`xc --resume ${info.sessionId}`)
  const dim = chalk.gray
  process.stdout.write(`${dim('Resume this session:')} ${cmd}\n`)
}

// ── 启动更新检查 ────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@x-code-cli/cli/latest'

function updateCheckCachePath(): string {
  return path.join(userXcodeDir(), 'cache', 'update-check.json')
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 即发即忘的更新检查。查询 npm registry（带 24 小时磁盘缓存），如果存在
 *  更新版本就向 stderr 打印一行提示。从不抛错——所有失败都被静默吞掉。 */
export async function checkForUpdate(): Promise<void> {
  if (!process.stderr.isTTY) return
  const current = VERSION
  if (!current || current === '0.0.0-dev') return
  const cachePath = updateCheckCachePath()

  // 先检查磁盘缓存
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8')
    const cache = JSON.parse(raw) as { checkedAt: number; latest: string }
    if (Date.now() - cache.checkedAt < ONE_DAY_MS) {
      if (compareVersions(cache.latest, current) > 0) {
        printUpdateHint(current, cache.latest)
      }
      return
    }
  } catch {
    // 缓存缺失或损坏——落到网络检查。
  }

  // 从 npm 获取最新版本
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest) return

    // 写缓存
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf-8')

    if (compareVersions(latest!, current) > 0) {
      printUpdateHint(current, latest!)
    }
  } finally {
    clearTimeout(timeout)
  }
}

let pendingUpdateHint: string | null = null

/** 由 TUI 注册的回调，用于在挂载后接收更新提示。checkForUpdate 大多时候在
 *  Ink 挂载前触发，但异步网络获取路径可能在挂载后完成——这让提示能到达 UI，
 *  而无需与 ChatInput 的单元网格渲染抢输出。 */
let onUpdateHint: ((msg: string) => void) | null = null

/** 注册更新提示处理器。由 App 在挂载时调用，让挂载前的缓存命中路径和挂载后
 *  的网络获取路径都通过 ChatInput 的消息系统渲染，而不是 stderr。 */
export function registerUpdateHintHandler(handler: ((msg: string) => void) | null): void {
  onUpdateHint = handler
}

/** 取出并清空任何在处理器注册之前就到达的提示。由 App 在挂载时使用，用于
 *  捕获缓存命中情况。 */
export function drainPendingUpdateHint(): string | null {
  const hint = pendingUpdateHint
  pendingUpdateHint = null
  return hint
}

function printUpdateHint(current: string, latest: string): void {
  const msg =
    chalk.yellow('Update available:') +
    ` ${chalk.gray(current)}` +
    ` ${chalk.gray('\u2192')}` +
    ` ${chalk.green(latest)}` +
    chalk.gray('  Run ') +
    chalk.cyan('npm install -g @x-code-cli/cli') +
    chalk.gray(' to update.')
  if (onUpdateHint) {
    onUpdateHint(msg)
    return
  }
  // 回退：先存起来，让 TUI 挂载后可以取走。
  pendingUpdateHint = msg
}
