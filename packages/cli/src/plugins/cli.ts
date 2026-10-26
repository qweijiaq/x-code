// @x-code-cli/cli — 非交互式插件子命令
//
// `xc plugin <subcommand> ...` 入口点——不挂载 Ink UI 就运行，打印到
// stdout/stderr，并以适合脚本的退出码结束。镜像 `App.tsx` 里 `handlePlugin`
// 的斜杠命令族，这样用户可以从两个界面驱动同样的操作。
//
// 在 yargs 看到参数之前，由 `index.ts` 的 main() 路由——这样
// `xc plugin install ./foo` 就不会被当成 agent 应当回答的提示词。
import { Chalk } from 'chalk'

import {
  addKnownMarketplace,
  clearPluginEntry,
  debugLog,
  ensureDefaultMarketplaces,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  loadAllPlugins,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  removeKnownMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from '@x-code-cli/core'
import type { ConsentPreview, PluginScope } from '@x-code-cli/core'

import { formatPluginSource } from './format.js'
import { resolvePluginInstallSource } from './install-source.js'
import { searchMarketplacePlugins } from './search.js'

const chalk = new Chalk()

export async function runPluginCli(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  // 首次运行播种：与 packages/cli/src/index.ts 中主交互入口相同。没有它，
  // 一个从未启动过交互式 CLI 的新用户运行 `xc plugin marketplace list`（或
  // `search`）时会看到空的订阅列表——“首次运行就有 Anthropic marketplace
  // 就绪”这一产品承诺需要在每个首次接触的界面上都成立，而不仅是 TUI 入口。
  // 对已命名的条目幂等；被移除的默认订阅会在这里恢复。
  await ensureDefaultMarketplaces().catch((err) => debugLog('plugins.ensure-defaults-failed', String(err)))

  try {
    switch (sub) {
      case '':
      case 'list':
        return await cliList(rest)
      case 'info':
        return await cliInfo(rest)
      case 'install':
        return await cliInstall(rest)
      case 'uninstall':
        return await cliUninstall(rest)
      case 'enable':
        return await cliToggle(rest, true)
      case 'disable':
        return await cliToggle(rest, false)
      case 'search':
        return await cliSearch(rest)
      case 'update':
        return await cliUpdate(rest)
      case 'doctor':
        return await cliDoctor()
      case 'marketplace':
        return await cliMarketplace(rest)
      default:
        printUsage()
        return 1
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    return 1
  }
}

function printUsage(): void {
  console.error(
    [
      'Usage: xc plugin <subcommand> [args...]',
      '',
      'Subcommands:',
      '  list                      List installed plugins',
      "  info <id>                 Show a plugin's manifest, contributions, hooks",
      '  install <source>          Install from name@marketplace, github:owner/repo, git URL, or local path',
      '  uninstall <id>            Remove a plugin (cache + settings; data dir preserved)',
      '  enable <id>               Enable a plugin (user scope)',
      '  disable <id>              Disable a plugin without uninstalling',
      '  search <keyword>          Search subscribed marketplaces',
      '  update [--yes] <id>|--all Reinstall from recorded source (consent required)',
      '  doctor                    Show plugin load errors',
      '  marketplace <add|remove|list|refresh|info> [args...]',
      '                            Manage marketplace subscriptions',
      '',
      'Example:',
      '  xc plugin marketplace add anthropic-marketplace github:anthropics/marketplace',
      '  xc plugin marketplace refresh anthropic-marketplace',
      '  xc plugin install linear@anthropic-marketplace',
    ].join('\n'),
  )
}

// ── list / info ────────────────────────────────────────────────────────

async function cliList(args: string[] = []): Promise<number> {
  // 可选过滤器镜像斜杠命令：--enabled / --disabled。无标志 = 列出每个已安装
  // 插件（默认）。
  let filter: 'all' | 'enabled' | 'disabled' = 'all'
  for (const a of args) {
    if (a === '--enabled') filter = 'enabled'
    else if (a === '--disabled') filter = 'disabled'
  }

  // 对 'all' 我们可以保持廉价，只读取记账文件。对过滤视图我们需要启用状态，
  // 而这只有 loadAllPlugins 才能解析（跨作用域合并 settings.json）。
  if (filter === 'all') {
    const installed = await listInstalledPlugins()
    if (installed.length === 0) {
      console.log('No plugins installed.')
      return 0
    }
    console.log(`Installed plugins (${installed.length}):`)
    const namePad = Math.max(...installed.map((p) => p.id.length), 8) + 2
    for (const p of installed) {
      console.log(`  ${p.id.padEnd(namePad)} v${p.version}  ${formatPluginSource(p.source)}`)
    }
    return 0
  }

  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const filtered = filter === 'enabled' ? all.filter((p) => p.enabled) : all.filter((p) => !p.enabled)
  if (all.length === 0) {
    console.log('No plugins installed.')
    return 0
  }
  if (filtered.length === 0) {
    console.log(`No ${filter} plugins.`)
    return 0
  }
  console.log(`Installed plugins (${filter}, ${filtered.length} of ${all.length}):`)
  const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
  for (const p of filtered) {
    const badge = p.enabled ? '[on] ' : '[off]'
    console.log(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${formatPluginSource(p.source)}`)
  }
  return 0
}

async function cliInfo(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin info <id>')
    return 1
  }
  // 用 loadAllPlugins 获取实际的 manifest + 启用状态，而不只是记账记录。
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const plugin = load.registry.getEntry(id)
  if (!plugin) {
    console.error(`No plugin '${id}' loaded.`)
    return 1
  }
  console.log(`${plugin.id} v${plugin.manifest.version}`)
  if (plugin.manifest.description) console.log(plugin.manifest.description)
  console.log()
  console.log(`Enabled:     ${plugin.enabled ? 'yes' : 'no'}`)
  console.log(`Source:      ${formatPluginSource(plugin.source)}`)
  console.log(`Marketplace: ${plugin.marketplace}`)
  console.log(`Root dir:    ${plugin.rootDir}`)
  console.log(`Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`)
  const c = load.contributions.get(plugin.id)
  if (c) {
    console.log()
    console.log('Contributions:')
    if (c.skillsDir) console.log(`  skills:     ${c.skillsDir}`)
    if (c.agentsDir) console.log(`  agents:     ${c.agentsDir}`)
    if (c.commandsDir) console.log(`  commands:   ${c.commandsDir}`)
    if (c.mcpServers) console.log(`  mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
    if (c.hooks) console.log(`  hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
  }
  return 0
}

// ── install / uninstall / update ───────────────────────────────────────

async function cliInstall(args: string[]): Promise<number> {
  // 在读取源之前先剥离 --yes / -y。与顺序无关，这样用户既可以写 `--yes <src>`
  // 也可以写 `<src> --yes`。
  const skipConsent = args.includes('--yes') || args.includes('-y')
  const sourceArgs = args.filter((a) => a !== '--yes' && a !== '-y')
  const raw = sourceArgs.join(' ').trim()
  if (!raw) {
    console.error('Usage: xc plugin install [--yes] <source>')
    console.error('  <source>: name@marketplace | github:owner/repo | https://... | /path')
    return 1
  }

  const parsed = await parseInstallSource(raw)
  if (!parsed) return 1

  console.log(`Installing from ${formatPluginSource(parsed.source)} ...`)
  try {
    const result = await installPlugin({
      source: parsed.source,
      marketplace: parsed.marketplace,
      expectedName: parsed.expectedName,
      consent: skipConsent ? undefined : promptConsent,
      // userConfig 提示只在 manifest 声明了字段且不处于 `--yes` 非交互模式时
      // 运行（脚本可以通过直接编辑 ~/.x-code/plugins/user-config.json 或通过
      // 未来的 `xc plugin configure` 命令写这些值来预填）。
      userConfigPrompt: skipConsent ? undefined : promptUserConfig,
    })
    console.log(chalk.green(`Installed ${result.pluginId} v${result.manifest.version}`))
    console.log(`Cache: ${result.rootDir}`)
    // 不打印 "restart xc" 提示——这个子命令是从 shell 一次性运行的，而不是在
    // 活跃会话内运行。别处有活跃 xc TUI 的用户可以在那里运行 `/plugin refresh`
    // 来获取这个变更。
    return 0
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : String(err)}`))
    return 1
  }
}

/** 把同意预览渲染到 stderr，并从 stdin 读取一个 y/n。在没有 TTY 时
 *  （CI 环境、管道安装脚本）默认拒绝——那些调用方应显式传 `--yes`。 */
async function promptConsent(preview: ConsentPreview): Promise<boolean> {
  const lines: string[] = []
  lines.push('')
  lines.push(chalk.bold.yellow(`About to install: ${preview.pluginId} v${preview.version}`))
  if (preview.description) lines.push(`  ${preview.description}`)
  lines.push('')
  lines.push(`  Source:      ${formatPluginSource(preview.source)}`)
  lines.push(
    `  Marketplace: ${preview.marketplace}${preview.fromReservedMarketplace ? ' [reserved/official]' : ''}${preview.verified ? ' [verified]' : ''}`,
  )
  if (preview.author) lines.push(`  Author:      ${preview.author}`)
  if (preview.license) lines.push(`  License:     ${preview.license}`)
  if (preview.homepage) lines.push(`  Homepage:    ${preview.homepage}`)
  lines.push('')
  lines.push('  Will contribute:')
  if (preview.hasSkillsDir) lines.push('    - skills (added to /skill list)')
  if (preview.hasAgentsDir) lines.push('    - sub-agents (callable via the `task` tool)')
  if (preview.hasCommandsDir) lines.push('    - slash commands (each `.md` file becomes a `/<name>` command)')
  if (preview.inlineMcpServerNames.length > 0) {
    lines.push(
      `    - ${chalk.red('MCP servers')} (will be spawned as subprocesses): ${preview.inlineMcpServerNames.join(', ')}`,
    )
  } else if (preview.hasPathMcpServers) {
    lines.push(`    - ${chalk.red('MCP servers')} (from external file — spawned as subprocesses)`)
  }
  if (preview.hookEvents.length > 0) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (will run shell commands on: ${preview.hookEvents.join(', ')})`)
  } else if (preview.hasPathHooks) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (from external file — will run shell commands)`)
  }
  if (
    !preview.hasSkillsDir &&
    !preview.hasAgentsDir &&
    !preview.hasCommandsDir &&
    preview.inlineMcpServerNames.length === 0 &&
    !preview.hasPathMcpServers &&
    preview.hookEvents.length === 0 &&
    !preview.hasPathHooks
  ) {
    lines.push('    (no contributions declared)')
  }
  lines.push('')

  process.stderr.write(lines.join('\n'))

  // 无 TTY → 默认拒绝。脚本应传 `--yes`。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(chalk.yellow('No TTY — declining install. Use --yes to skip the prompt in scripts.\n'))
    return false
  }

  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('Proceed with install? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** 遍历 manifest 的 userConfig 列表并为每个字段提示。镜像同意提示的 TTY-only
 *  立场：管道输入安装脚本应预填值或使用 `--yes`（它会完全跳过这里）。敏感字段
 *  在输入时不会被回显——我们在提问期间把 tty 切到 raw 模式，镜像 `git` 提示
 *  凭据的方式。 */
async function promptUserConfig(
  fields: Parameters<NonNullable<Parameters<typeof installPlugin>[0]['userConfigPrompt']>>[0],
): Promise<Record<string, string | number | boolean> | null> {
  // installer 只在 fields.length > 0 时才调用我们，但 TypeScript 从调用点
  // 看不到这一点——显式防护。
  if (!fields) return {}
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      chalk.yellow(
        'No TTY — skipping userConfig prompt. Pre-seed values in ~/.x-code/plugins/user-config.json or use --yes.\n',
      ),
    )
    return {}
  }
  process.stderr.write('\n' + chalk.bold('This plugin needs configuration:') + '\n')

  const collected: Record<string, string | number | boolean> = {}
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  try {
    for (const f of fields) {
      const label = f.prompt ?? f.description
      const required = f.required ? ' (required)' : ''
      const defaultNote = f.default !== undefined ? ` [default: ${f.default}]` : ''
      const sensitive = f.sensitive === true
      // 当 manifest 既没提供 `prompt` 也没提供 `description` 时，旧代码会落到
      // `f.key`，产生像 `MY_URL: MY_URL [default: ...]` 这样的标签——键被同时
      // 用作标签*和*人类可读描述。那种情况下只显示键本身。
      const promptText = label
        ? `  ${chalk.cyan(f.key)}: ${label}${required}${defaultNote}\n  > `
        : `  ${chalk.cyan(f.key)}${required}${defaultNote}\n  > `

      let answer: string
      if (sensitive) {
        // 在读取期间抑制本地回显。Node 的 readline 不直接暴露这一点，因此我们
        // 给输出流的 write 打补丁，丢弃除了每次击键一个 '*' 之外的所有内容。
        // 与 inquirer 用于其 `password` 提示的技术相同。
        const out = process.stderr
        const originalWrite = out.write.bind(out)
        process.stderr.write(promptText)
        let muted = true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(out as { write: (...args: any[]) => boolean }).write = (chunk: string | Buffer) => {
          if (!muted) return originalWrite(chunk)
          const s = typeof chunk === 'string' ? chunk : chunk.toString()
          if (s.includes('\n') || s.includes('\r')) return originalWrite(s)
          return true
        }
        try {
          answer = await rl.question('')
        } finally {
          muted = false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(out as { write: (...args: any[]) => boolean }).write = originalWrite
          process.stderr.write('\n')
        }
      } else {
        answer = await rl.question(promptText)
      }

      const trimmed = answer.trim()
      if (!trimmed) {
        if (f.default !== undefined) {
          collected[f.key] = f.default
        } else if (f.required) {
          process.stderr.write(chalk.red(`  '${f.key}' is required.\n`))
          return null
        }
        continue
      }

      if (f.type === 'number') {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) {
          process.stderr.write(chalk.red(`  '${f.key}' must be a number.\n`))
          return null
        }
        collected[f.key] = n
      } else if (f.type === 'boolean') {
        collected[f.key] = /^(true|y|yes|1)$/i.test(trimmed)
      } else {
        collected[f.key] = trimmed
      }
    }
  } finally {
    rl.close()
  }
  return collected
}

