// @x-code-cli/cli — CLI 入口点
import { Chalk } from 'chalk'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  McpPermissionStore,
  MemoryService,
  PROVIDER_DETECTION_ORDER,
  buildPluginIntegration,
  createCommandRegistry,
  createModelRegistry,
  createOAuthProviderFactory,
  createSkillRegistry,
  createSubAgentRegistry,
  debugLog,
  debugLogIntegrationDiagnostics,
  emptyHookBus,
  ensureDefaultMarketplaces,
  forceTerminateManagedShellsSync,
  getAvailableProviders,
  getEnvVarName,
  getTokenStorage,
  initializeOpenAIAuthContext,
  listSessions,
  loadAllPlugins,
  loadMcpConfigsFromDisk,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  resolveModelId,
  resolveStreamConfig,
  resolveWebSearchProvider,
  setContextWindowOverride,
  setPluginDebugMirror,
  shutdownBrowserMcp,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  HookBus,
  LoadedSession,
  McpRegistry,
  PeerService,
  TerminationReason,
} from '@x-code-cli/core'

import { startApp } from './app.js'
import { runAuthCli, shouldEnterProductAfterAuth } from './auth-cli.js'
import { startChatGPTModelPreload } from './chatgpt-model-preload.js'
import { getCleanupController } from './cleanup-controller.js'
import { parseCliArgs } from './cli-args.js'
import { restoreInvocationCwd } from './launch-cwd.js'
import { startCliPeerService } from './peer-lifecycle.js'
import { runPluginCli } from './plugins/cli.js'
import { runShutdownPhases } from './shutdown-coordinator.js'
import { checkForUpdate, printNoApiKeyMessage, printNoWebSearchKeyHint, printResumeHint } from './startup-prints.js'
import { installTerminalStreamErrorGuards } from './terminal-stream-errors.js'
import { getSessionExitInfo } from './ui/app/session-exit.js'
import { rebuildPalette } from './ui/chat-input/palette.js'
import { setShikiTheme, warmShikiEngine } from './ui/render/shiki-highlight.js'
import { setSyntaxTheme } from './ui/render/syntax-highlight.js'
import { getThemeColors, parseThemeName, setTheme } from './ui/render/theme.js'
import { VERSION } from './version.js'

restoreInvocationCwd()
installTerminalStreamErrorGuards([process.stdout, process.stderr])

// 把 AI SDK 警告路由到 debugLog，而不是让它们直接轰到 stderr。默认的
// `console.warn` 路径会绕过 ChatInput 的单元缓冲渲染——每条警告都抢走一行、
// 把输入框的分隔符顶错位，并把僵尸文本拖进 scrollback。常见来源：
// `responseFormat JSON schema is used in a compatibility mode`（DeepSeek +
// 结构化输出组合）、provider 侧的能力降级等。DEBUG_STDOUT 打开时捕获到
// ~/.x-code/logs/debug.log，否则静默丢弃。
//
// 必须在任何构造 AI SDK 调用的代码路径之前运行。放在模块顶层，这样在
// yargs 解析 argv 之前就已设置好。
;(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: unknown[]
  provider?: string
  model?: string
}) => {
  for (const warning of options.warnings) {
    debugLog('ai-sdk.warning', `${options.provider ?? '?'}/${options.model ?? '?'}: ${JSON.stringify(warning)}`)
  }
}

const chalk = new Chalk({ level: process.stderr.isTTY && !process.env.NO_COLOR ? 3 : 0 })

const MIN_NODE_VERSION = [22, 0, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: X-Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}

