// @x-code-cli/cli — /mcp 斜杠命令处理器族。
//
// 从 App.tsx 抽出来的工厂，闭包捕获注册表、权限存储、插件注册表（供 refresh
// 的 plugin-mcp 合并用）、提示缓存失效器，外加四个 UI 侧 hook
// （addCommandMessage、addCommandResult、askQuestion）。
//
// 子命令：list / tools / auth / logout / refresh / add / add-json /
// remove。Add/Remove 用 --scope=user|project；--scope project 会在下次启动时
// 自动信任该项目。
import {
  detectScope,
  getMcpConfigPath,
  getPluginMcpServersFromDisk,
  getTokenStorage,
  loadMergedConfigsFromDisk,
  parseAdd,
  parseAddJson,
  parseRemove,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  trustProject,
  writeServerToConfig,
} from '@x-code-cli/core'
import type { AgentOptions, ConfigScope, McpServerConfig } from '@x-code-cli/core'

export interface McpCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  invalidateSystemPromptCache: () => void
}

export function createMcpCommandHandler(deps: McpCommandDeps) {
  const { options, addCommandMessage, addCommandResult, askQuestion, invalidateSystemPromptCache } = deps

  /** /mcp add 和 /mcp add-json 共用的收尾：持久化服务器配置、项目作用域下
   *  自动信任，然后播报。`firstLine` 让两个子命令保留各自略有不同的成功标题。 */
  async function persistAndAnnounceNewServer(
    text: string,
    name: string,
    config: McpServerConfig,
    scope: ConfigScope,
    firstLine: (path: string) => string,
  ): Promise<void> {
    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // 项目作用域下自动信任此路径，让用户下次启动时不会撞上自己的同意对话框
    // （失败非致命——那时他们只会看到信任对话框）。
    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // 尽力而为
      }
    }

    const lines = [firstLine(written.path)]
    if (autoTrusted) lines.push('Auto-trusted this project for future launches.')
    if (scope === 'project') lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp add — 把新服务器写入 user（默认）或 project 配置。
   *
   *  不自动连接：会话中途改变工具表面会使提示缓存失效，导致下一轮 miss
   *  （OpenAI 兼容供应商的前缀缓存）。用户就绪时被告知 `/mcp refresh` 或重启
   *  ——契合设计文档「显式刷新」的理念。
   *
   *  --scope project 也会自动信任项目（运行命令的用户本身就是同意信号——
   *  没必要让他们为自己的命令在下一次启动时再确认一遍信任对话框）。clone
   *  该仓库的协作者仍照常走对话框。 */
  async function handleMcpAdd(text: string, subArgRaw: string): Promise<void> {
    const res = parseAdd(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // 在请求的作用域里做重复检查。这里刻意用 serverExists 而不是 detectScope：
    // 跨作用域的同名是允许的（user 作用域和 project 作用域的服务器可以合法地
    // 同名——比如个人版 vs 团队共享版）。只有同作用域的冲突才拦截 add。
    if (await serverExists(name, scope, process.cwd())) {
      const existing = await readServerConfig(name, scope, process.cwd())
      const summary =
        existing && typeof existing === 'object'
          ? JSON.stringify(existing, null, 2)
              .split('\n')
              .map((l) => '  ' + l)
              .join('\n')
          : '(unreadable)'
      addCommandMessage(
        text,
        [
          `Server "${name}" already exists in ${scope} scope:`,
          summary,
          '',
          `Run /mcp remove --scope ${scope} ${name} first, or pick a different name.`,
        ].join('\n'),
      )
      return
    }

    const transport = 'url' in config ? 'http' : 'stdio'
    await persistAndAnnounceNewServer(
      text,
      name,
      config,
      scope,
      (path) => `Added MCP server "${name}" (${transport}) to ${path}.`,
    )
  }

  /** /mcp add-json — 与 /mcp add 相同，但配置体直接给一个裸 JSON 对象。
   *  复杂配置装不进命令行标志（嵌套 env、多个 header、自定义 cwd 等）时的
   *  逃生口。 */
  async function handleMcpAddJson(text: string, subArgRaw: string): Promise<void> {
    const res = parseAddJson(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    if (await serverExists(name, scope, process.cwd())) {
      addCommandMessage(
        text,
        `Server "${name}" already exists in ${scope} scope. Run /mcp remove --scope ${scope} ${name} first.`,
      )
      return
    }

    await persistAndAnnounceNewServer(text, name, config, scope, (path) => `Added MCP server "${name}" to ${path}.`)
  }

  /** /mcp remove — 从 config.json 删除一个服务器。做任何破坏性操作前先问 y/N
   *  （其他竞品都跳过这步——我们保留它，因为一个拼写错误就能炸掉一条真实条目，
   *  而多按一次键的成本几乎为零）。当前会话继续以已加载的内容运行——中途断开
   *  的坏处（正在进行的工具调用会变成孤儿）大于好处（文件改动只在下次启动 /
   *  refresh 时才生效）。 */
  async function handleMcpRemove(text: string, subArgRaw: string): Promise<void> {
    const res = parseRemove(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name } = res.command
    let scope = res.command.scope

    if (!scope) {
      // 自动检测。歧义情况（两个作用域都有）强制显式指定 --scope，以免静默
      // 删掉错误的那一个。
      const detected = await detectScope(name, process.cwd())
      switch (detected.kind) {
        case 'not-found':
          addCommandMessage(text, `Server "${name}" is not in user or project config — nothing to remove.`)
          return
        case 'both':
          addCommandMessage(text, `Server "${name}" exists at both scopes. Specify --scope user or --scope project.`)
          return
        case 'user':
        case 'project':
          scope = detected.kind
          break
      }
    } else {
      // 显式作用域：先用存在性检查确认，再去打扰用户弹确认对话框。
      if (!(await serverExists(name, scope, process.cwd()))) {
        addCommandMessage(
          text,
          `Server "${name}" is not in ${scope} scope (${getMcpConfigPath(scope, process.cwd())}) — nothing to remove.`,
        )
        return
      }
    }

    const confirmAnswer = await askQuestion(
      `Remove MCP server "${name}" from ${scope} scope?\n  (${getMcpConfigPath(scope, process.cwd())})`,
      [
        { label: 'Remove', description: 'Delete this server entry. Current session unchanged.' },
        { label: 'Cancel', description: 'Keep the config as-is.' },
      ],
      { noOther: true },
    )
    if (confirmAnswer !== 'Remove') {
      addCommandMessage(text, `Cancelled — "${name}" not removed.`)
      return
    }

    let result: { path: string; removed: boolean }
    try {
      result = await removeServerFromConfig(name, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to remove "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.removed) {
      // 竞态：有人在检测与删除之间删掉了文件或条目。幂等路径——照实说明即可。
      addCommandMessage(text, `Server "${name}" was already gone from ${scope} scope.`)
      return
    }

    addCommandMessage(
      text,
      [
        `Removed "${name}" from ${scope} scope (${result.path}).`,
        'Current session unchanged — the running server (if any) keeps working until xc exits.',
        `Stored OAuth tokens (if any) kept — run /mcp logout ${name} to clear them too.`,
      ].join('\n'),
    )
  }

  async function handleMcp(text: string, arg: string): Promise<void> {
    const argTrimmed = arg.trim()
    const sub = (argTrimmed.split(/\s+/)[0] ?? '').toLowerCase()
    const subArg = argTrimmed.slice(sub.length).trim()
    const registry = options.mcpRegistry

    switch (sub) {
      case '':
      case 'list': {
        const statuses = registry?.serverStatus() ?? []
        if (statuses.length === 0) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json then restart.')
          return
        }
        const lines = ['MCP servers:']
        const namePad = Math.max(...statuses.map((s) => s.name.length), 8) + 2
        for (const s of statuses) {
          let badge = ''
          switch (s.status.kind) {
            case 'connected':
              badge = `connected — ${s.status.toolCount} tool${s.status.toolCount === 1 ? '' : 's'}, ${s.status.resourceCount} resource${s.status.resourceCount === 1 ? '' : 's'}`
              break
            case 'disabled':
              badge = 'disabled'
              break
            case 'connecting':
              badge = 'connecting…'
              break
            case 'needs_auth':
              badge = `needs auth — run /mcp auth ${s.name} to log in`
              break
            case 'failed':
              badge = `failed — ${s.status.error}`
              break
          }
          lines.push(`  ${s.name.padEnd(namePad)} ${badge}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'tools': {
        const all = registry?.list() ?? []
        const filtered = subArg ? all.filter((t) => t.serverName === subArg) : all
        if (filtered.length === 0) {
          addCommandMessage(text, subArg ? `No tools on server "${subArg}".` : 'No MCP tools available.')
          return
        }
        const lines = [subArg ? `MCP tools on ${subArg}:` : 'All MCP tools:']
        for (const t of filtered) {
          const desc = t.description ? ` — ${t.description.slice(0, 160).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`  ${t.callableName}${desc}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'auth': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp auth <server-name>')
          return
        }
        if (!registry) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json first.')
          return
        }
        const config = registry.getConfig(subArg)
        if (!config) {
          addCommandMessage(text, `Unknown MCP server: "${subArg}". Run /mcp list to see configured servers.`)
          return
        }
        if (!('url' in config) || typeof config.url !== 'string') {
          addCommandMessage(
            text,
            `MCP server "${subArg}" is a stdio server — OAuth applies to HTTP servers (those with a "url" field) only.`,
          )
          return
        }
        // 先丢弃已存 token。若用户对一台带有效 token 的服务器跑 /mcp auth，
        // 我们想要强制重新认证（对齐 Gemini CLI 语义——再跑一次 auth 表示
        // 「让我从头登录」，而不是「验证我的现有会话」）。只想清除而不重新认证的
        // 用户另有单独的 /mcp logout。
        try {
          await getTokenStorage().clear(subArg)
        } catch {
          // 尽力而为；token 存储不可写时，剩下的流程仍能继续，用户会在
          // finishAuth 尝试保存时看到真正的失败。
        }
        addCommandMessage(text, `Authenticating "${subArg}" — opening browser...`)
        try {
          const server = await registry.authenticateServer(subArg, {
            onBrowserOpen: (url) => {
              addCommandResult(`Opened ${url}\nWaiting for the authorization redirect...`)
            },
          })
          if (server.status.kind === 'connected') {
            // 工具表面可能变多了——使缓存失效，让下一轮用新可用的工具重建
            // 系统提示。
            invalidateSystemPromptCache()
            addCommandResult(
              `✓ Authenticated "${subArg}" — ${server.status.toolCount} tool${
                server.status.toolCount === 1 ? '' : 's'
              }, ${server.status.resourceCount} resource${server.status.resourceCount === 1 ? '' : 's'}`,
            )
          } else if (server.status.kind === 'needs_auth') {
            addCommandResult(`⚠ Server still needs auth. The browser flow may have been cancelled.`)
          } else if (server.status.kind === 'failed') {
            addCommandResult(`✗ Auth completed but server failed to connect: ${server.status.error}`)
          } else {
            addCommandResult(`Server is now in state: ${server.status.kind}`)
          }
        } catch (err) {
          addCommandResult(`✗ Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'logout': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp logout <server-name>')
          return
        }
        try {
          await getTokenStorage().clear(subArg)
          addCommandMessage(
            text,
            `Removed stored OAuth tokens for "${subArg}". Run /mcp auth ${subArg} to log in again.`,
          )
        } catch (err) {
          addCommandMessage(text, `Failed to clear tokens: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'refresh': {
        if (!registry) {
          addCommandMessage(text, 'No MCP registry to refresh.')
          return
        }
        addCommandMessage(text, 'Re-reading MCP config and reconnecting servers...')
        try {
          // 把插件贡献的 mcpServers 并入合并 map。没有这步，插件安装后跑的
          // `/mcp refresh` 会静默丢掉每个插件贡献的服务器，因为合并 map 只有
          // user + project 条目。该辅助函数在插件扫描失败时降级为 `{}`（记入
          // debug.log），所以只 refresh MCP 时不会因无关的插件系统小故障而失败。
          const extraServers = options.pluginRegistry ? await getPluginMcpServersFromDisk(process.cwd()) : undefined
          const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
            cwd: process.cwd(),
            askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
            extraServers,
          })
          const summary = await registry.restartAll(configs)
          invalidateSystemPromptCache()

          const parts: string[] = []
          if (summary.added.length) parts.push(`added: ${summary.added.join(', ')}`)
          if (summary.removed.length) parts.push(`removed: ${summary.removed.join(', ')}`)
          if (summary.changed.length) parts.push(`changed: ${summary.changed.join(', ')}`)
          if (summary.unchanged.length) parts.push(`reconnected: ${summary.unchanged.join(', ')}`)
          if (parts.length === 0) parts.push('no servers configured')
          const lines = [`Reloaded MCP — ${parts.join('; ')}.`]
          lines.push(`Note: next message rebuilds the system prompt, so prompt-cache will miss once.`)
          if (projectSkipped) lines.push('Project-level MCP servers were skipped (not trusted).')
          for (const e of configErrors) lines.push(`Config error in ${e.name}: ${e.message}`)
          addCommandResult(lines.join('\n'))
        } catch (err) {
          addCommandResult(`✗ Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'add':
        await handleMcpAdd(text, subArg)
        return

      case 'add-json':
        await handleMcpAddJson(text, subArg)
        return

      case 'remove':
      case 'rm':
        await handleMcpRemove(text, subArg)
        return

      default: {
        addCommandMessage(
          text,
          `Unknown subcommand: /mcp ${sub}. Available: list, tools, add, add-json, remove, auth, logout, refresh.`,
        )
        return
      }
    }
  }

  return { handleMcp }
}