async function parseInstallSource(raw: string) {
  const result = await resolvePluginInstallSource(raw)
  if (result.ok) return result

  switch (result.code) {
    case 'plugin-not-found':
      console.error(
        `Plugin '${result.pluginName}' not found in marketplace '${result.marketplace}'. ` +
          `Run 'xc plugin marketplace refresh ${result.marketplace}' or check the spelling.`,
      )
      break
    case 'invalid-github-source':
      console.error('Invalid github source. Expected github:owner/repo[#ref]')
      break
    case 'unrecognized-source':
      console.error(
        `Unrecognised source: '${result.source}'. Use name@marketplace, github:owner/repo, an https/git URL, or a path.`,
      )
      break
  }
  return null
}

async function cliUninstall(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin uninstall <id>')
    return 1
  }
  const result = await uninstallPlugin(id)
  if (!result.removedRecord && result.removedVersions.length === 0) {
    console.error(`No plugin '${id}' installed.`)
    return 1
  }
  for (const scope of ['user', 'project'] as PluginScope[]) {
    await clearPluginEntry(id, scope).catch(() => undefined)
  }
  console.log(
    chalk.green(
      `Uninstalled ${id} (removed ${result.removedVersions.length} cached version${result.removedVersions.length === 1 ? '' : 's'})`,
    ),
  )
  console.log('Data dir preserved.')
  return 0
}