// ── 优雅关闭 ────────────────────────────────────────────────────────────
//
// 单条 Ctrl+C 路径：
//   waitUntilExit() → gracefulShutdown() → resetTerminal → process.exit(0)
//
// 清理过程会得到一段很短的受限排水窗口，让会话写入和子进程关闭能够完成，
// 而不会让退出无限挂起。退出时不打印 token 用量摘要——我们对比的另外四个
// CLI（claude-code、codex、gemini-cli、opencode）都不这么做，而且延迟的
// stdout flush 会让它出现在 shell 提示符之后，令用户困惑。
let shutdownInProgress = false
/** 在启动时捕获，以便 gracefulShutdown 在退出途中关闭 MCP 服务器
 *  （终止 stdio 子进程、结束 HTTP 传输）。没有它，stdio 服务器会一直
 *  存活到它们发现父进程的 stdin 已关闭——通常没问题，但显式关闭更快、
 *  更不易让人意外。 */
let mcpRegistryForShutdown: McpRegistry | null = null
let memoryServiceForShutdown: MemoryService | null = null
let peerServiceForShutdown: PeerService | null = null
/** 在启动时捕获插件 hook 总线，以便 gracefulShutdown 在进程退出前向插件
 *  hook 触发 `SessionEnd`。 */
let hookBusForShutdown: HookBus | null = null

// 双保险的终端恢复。在退出前同步运行，因此即便 Ink 的卸载部分损坏
// （例如某个 useEffect 清理抛错，或长时间会话中 raw 模式引用计数泄漏），
// 终端也仍会处于可用状态。可安全地多次调用——每条转义序列都是幂等的。
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try {
    fs.writeSync(1, '\x1b[0m') // 重置 SGR（颜色、加粗、反显等），让 shell 提示符不再带样式
    fs.writeSync(1, '\x1b[?2004l') // 关闭括号粘贴模式
    fs.writeSync(1, '\x1b[?25h') // 显示光标
    fs.writeSync(1, '\x1b[?1049l') // 退出备用屏幕（如果曾进入过）
    fs.writeSync(1, '\r\n') // 让 shell 提示符落在一个全新行上
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // 终端可能已经关闭（SIGHUP、SSH 断开）——忽略。
  }
}

async function gracefulShutdown(exitCode: number, reason: TerminationReason = 'cli-shutdown'): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  const controller = getCleanupController()
  const finalizers: Array<() => Promise<unknown>> = []
  if (!controller && memoryServiceForShutdown) {
    finalizers.push(() => memoryServiceForShutdown!.shutdown(memoryServiceForShutdown!.getConfig().drainTimeoutMs))
  }

  if (mcpRegistryForShutdown) {
    finalizers.push(() => mcpRegistryForShutdown!.shutdown())
  }
  if (peerServiceForShutdown) {
    finalizers.push(() => peerServiceForShutdown!.shutdown())
  }
  finalizers.push(() => shutdownBrowserMcp())

  if (hookBusForShutdown?.has('SessionEnd')) {
    const peerInfluenced = getSessionExitInfo()?.peerInfluenced === true
    finalizers.push(() =>
      hookBusForShutdown!.emit({
        name: 'SessionEnd',
        session: { cwd: process.cwd(), modelId: '' },
        ...(peerInfluenced ? { authority: { source: 'peer', peerTainted: true } } : {}),
      }),
    )
  }

  const shutdown = await runShutdownPhases({
    controller,
    reason,
    ordinaryFinalizers: finalizers,
  })
  if (exitCode === 0 && shutdown.emergency.requested > 0) exitCode = 1

  resetTerminal()
  // 在 resetTerminal 之后打印，让这一行干净地落在 shell 提示符之上——
  // 颜色已重置、raw 模式已关、光标可见。提示内容读取自同步捕获的快照
  // （由 App 通过 onSessionInfoReady 注册），因此我们不依赖仍在运行的
  // 异步清理。
  printResumeHint()
  process.exit(exitCode)
}

