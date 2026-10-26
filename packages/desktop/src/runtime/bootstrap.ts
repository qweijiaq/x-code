/**
 * Runtime bootstrap: workspace resolution, provider discovery, plugins,
 * registries, and the base AgentOptions shared by every turn. Mirrors the
 * ordering used by the CLI startup, but injects no UI callbacks here.
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
  reloadPersistedRules,
  resolveModelId,
  resolveStreamConfig,
  setContextWindowOverride,
  setModelContextWindowOverrides,
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

/** Prefer an explicit workspace, otherwise walk up to the nearest project
 *  marker so a launch from `packages/desktop` still sees the repo root. */
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

/** Same convention as the CLI: load the nearest `.env` walking up from the
 *  workspace. Existing process env vars keep precedence. */
function loadWorkspaceEnv(workspace: string): void {
  let dir = workspace
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // Ignore malformed .env files.
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
    // Keep the launch cwd if the workspace is not accessible.
  }
  loadWorkspaceEnv(workspace)
  // "Don't ask again" approvals from earlier sessions live in the project.
  reloadPersistedRules(workspace)
  await applyStoredSecrets()
  // Pick up tools the user installed after the app was launched. Stored
  // secrets and .env values win over the shell snapshot.
  await refreshShellEnvironment()
  const desktopSettings = loadDesktopSettings()
  applySearchProviderPreference(desktopSettings.searchProvider)
  setShellSandbox({
    enabled: process.platform === 'darwin' && desktopSettings.shellSandbox !== false,
    workspace,
    allowNetwork: desktopSettings.shellSandboxNetwork === true,
    includeExtensions: desktopSettings.shellSandboxExtensions === true,
  })

  initializeOpenAIAuthContext()
  const config = loadUserConfig()
  setContextWindowOverride(config.contextWindow)
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
    // Resolve against a fresh registry so keys saved after startup work.
    resolveModel: (id) => withLocalModels(createModelRegistry()).languageModel(id as `${string}:${string}`),
  })
  memoryService.setActiveModelId(modelId)

  await ensureDefaultMarketplaces().catch(() => undefined)
  const pluginLoad = await loadAllPlugins({ cwd: workspace }).catch(() => null)
  const pluginRegistry = pluginLoad?.registry ?? emptyPluginRegistry()
  const integration = pluginLoad ? await buildPluginIntegration(pluginLoad).catch(() => null) : null
  const skillExtraDirs = integration?.skillsDirs ?? []
  const agentExtraDirs = integration?.agentsDirs ?? []
  const commandExtraDirs = integration?.commandsDirs ?? []
  const mcpExtraServers = integration?.mcpServers ?? {}
  // Project hooks execute arbitrary commands; only load them for workspaces
  // the user explicitly trusted (Settings → Hooks).
  const allowProjectHooks = (desktopSettings.trustedProjectHooks ?? []).includes(path.resolve(workspace))
  const localHooks = loadLocalHookConfigs(workspace, { allowProjectHooks })
  const hookRegistry = new HookRegistry([...(integration?.hookRegistry.list() ?? []), ...localHooks.registered])
  const hookBus = new HookBus(hookRegistry)
  const pluginErrors = [
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