async function cliToggle(args: string[], enable: boolean): Promise<number> {
  // 在位置参数 id 之前先取出可选的 --scope 标志，匹配 /skill enable|disable
  // 的形式。默认 scope = 'user'。
  let scope: PluginScope = 'user'
  const positional: string[] = []
  for (const a of args) {
    const m = a.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const v = m[1]?.toLowerCase()
      if (v === 'user' || v === 'project') scope = v
      continue
    }
    positional.push(a)
  }
  const id = positional[0]
  if (!id) {
    console.error(`Usage: xc plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]`)
    return 1
  }
  const result = await setPluginEnabled(id, scope, enable)
  const verb = enable ? 'enabled' : 'disabled'
  if (result === 'noop') {
    console.log(`Plugin '${id}' already ${verb} (${scope} scope).`)
  } else {
    console.log(chalk.green(`Plugin ${id} ${verb} in ${scope} scope.`))
  }
  return 0
}

async function cliUpdate(args: string[]): Promise<number> {
  // 两种模式——显式：
  //   xc plugin update <id>   单个插件（既有行为）
  //   xc plugin update --all  每个已安装插件，顺序执行，出错跳过
  //
  // 裸 `xc plugin update` 被刻意拒绝。npm 把裸命令当作全部，但那正是会在
  // 打错字 / 会话中途试验时咬到用户的东西；Gemini CLI 采取同样的防御立场。
  // 错误消息同时提供两种形式，这样正确的选择只差一次按键。
  const all = args.includes('--all') || args.includes('-a')
  const skipConsent = args.includes('--yes') || args.includes('-y')
  const positional = args.filter((a) => !['--all', '-a', '--yes', '-y'].includes(a))

  if (all && positional.length > 0) {
    console.error('xc plugin update: pass either `--all` or a plugin id, not both.')
    return 1
  }
  if (!all && positional.length === 0) {
    console.error('Usage: xc plugin update [--yes] <id> | --all')
    console.error('  <id>: a name@marketplace from `xc plugin list`')
    console.error('  --all: update every installed plugin (sequential, skip-on-error)')
    return 1
  }

  if (all) {
    const records = await listInstalledPlugins()
    if (records.length === 0) {
      console.log('No plugins installed.')
      return 0
    }
    console.log(`Updating ${records.length} plugin${records.length === 1 ? '' : 's'} …`)
    let updated = 0
    let unchanged = 0
    let failed = 0
    for (const rec of records) {
      const outcome = await updateOnePlugin(rec, skipConsent)
      if (outcome === 'updated') updated++
      else if (outcome === 'unchanged') unchanged++
      else failed++
    }
    console.log('')
    console.log(
      `Summary: ${chalk.green(updated)} updated, ${unchanged} unchanged, ${failed > 0 ? chalk.red(failed) : failed} failed.`,
    )
    return failed > 0 ? 1 : 0
  }

  const id = positional[0]!
  const records = await listInstalledPlugins()
  const rec = records.find((r) => r.id === id)
  if (!rec) {
    console.error(`Plugin '${id}' not installed.`)
    return 1
  }
  console.log(`Reinstalling ${id} from ${formatPluginSource(rec.source)} ...`)
  const outcome = await updateOnePlugin(rec, skipConsent)
  return outcome === 'failed' ? 1 : 0
}