async function main() {
  checkNodeVersion()
  loadEnvFile()

  // 即发即忘的更新检查——查询 npm registry（带 24 小时磁盘缓存），
  // 如果有更新版本就打印一行提示。从不阻塞启动、从不抛错。对
  // --print 和非 TTY 场景会抑制。
  void checkForUpdate().catch(() => undefined)

  // 非交互式插件管理子命令。在 yargs 解析其余 argv 之前路由——否则
  // `xc plugin install ./foo` 会被当作 agent 应当响应的提示词。这一路径
  // 不挂载 Ink，执行完就退出。
  const rawArgs = hideBin(process.argv)
  if (rawArgs[0] === 'plugin') {
    const exitCode = await runPluginCli(rawArgs.slice(1))
    process.exit(exitCode)
  }
  let enteredAfterLogin = false
  if (rawArgs[0] === 'login' || rawArgs[0] === 'logout') {
    const exitCode = await runAuthCli(rawArgs)
    if (!shouldEnterProductAfterAuth(rawArgs, exitCode, !!process.stdin.isTTY, !!process.stdout.isTTY)) {
      process.exit(exitCode)
    }
    enteredAfterLogin = true
  }

  const openAIAuth = initializeOpenAIAuthContext()

  // 解析 CLI 参数
  // `xc login` 是一个引导入口点：成功完成交互式认证后，消费它的认证专用
  // 参数并继续进入产品，而不是让用户再运行一次 `xc` 命令。
  const argv = await parseCliArgs(enteredAfterLogin ? [] : rawArgs)

  const prompt = (argv._ as string[]).join(' ') || undefined

  // 检查 stdin 管道输入
  let stdinContent = ''
  if (!process.stdin.isTTY) {
    stdinContent = await readStdin()
  }
  const printMode = argv.print || !process.stdin.isTTY || !process.stdout.isTTY

  // 一旦交互式产品启动确认 ChatGPT 处于激活状态，就尽快预热订阅模型目录。
  // 这是刻意即发即忘的：/model 始终读取内存中的目录（或其内置回退），
  // 绝不能等待网络 I/O。一次全新的 /login 会在账号凭据变更后自行执行一次
  // 强制刷新。
  if (openAIAuth.mode === 'chatgpt' && !printMode) {
    startChatGPTModelPreload(openAIAuth.mode, VERSION)
  }

  const availableProviders = getAvailableProviders()

  // 如果没有配置任何 provider，显示有帮助的消息并退出
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    // 交互式启动时保留这条配置提示，这样 `pnpm dev` 不会引入包管理器噪音。
    // 打印模式面向自动化：在那里返回成功会让脚本把“什么都没运行”误当成一次
    // 已完成的 agent 任务。
    process.exit(printMode ? 1 : 0)
  }

  // 解析模型
  let modelId = resolveModelId(argv.model)
  if (!modelId) {
    // 用户指定了一个其 provider 没有密钥的模型
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      process.exit(1)
    } else {
      printNoApiKeyMessage()
      process.exit(0)
    }
  }

  // 防范过期模型 id——其 provider 未在本次启动中注册。常见于用户删除了某个
  // 环境变量密钥，但 config.json 仍指向它，或某个 provider 被整体从构建中
  // 移除（例如功能回退后的 kimicode）。否则 registry 会在 `languageModel()`
  // 抛出 NoSuchProviderError，并在 UI 挂载前就致命退出。对于显式的
  // `--model` 我们仍然硬性失败（用户意图明确）；对于持久化 / 智能默认 id，
  // 则回退到第一个可用 provider，让 CLI 保持可用。
  const requestedProvider = modelId.split(':')[0]
  if (!availableProviders.includes(requestedProvider)) {
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    if (argv.model) {
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    const fallback = PROVIDER_DETECTION_ORDER.find(({ defaultModel }) =>
      availableProviders.includes(defaultModel.split(':')[0]),
    )
    if (!fallback) {
      // 防御性处理：上面 availableProviders 已非空，所以一定是某种已配置的
      // 东西把我们带到这里——干净地抛出并退出。
      printNoApiKeyMessage()
      process.exit(0)
    }
    console.error(
      chalk.yellow(
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          `Falling back to '${fallback.defaultModel}'. Use /model to pick a different default.`,
      ),
    )
    modelId = fallback.defaultModel
  }

  // 应用持久化的 UI 主题。尽早执行（在 startApp 之前），这样第一行 scrollback
  // ——包括我们从恢复的会话中水合的任何包含 edit / write 工具调用的消息——
  // 就已经按用户所选主题绘制（diff 背景色 + 语法配色）。未知值（过期配置、
  // 手工编辑过的文件）静默回退到默认。所选主题同时驱动 diff 背景色（渲染时
  // 由 render-diff.ts 读取）和语法高亮配色（全局设置在 syntax-highlight 模块上）。
  {
    const t = parseThemeName(loadUserConfig().theme)
    if (t !== null) {
      setTheme(t)
      setSyntaxTheme(getThemeColors(t).syntaxPalette)
      setShikiTheme(getThemeColors(t).syntaxPalette)
      rebuildPalette()
    }
  }

  // 在后台预热 shiki 引擎（异步加载 grammar/主题）。在它报告就绪之前，
  // 所有高亮入口都回退到自研的正则高亮器，因此这绝不阻塞启动或渲染。
  warmShikiEngine()

  // 创建 registry 并获取模型
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)
  const memoryService = new MemoryService({
    // 认证状态可能在运行中的产品里通过 /login 或 /logout 改变，因此当内存
    // worker 启动后续后台任务时，要针对一个全新的 provider registry 解析。
    resolveModel: (id) => createModelRegistry().languageModel(id as `${string}:${string}`),
  })
  memoryServiceForShutdown = memoryService
  memoryService.setActiveModelId(modelId)
  await memoryService.initialize(process.cwd())

  // --plugin-debug / XC_PLUGIN_DEBUG=1：把 plugin/hook/marketplace 的
  // debugLog 面包屑镜像到 stderr，这样无需 tail ~/.x-code/logs/debug.log
  // 就能实时看到。在 ensureDefaultMarketplaces 之前安装，让首次运行的
  // subscribe 消息也能显示。作为 debugLog 上的全局 hook 实现，而非新建一个
  // logger——让每个现有调用点自动生效，避免两条并行的日志路径。
  if (argv['plugin-debug'] || process.env.XC_PLUGIN_DEBUG === '1') {
    setPluginDebugMirror(true)
  }

  // 确保默认的 `anthropic-marketplace` 订阅存在。不相关的订阅会被保留；
  // 移除默认订阅只会持续到下一次启动。在 loadAllPlugins 之前执行，这样
  // 首次运行就能看到填充好的 marketplace 列表。
  if (argv.plugins !== false) {
    await ensureDefaultMarketplaces().catch((err) => debugLog('plugins.ensure-defaults-failed', String(err)))
  }

  // 插件必须在 skill / sub-agent / mcp registry 之前加载，这样它们的贡献
  // 才能被折叠进每个 registry。`--no-plugins` 会短路整条链。我们以与下方
  // `[mcp] config error in ...` 相同的风格把非致命加载错误暴露到 stderr——
  // 一个损坏的插件绝不会阻塞其他插件。详细诊断（冲突、不支持的命令、hook
  // 错误）通过 debugLogIntegrationDiagnostics 写入 debug.log，供
  // `/plugin doctor` 展示。
  const pluginLoad = await loadAllPlugins({ cwd: process.cwd(), disabled: argv.plugins === false })
  for (const e of pluginLoad.registry.loadErrors()) {
    console.error(chalk.yellow(`[plugin] ${e.id ?? e.path}: ${e.message}`))
  }
  const pluginIntegration = await buildPluginIntegration(pluginLoad)
  debugLogIntegrationDiagnostics(pluginIntegration)
  if (pluginIntegration.mcpErrors.length > 0) {
    for (const e of pluginIntegration.mcpErrors) {
      console.error(chalk.yellow(`[plugin] ${e.pluginId}: ${e.message}`))
    }
  }

  const subAgentRegistry = await createSubAgentRegistry({ extraDirs: pluginIntegration.agentsDirs })
  const skillRegistry = await createSkillRegistry({ extraDirs: pluginIntegration.skillsDirs })
  const commandRegistry = await createCommandRegistry({ extraDirs: pluginIntegration.commandsDirs })

  // MCP：阶段 1——读取配置 + 运行信任对话框。这一步很快（磁盘读取 + 可选的
  // readline 提示），且必须在 Ink 挂载前发生，因为信任对话框在 stdin 上使用
  // 原始 readline。真正的服务器连接推迟到阶段 2（渲染后、异步），这样即便
  // 远程 HTTP MCP 服务器很慢，UI 也能立即出现。
  const tokenStorage = getTokenStorage()
  const mcpPermissionStore = new McpPermissionStore()
  const mcpLoadResult = await loadMcpConfigsFromDisk({
    cwd: process.cwd(),
    extraServers: pluginIntegration.mcpServers,
    askUser: (question, opts) => askInTerminal(question, opts),
    oauthProviderFor: createOAuthProviderFactory(tokenStorage, (server, url) => {
      debugLog('mcp.open-browser', `${server}: ${url}`)
    }),
    onExitRequested: () => process.exit(0),
  })
  mcpRegistryForShutdown = mcpLoadResult.registry
  // 设置 --no-hooks 时不要触发 SessionEnd hook——用户已明确选择本会话
  // 跳过所有 hook 执行。
  hookBusForShutdown = argv.hooks === false ? null : pluginIntegration.hookBus

  if (mcpLoadResult.configErrors.length > 0) {
    for (const e of mcpLoadResult.configErrors) {
      console.error(chalk.yellow(`[mcp] config error in ${e.name}: ${e.message}`))
    }
  }
  if (mcpLoadResult.projectSkipped) {
    console.error(chalk.yellow(`[mcp] Project-level MCP servers skipped (not trusted).`))
  }
  // 预热 always-allow 列表，让第一次工具调用不必承担文件读取延迟。
  await mcpPermissionStore.preload()

  const userConfig = loadUserConfig()
  setContextWindowOverride(userConfig.contextWindow)
  const streamConfig = resolveStreamConfig(userConfig)
  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    printMode,
    maxTurns: argv['max-turns'],
    streamMaxRetries: streamConfig.maxRetries,
    streamIdleTimeoutMs: streamConfig.idleTimeoutMs,
    // 从磁盘读取持久化的 /thinking 开关。默认 false，这样在无配置的机器上
    // 启动会匹配该功能引入之前的基线（provider 默认的思考行为，没有意外的
    // 延迟 / 成本跳变）。App.tsx 里的 /thinking 命令通过 useAgent 的
    // setThinking 无需重启即可热切换此标志。
    thinking: userConfig.thinking ?? false,
    toolProfile: userConfig.experimentalToolProfile === 'standard' ? 'standard' : 'full',
    browserVisualCheckEnabled: userConfig.browser?.visualCheck !== false,
    // 计划模式是会话作用域的（与 Claude Code 一致）——只有 `--plan` CLI 标志
    // 在启动时启用。会话中途通过 /plan 切换不会持久化，因此每次新启动都从
    // 'default' 开始，除非显式请求。
    permissionMode: argv.plan ? 'plan' : 'default',
    modelRegistry: providerRegistry,
    memoryService,
    subAgentRegistry,
    skillRegistry,
    mcpRegistry: mcpLoadResult.registry,
    mcpPermissionStore,
    // --no-plugins：让 pluginRegistry 保持 undefined，这样 /plugin 斜杠命令
    // 可以渲染“Plugin system is disabled...”，而不是落到通用的空状态
    // （“No plugins installed”）。loadAllPlugins 传 disabled:true 仍会返回
    // 一个（非 null 的）空 registry，因此我们必须在接线点这里丢弃它，而不是
    // 依赖加载结果本身。
    pluginRegistry: argv.plugins === false ? undefined : pluginLoad.registry,
    commandRegistry,
    // --no-hooks：换成空总线，让 emit 点变成空操作，而无需触碰插件加载的
    // 其余部分（skill / agent / mcp 仍会注册，只是没有东西监听生命周期事件）。
    hookBus: argv.hooks === false ? emptyHookBus() : pluginIntegration.hookBus,
  }

  // 插件 SessionStart hook。在 CLI 启动时触发，这样 hook 可以在用户开始交互
  // 之前做设置（环境校验、上下文预热等）。此前它位于 agentLoop 的首次调用
  // 分支中，这意味着一次没有任何用户消息就结束的会话（例如用户只运行斜杠
  // 命令然后退出）永远不会触发 SessionStart，而确实触发的会话又会看到它
  // 落后于第一个提示词。与 `gracefulShutdown` 中的 SessionEnd 触发对称。
  // 即发即忘——一个缓慢的 hook 绝不能阻塞启动。
  if (options.hookBus?.has('SessionStart')) {
    options.hookBus
      .emit({ name: 'SessionStart', session: { cwd: process.cwd(), modelId } })
      .catch((err) => debugLog('agent.hook-session-start-error', String(err)))
  }

  // 恢复 / 继续。三个恢复入口点：
  //   1. `--continue` (-c)：在这里同步加载最近的会话，无选择器。快速、
  //      肌肉记忆式的继续。
  //   2. `--resume <id>`：按 id / slug / 文件名前缀查找会话并直接加载。
  //      我们打印的退出后提示（"Resume: xc --resume <id>"）会回流到这个
  //      分支。
  //   3. `--resume`（无值）：通过 resumeIntent='pick' 推迟到 Ink 内的
  //      选择器，让用户可以浏览。
  // 两者都设置时 --continue 优先，与 CC 一致。
  let initialSession: LoadedSession | null = null
  let resumeIntent: 'pick' | null = null
  if (argv.continue) {
    const latest = await pickLatestSession()
    if (!latest) {
      console.error('Note: --continue specified but no past sessions found in this project. Starting a fresh session.')
    } else {
      const loaded = await loadSession(latest.filePath)
      if (loaded) initialSession = loaded
    }
  } else if (typeof argv.resume === 'string') {
    if (argv.resume === '') {
      resumeIntent = 'pick'
    } else {
      const filePath = await findSessionFile(argv.resume)
      if (!filePath) {
        console.error(
          `Error: no session found matching "${argv.resume}". Run \`xc --resume\` to pick from the list, or \`xc -c\` for the most recent.`,
        )
        process.exit(1)
      }
      const loaded = await loadSession(filePath)
      if (!loaded) {
        console.error(`Error: failed to load session at ${filePath}. The file may be corrupted.`)
        process.exit(1)
      }
      initialSession = loaded
    }
  }

  // 把提示词与 stdin 合并
  const fullPrompt = [stdinContent, prompt].filter(Boolean).join('\n\n')

  // 打印模式：完全绕过 Ink。挂载 TUI 会引用原始 stdin，让 Node 事件循环在
  // 已排队的卸载之后仍保持存活——这就是 -p 过去会一直挂到按键为止的原因。
  // 参见 packages/cli/src/print.ts。
  if (printMode) {
    if (!fullPrompt) {
      console.error('Error: -p / --print requires a prompt (as an argument or via stdin).')
      process.exit(1)
    }
    // MCP 阶段 2（阻塞）：打印模式是单轮的——所有工具必须在 agentLoop 运行
    // 前可用。
    await mcpLoadResult.registry.connectAll()
    const { runPrintMode } = await import('./print.js')
    const code = await runPrintMode(model, options, fullPrompt, initialSession)
    resetTerminal()
    process.exit(code)
  }

  // 提醒：WebSearch 需要密钥。只打印一次，在 Ink 接管之前，这样提示会落在
  // TUI 上方的 scrollback 中。非致命——WebFetch 无需密钥仍可用，而且该工具
  // 本身在未配置密钥被调用时会返回详细错误。DeepSeek 模型用户无需额外密钥：
  // 该工具会回退到 DeepSeek 内置的服务端网页搜索。
  const forcedSearchProvider = process.env.X_CODE_WEB_SEARCH_PROVIDER?.trim()
  if (forcedSearchProvider) {
    // 该工具在调用时会报告精确错误；在启动时也暴露出来，避免把写错的
    // override 误当成“没有密钥”。
    if (!resolveWebSearchProvider(modelId.split(':')[0])) {
      console.error(
        `Warning: X_CODE_WEB_SEARCH_PROVIDER=${forcedSearchProvider} is not usable ` +
          '(unknown provider id or its API key is missing).',
      )
    }
  } else if (!resolveWebSearchProvider(modelId.split(':')[0])) {
    printNoWebSearchKeyHint()
  }

  const peerService = await startCliPeerService({
    userConfig: userConfig.peerMessaging,
    printMode: false,
    name: argv.name,
    cwd: process.cwd(),
    getPermissionClass: () => (options.trustMode ? 'bypass' : 'prompted'),
  })
  if (peerService) {
    peerServiceForShutdown = peerService
    options.peerService = peerService
  }

  // 启动应用——waitUntilExit 在 Ink 卸载（包括 Ctrl+C）时 resolve
  const waitUntilExit = startApp(model, options, fullPrompt || undefined, {
    initialSession,
    resumeIntent,
  })

  // MCP 阶段 2（非阻塞）：在后台发起连接，同时用户立即看到提示词。onReady
  // 使系统提示词缓存失效，让下一轮能拿到新发现的 MCP 工具。
  mcpLoadResult.registry
    .connectAll(() => {
      options.onMcpReady?.()
    })
    .catch((err) => debugLog('mcp.connectAll-error', String(err)))

  await waitUntilExit()

  // 正常退出路径（包括 Ctrl+C，它会先卸载 Ink）
  await gracefulShutdown(0)
}

