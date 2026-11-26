/**
 * 运行时引导：工作区解析、provider 发现、插件、
 * 注册表，以及每轮共享的基础 AgentOptions。与 CLI 启动的
 * 顺序一致，但这里不注入任何 UI 回调。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HookBus,
  HookRegistry,
  MemoryService,
  PROVIDERS,
  buildPluginIntegration,
  createCommandRegistry,
  createModelRegistry,
  createSkillRegistry,
  createSubAgentRegistry,
  emptyPluginRegistry,
  ensureDefaultMarketplaces,
  getAvailableProviders,
  getContextWindow,
  getProviderModels,
  initializeOpenAIAuthContext,
  loadAllPlugins,
  loadLocalHookConfigs,
  loadUserConfig,
  refreshDynamicProviderModels,
  reloadPersistedRules,
  resolveModelId,
  resolveStreamConfig,
  setContextWindowOverride,
  setModelContextWindowOverrides,
  setPricingOverrides,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  CommandRegistry,
  LanguageModel,
  McpServerConfig,
  PluginRegistry,
  SkillRegistry,
  SubAgentRegistry,
  UserConfig,
} from '@x-code-cli/core'
import { setShellSandbox } from '@x-code-cli/core'

import type { AppState, ModelOption, ProviderStatus } from '../shared/protocol.js'
import { applySearchProviderPreference, loadDesktopSettings } from './desktop-settings.js'
import { discoverLocalModels, withLocalModels } from './local-models.js'
import { applyStoredSecrets } from './secrets.js'
import { refreshShellEnvironment } from './shell-env.js'
import { applySkillRuntimeHints } from './skill-runtime.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const DEMO_MODEL_ID = 'demo:mock'

export interface RuntimeBootstrap {
  workspace: string
  config: UserConfig
  model: LanguageModel | null
  modelId: string
  demo: boolean
  modelRegistry: ReturnType<typeof createModelRegistry>
  baseOptions: AgentOptions
  appState: AppState
  subAgentRegistry?: SubAgentRegistry
  skillRegistry?: SkillRegistry
  commandRegistry?: CommandRegistry
  pluginRegistry: PluginRegistry
  hookBus: HookBus
  hookRegistry: HookRegistry
  memoryService: MemoryService
  pluginErrors: string[]
  skillExtraDirs: Array<{ dir: string; pluginId: string }>
  agentExtraDirs: Array<{ dir: string; pluginId: string }>
  commandExtraDirs: Array<{ dir: string; pluginId: string; pluginRoot: string }>
  mcpExtraServers: Record<string, McpServerConfig>
}

/** 优先使用显式工作区，否则向上走到最近的项目标记，
 *  这样从 `packages/desktop` 启动时仍能看到仓库根。 */