type UpdateOutcome = 'updated' | 'unchanged' | 'failed'

/** 从其记录的源重装一个插件并报告发生了什么。设计为可从单个 id 和 `--all`
 *  两条路径调用；逐行输出简洁（只输出结果），让批量更新读起来像干净的列表。
 *  从不抛错——失败变成 `'failed'`，让调用方的循环可以继续。 */
async function updateOnePlugin(
  rec: Awaited<ReturnType<typeof listInstalledPlugins>>[number],
  skipConsent: boolean,
): Promise<UpdateOutcome> {
  try {
    const result = await installPlugin({
      source: rec.source,
      marketplace: rec.marketplace,
      expectedName: rec.name,
      consent: skipConsent ? undefined : promptConsent,
    })
    if (result.manifest.version === rec.version) {
      console.log(`  ${rec.id}: reinstalled at ${rec.version}`)
      return 'unchanged'
    }
    console.log(chalk.green(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`))
    return 'updated'
  } catch (err) {
    console.error(chalk.red(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`))
    return 'failed'
  }
}

// ── search / doctor ────────────────────────────────────────────────────

async function cliSearch(args: string[]): Promise<number> {
  const kw = args.join(' ').trim().toLowerCase()
  if (!kw) {
    console.error('Usage: xc plugin search <keyword>')
    return 1
  }
  const marketplaces = await readAllCachedMarketplaces()
  if (marketplaces.length === 0) {
    // 区分“你还没有订阅任何 marketplace”和“你已订阅但缓存的索引文件缺失 /
    // 不可读”。修复方式不同——前者需要 `add`，后者需要 `refresh`。
    const km = await readKnownMarketplaces()
    if (km.marketplaces.length === 0) {
      console.error('No subscribed marketplaces. Add one with `xc plugin marketplace add`.')
    } else {
      const names = km.marketplaces.map((m) => m.name).join(', ')
      console.error(
        `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`xc plugin marketplace refresh\` to fetch.`,
      )
    }
    return 1
  }
  const matches = searchMarketplacePlugins(marketplaces, kw)
  if (matches.length === 0) {
    console.log(`No plugins matching '${kw}'.`)
    return 0
  }
  console.log(`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`)
  for (const m of matches) {
    const tag = m.verified ? ' [verified]' : ''
    console.log(`  ${m.name}@${m.marketplace}${tag}`)
    if (m.description) console.log(`    ${m.description}`)
  }
  return 0
}