/** 把用户提供的会话查找键解析成会话 jsonl 路径。接受用户可能从我们打印的
 *  退出后提示中粘贴过来的同样几种形式：
 *    - 裸 sessionId（`20260101-120000-000`）
 *    - fork 名称（`experiment-a`，通过 `/fork <name>` 分配）
 *    - 旧版 slug（`fix-login`）
 *    - 旧版文件名主干（`fix-login-20260101-120000-000`）
 *  优先精确匹配；如果没有精确匹配，则回退到对 sessionId 的前缀匹配
 *  （长度足以消除歧义）。返回第一个匹配项的文件路径，最新优先，否则 null。 */
async function findSessionFile(input: string): Promise<string | null> {
  const sessions = await listSessions()
  for (const s of sessions) {
    if (s.sessionId === input) return s.filePath
    if (s.taskSlug && s.taskSlug === input) return s.filePath
    if (s.taskSlug && `${s.taskSlug}-${s.sessionId}` === input) return s.filePath
    // 会话按最新优先排列，因此重名会解析到最新那个。
    if (s.name && s.name === input) return s.filePath
  }
  if (input.length >= 8) {
    for (const s of sessions) {
      if (s.sessionId.startsWith(input)) return s.filePath
    }
  }
  return null
}

/** 从 cwd 加载 .env 文件（向上查找，类似 dotenv 的约定） */
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // 忽略解析错误
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // 已到达根目录
    dir = parent
  }
}