export function resolveWorkspace(): string {
  const explicit = process.env.X_CODE_WORKSPACE?.trim()
  if (explicit) return path.resolve(explicit)

  const start = process.cwd()
  let dir = start
  while (true) {
    const markers = ['pnpm-workspace.yaml', 'AGENTS.md', '.git']
    if (markers.some((marker) => fs.existsSync(path.join(dir, marker)))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start === path.parse(start).root ? os.homedir() : start
}

/** 与 CLI 相同约定：从工作区向上加载最近的 `.env`。
 *  已有进程环境变量保持优先。 */
function loadWorkspaceEnv(workspace: string): void {
  let dir = workspace
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // 忽略格式损坏的 .env 文件。
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

function buildModels(available: string[], activeModelId: string | null): ModelOption[] {
  const catalog = getProviderModels()
  const models: ModelOption[] = []
  for (const provider of PROVIDERS) {
    if (!available.includes(provider.name)) continue
    for (const model of catalog[provider.name] ?? provider.models) {
      models.push({
        id: model.id,
        label: model.label,
        provider: provider.name,
        description: model.description,
        contextWindow: getContextWindow(model.id),
      })
    }
  }
  if (activeModelId && activeModelId !== DEMO_MODEL_ID && !models.some((model) => model.id === activeModelId)) {
    models.unshift({
      id: activeModelId,
      label: activeModelId,
      provider: activeModelId.split(':')[0] ?? 'custom',
      description: '当前配置的模型',
      contextWindow: getContextWindow(activeModelId),
    })
  }
  return models
}

function pickModelId(available: string[]): string | null {
  const configured = resolveModelId()
  if (configured) {
    const provider = configured.split(':')[0]
    if (available.includes(provider)) return configured
  }
  const fallback = PROVIDERS.find((provider) => available.includes(provider.name))
  return fallback?.defaultModel ?? null
}

export async function bootstrapRuntime(workspaceOverride?: string): Promise<RuntimeBootstrap> {
  const workspace = workspaceOverride ? path.resolve(workspaceOverride) : resolveWorkspace()
  try {
    process.chdir(workspace)
  } catch {
    // 工作区不可访问时保持启动时的 cwd。
  }
  loadWorkspaceEnv(workspace)
  // 更早会话中「不再询问」的批准存在项目里。
  reloadPersistedRules(workspace)
  // 密钥/设置读取失败不应该让整个启动 reject：调用方只会看到一个没有上下文
  // 的原始异常。逐项兜底并记录。
  await applyStoredSecrets().catch((error: unknown) => {
    console.error('[bootstrap] apply stored secrets failed:', errorMessage(error))
  })
  // 拾取应用启动后用户安装的工具。存储的
  // secret 和 .env 值优先于 shell 快照。必须放在 provider 发现之前：只在登录
  // shell 里存在的 key/PATH（首次启动、未存 secret）否则会被漏掉。
  const shellEnv = await refreshShellEnvironment().catch((error: unknown) => {
    console.error('[bootstrap] refresh shell environment failed:', errorMessage(error))
    return null
  })
  if (shellEnv?.error && shellEnv.error !== 'disabled') {
    console.error(`[bootstrap] shell environment: ${shellEnv.error}`)
  }
  const discovery = await refreshDynamicProviderModels({ timeoutMs: 30_000 }).catch((error: unknown) => {
    console.error('[bootstrap] provider model discovery failed:', errorMessage(error))
    return { refreshed: [] as string[], errors: [] as Array<{ provider: string; message: string }> }
  })
  console.error(
    `[provider-models] refreshed=${discovery.refreshed.join(',') || 'none'} errors=${
      discovery.errors.map((error) => `${error.provider}: ${error.message}`).join(' | ') || 'none'
    }`,
  )
  const desktopSettings = loadDesktopSettings()
  applySearchProviderPreference(desktopSettings.searchProvider)
  setShellSandbox({
    // 显式配置优先，平台只决定默认值：用户主动打开时不该被平台判断静默忽略。
    enabled:
      desktopSettings.shellSandbox === true ||
      (desktopSettings.shellSandbox === undefined && process.platform === 'darwin'),
    workspace,
    allowNetwork: desktopSettings.shellSandboxNetwork === true,
    includeExtensions: desktopSettings.shellSandboxExtensions === true,
  })

  initializeOpenAIAuthContext()
  const config = (() => {
    try {
      return loadUserConfig()
    } catch (error) {
      console.error('[bootstrap] load user config failed:', errorMessage(error))
      return {} as ReturnType<typeof loadUserConfig>
    }
  })()
  setContextWindowOverride(config.contextWindow)
  setPricingOverrides(config.pricing)
  setModelContextWindowOverrides(desktopSettings.contextWindowOverrides)

  const available = getAvailableProviders()
  const providers: ProviderStatus[] = PROVIDERS.map((provider) => ({
    name: provider.name,
    envKey: provider.envKey,
    keyUrl: provider.keyUrl,
    available: available.includes(provider.name),
  }))
  if (available.includes('custom')) {
    providers.push({
      name: 'custom',
      envKey: 'OPENAI_COMPATIBLE_API_KEY',
      keyUrl: '',
      available: true,
    })
  }

  const localModels = await discoverLocalModels()
  const modelRegistry = withLocalModels(createModelRegistry())
  let modelId = pickModelId(available)
  let model: LanguageModel | null = null
  let demo = true

  if (modelId) {
    try {
      model = modelRegistry.languageModel(modelId as `${string}:${string}`)
      demo = false
    } catch {
      model = null
      modelId = null
    }
  }

  const models = buildModels(available, modelId)
  for (const local of localModels) {
    if (models.some((model) => model.id === local.id)) continue
    models.push({
      id: local.id,
      label: local.label,
      provider: local.provider,
      description: local.description,
      contextWindow: getContextWindow(local.id),
    })
  }
  const customModelId = loadDesktopSettings().customModelId?.trim()
  if (customModelId && available.includes('custom')) {
    const id = customModelId.startsWith('custom:') ? customModelId : `custom:${customModelId}`
    if (!models.some((model) => model.id === id)) {
      models.unshift({
        id,
        label: customModelId.replace(/^custom:/, ''),
        provider: 'custom',
        description: '自定义 OpenAI 兼容模型',
        contextWindow: getContextWindow(id),
      })
    }
  }
  if (!modelId || !model) {
    modelId = DEMO_MODEL_ID
    demo = true
    models.unshift({
      id: DEMO_MODEL_ID,
      label: '演示模型',
      provider: 'demo',
      description: '未检测到 API Key。在设置中配置后即可使用真实模型。',
      contextWindow: getContextWindow(DEMO_MODEL_ID),
      demo: true,
    })
  }

  const memoryService = new MemoryService({
    // 用全新的注册表解析，使启动后保存的 key 生效。
    resolveModel: (id) => withLocalModels(createModelRegistry()).languageModel(id as `${string}:${string}`),
  })
  memoryService.setActiveModelId(modelId)

  await ensureDefaultMarketplaces().catch(() => undefined)
  // 失败原因必须进入 pluginErrors，否则界面上既看不到插件、也看不到为什么。
  const pluginLoadErrors: string[] = []
  const pluginLoad = await loadAllPlugins({ cwd: workspace }).catch((error: unknown) => {
    pluginLoadErrors.push(`plugins: ${errorMessage(error)}`)
    return null
  })
  const pluginRegistry = pluginLoad?.registry ?? emptyPluginRegistry()
  const integration = pluginLoad ? await buildPluginIntegration(pluginLoad).catch(() => null) : null
  const skillExtraDirs = integration?.skillsDirs ?? []
  const agentExtraDirs = integration?.agentsDirs ?? []
  const commandExtraDirs = integration?.commandsDirs ?? []
  const mcpExtraServers = integration?.mcpServers ?? {}
  // 项目 hooks 会执行任意命令；只为用户显式信任的工作区
  // （设置 → Hooks）加载它们。
  const allowProjectHooks = (desktopSettings.trustedProjectHooks ?? []).includes(path.resolve(workspace))
  const localHooks = loadLocalHookConfigs(workspace, { allowProjectHooks })
  const hookRegistry = new HookRegistry([...(integration?.hookRegistry.list() ?? []), ...localHooks.registered])
  const hookBus = new HookBus(hookRegistry)
  const pluginErrors = [
    ...pluginLoadErrors,
    ...pluginRegistry.loadErrors().map((error) => `${error.id ?? error.path ?? 'plugin'}: ${error.message}`),
    ...(integration?.mcpErrors ?? []).map((error) => `MCP ${error.pluginId}: ${error.message}`),
    ...(integration?.hookErrors ?? []).map((error) => `Hook ${error.pluginId}: ${error.message}`),
    ...localHooks.errors,
  ]

  const [subAgentRegistry, skillRegistry, commandRegistry] = await Promise.all([
    createSubAgentRegistry({ extraDirs: agentExtraDirs }).catch(() => undefined),
    createSkillRegistry({ extraDirs: skillExtraDirs }).catch(() => undefined),
    createCommandRegistry({ extraDirs: commandExtraDirs }).catch(() => undefined),
  ])
  if (skillRegistry) applySkillRuntimeHints(skillRegistry)

  const streamConfig = resolveStreamConfig(config)
  const baseOptions: AgentOptions = {
    modelId,
    trustMode: false,
    printMode: false,
    ...(config.budget ? { budget: config.budget } : {}),
    ...(config.fallbackModels && config.fallbackModels.length > 0 ? { fallbackModelIds: config.fallbackModels } : {}),
    thinking: config.thinking ?? false,
    toolProfile: config.experimentalToolProfile === 'standard' ? 'standard' : 'full',
    browserVisualCheckEnabled: config.browser?.visualCheck !== false,
    permissionMode: 'default',
    streamMaxRetries: streamConfig.maxRetries,
    streamIdleTimeoutMs: streamConfig.idleTimeoutMs,
    modelRegistry,
    subAgentRegistry,
    skillRegistry,
    commandRegistry,
    pluginRegistry,
    hookBus,
    memoryService,
  }

  const appState: AppState = {
    workspace,
    models,
    providers,
    activeModelId: modelId,
    demo,
    thinking: config.thinking ?? false,
    permissionMode: 'default',
    taskMode: 'coding',
  }

  return {
    workspace,
    config,
    model,
    modelId,
    demo,
    modelRegistry,
    baseOptions,
    appState,
    subAgentRegistry,
    skillRegistry,
    commandRegistry,
    pluginRegistry,
    hookBus,
    hookRegistry,
    memoryService,
    pluginErrors,
    skillExtraDirs,
    agentExtraDirs,
    commandExtraDirs,
    mcpExtraServers,
  }
}