async function cliDoctor(): Promise<number> {
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const errors = load.registry.loadErrors()
  console.log('Plugin doctor')
  console.log()
  console.log(`  Total loaded: ${all.length}`)
  console.log(`  Enabled:      ${all.filter((p) => p.enabled).length}`)
  console.log(`  Disabled:     ${all.filter((p) => !p.enabled).length}`)
  console.log(`  Load errors:  ${errors.length}`)
  if (errors.length > 0) {
    console.log()
    console.log('Errors:')
    for (const e of errors) {
      console.log(`  - ${e.id ?? '(unknown)'} at ${e.path}`)
      console.log(`    ${e.message}`)
    }
  }
  console.log()
  console.log('For deeper diagnostics, set DEBUG_STDOUT=1 and check ~/.x-code/logs/debug.log')
  return errors.length > 0 ? 1 : 0
}

// ── marketplace ─────────────────────────────────────────────────────────

async function cliMarketplace(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  if (sub === '' || sub === 'list') {
    const km = await readKnownMarketplaces()
    if (km.marketplaces.length === 0) {
      console.log('No marketplaces subscribed.')
      return 0
    }
    console.log(`Subscribed marketplaces (${km.marketplaces.length}):`)
    const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
    for (const m of km.marketplaces) {
      const tag = m.reservedName ? ' [official]' : ''
      console.log(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
    }
    return 0
  }
  if (sub === 'add') {
    const name = rest[0]
    const source = rest.slice(1).join(' ')
    if (!name || !source) {
      console.error('Usage: xc plugin marketplace add <name> <source>')
      return 1
    }
    try {
      await addKnownMarketplace({ name, source })
      console.log(chalk.green(`Subscribed to ${name} (${source})`))
      console.log(`Run 'xc plugin marketplace refresh ${name}' to fetch its index.`)
      return 0
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)))
      return 1
    }
  }
  if (sub === 'remove') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace remove <name>')
      return 1
    }
    const result = await removeKnownMarketplace(name)
    if (result === 'noop') {
      console.error(`No marketplace '${name}' subscribed.`)
      return 1
    }
    console.log(chalk.green(`Unsubscribed from ${name}.`))
    return 0
  }
  if (sub === 'refresh') {
    const km = await readKnownMarketplaces()
    const wanted = rest[0]
    const targets = wanted ? km.marketplaces.filter((m) => m.name === wanted) : km.marketplaces
    if (targets.length === 0) {
      console.error(wanted ? `No marketplace '${wanted}' subscribed.` : 'No marketplaces subscribed.')
      return 1
    }
    let hadError = false
    for (const t of targets) {
      try {
        const m = await fetchMarketplace(t)
        console.log(chalk.green(`✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`))
      } catch (err) {
        hadError = true
        console.error(chalk.red(`✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    return hadError ? 1 : 0
  }
  if (sub === 'info') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace info <name>')
      return 1
    }
    const all = await readAllCachedMarketplaces()
    const m = all.find((x) => x.name === name)
    if (!m) {
      console.error(`No cached index for '${name}'. Run 'xc plugin marketplace refresh ${name}' first.`)
      return 1
    }
    console.log(`${m.displayName ?? m.name} (${m.name})`)
    if (m.upstreamName) console.log(`Upstream name: ${m.upstreamName}`)
    if (m.description) console.log(m.description)
    if (m.owner?.name) console.log(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
    console.log()
    console.log(`${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
    for (const p of m.plugins) {
      const ver = p.verified ? ' [verified]' : ''
      const cat = p.category ? ` (${p.category})` : ''
      console.log(`  ${p.name}${ver}${cat}`)
      if (p.description) console.log(`    ${p.description}`)
    }
    return 0
  }
  console.error('Usage: xc plugin marketplace <list|add|remove|refresh|info> [args...]')
  return 1
}