/** 启动期间、Ink 挂载前使用的纯终端提示。
 *  目前唯一的调用方是 MCP 项目级信任对话框——loader.ts 把它的 `askUser`
 *  回调交给一个任意的选项列表，并期望返回其中一个选项的 label。
 *
 *  当 stdin 不是 TTY（管道输入、CI、`--print` 模式）时会优雅回退：如果存在
 *  label 看起来像 "skip" 的选项就返回它，否则返回第二个选项（loader 的约定
 *  是索引 1 == 安全默认）。这保证我们绝不会阻塞在等待永远不会到来的输入上。 */
async function askInTerminal(
  question: string,
  options: Array<{ label: string; description: string }>,
): Promise<string> {
  const safeDefault = options.find((o) => /skip/i.test(o.label))?.label ?? options[1]?.label ?? options[0]?.label ?? ''

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return safeDefault
  }

  const readline = await import('node:readline/promises')

  // 渲染到 stderr，让提示正文与其他 CLI 状态消息落在同一条流上；这样如果
  // 有人在捕获 stdout（交互式启动中很少见，但谨慎无妨），也能保持 stdout 干净。
  process.stderr.write('\n' + chalk.yellow(question) + '\n')
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    process.stderr.write(`  ${chalk.bold(`${i + 1}.`)} ${o.label} — ${chalk.gray(o.description)}\n`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`\nChoose [1-${options.length}]: `)
    const idx = parseInt(answer.trim(), 10) - 1
    if (Number.isFinite(idx) && idx >= 0 && idx < options.length) {
      return options[idx].label
    }
    return safeDefault
  } finally {
    rl.close()
  }
}

function readStdin(): Promise<string> {
  const maxBytes = 5 * 1024 * 1024
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    process.stdin.setEncoding('utf-8')

    const onData = (chunk: string): void => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxBytes) {
        cleanup()
        process.stdin.pause()
        reject(new Error('stdin input exceeds the 5 MiB safety limit'))
        return
      }
      data += chunk
    }
    const onEnd = (): void => {
      cleanup()
      resolve(data)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
  })
}

// ── 致命异常的终端恢复 ─────────────────────────────────────────────────
// 在 Node 报告致命未捕获错误前恢复终端状态。普通的 uncaughtException 处理器
// 会抑制 Node 的默认退出，并可能让进程以未知状态存活；monitor 只观察而不改变它。
process.on('uncaughtExceptionMonitor', () => {
  forceTerminateManagedShellsSync('fatal-exit', performance.now() + 500)
  resetTerminal()
})

// ── SIGINT 处理器 ──────────────────────────────────────────────────────
// 只是一个安全网：设置 exitCode=0，这样如果进程在 gracefulShutdown() 运行前
// 就退出，退出码仍是 0。第二次 Ctrl+C 时立即强制退出。
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
    // 第二次 Ctrl+C → 用户想立刻退出。跳过异步清理（gracefulShutdown 从第一次
    // 按下时就已经在运行）但始终恢复终端，让 shell 提示符可用。没有这次重置，
    // raw 模式 / 隐藏光标 / 括号粘贴模式可能泄漏到 shell 里。
    const emergency = forceTerminateManagedShellsSync('double-sigint', performance.now() + 500)
    resetTerminal()
    printResumeHint()
    process.exit(emergency.requested > 0 ? 1 : 0)
  }
  void gracefulShutdown(0, 'cli-shutdown')
})

process.on('SIGTERM', () => {
  void gracefulShutdown(128 + 15, 'cli-shutdown')
})

if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    void gracefulShutdown(128 + 1, 'sighup')
  })
}

main().catch((err) => {
  // 如果我们正在关闭（Ctrl+C 卸载了 Ink、waitUntilExit 被 reject），不要把它
  // 当成致命错误——gracefulShutdown 会处理它。
  if (sigintCount > 0 || shutdownInProgress) {
    return
  }
  console.error('Fatal error:', err)
  void gracefulShutdown(1, 'fatal-exit')
})
