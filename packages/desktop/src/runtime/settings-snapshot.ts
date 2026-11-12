// @x-code-cli/desktop — 设置快照组装
//
// 从 AgentHost 拆出的纯组装逻辑：输入是已经解析好的注册表/选项/密钥状态，
// 输出协议层 SettingsSnapshot。这样设置页的数据形状可以单独测试，也避免
// agent-host.ts 继续膨胀。
import {
  PROVIDERS,
  WEB_SEARCH_PROVIDERS,
  getContextWindow,
  getModelContextWindowOverride,
  getOpenAIAuthStatus,
  getPermissionLevel,
  loadUserConfig,
  toolRegistry,
} from '@x-code-cli/core'
import type { AgentOptions, PluginRegistry, SkillRegistry } from '@x-code-cli/core'

import { DEFAULT_UPDATE_FEED } from '../shared/constants.js'
import type {
  AppState,
  McpServerView,
  ModelPricingView,
  PluginSettingsView,
  ProviderSettingsView,
  SearchProviderView,
  SettingsSnapshot,
  SkillSettingsView,
  ToolSettingsView,
} from '../shared/protocol.js'
import { TOOL_META, toUserConfigFields } from './agent-host-support.js'
import { loadDesktopSettings } from './desktop-settings.js'
import { providerSecretStatus, searchSecretStatus, secretStorageKind } from './secrets.js'
import { skillRuntimeView } from './skill-runtime.js'

export interface SettingsSnapshotInput {
  workspace: string
  providers: AppState['providers']
  modelId: string
  disabledTools: ReadonlySet<string>
  autoAllowedTools: ReadonlySet<string>
  alwaysAllowAll: boolean
  skillRegistry?: SkillRegistry
  pluginRegistry: PluginRegistry
  pluginErrors: string[]
  subAgentNames: string[]
  baseOptions: AgentOptions
  mcpServers: McpServerView[]
  mcpProjectSkipped: boolean
  budget?: { maxTokens?: number; maxCostUsd?: number }
  externalContentPolicy: 'off' | 'approve'
  defaultWorkspace: string
  pricingOverrides: Record<string, { inputPerMTok?: number; outputPerMTok?: number }>
  activePricing?: ModelPricingView
}

function maskAccount(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.includes('@')) {
    const [local, domain] = value.split('@', 2)
    return local && domain ? `${local.slice(0, 2)}***@${domain}` : '***'
  }
  return value.length <= 6 ? `${value.slice(0, 1)}***` : `${value.slice(0, 4)}…${value.slice(-2)}`
}

export function buildSettingsSnapshot(input: SettingsSnapshotInput): SettingsSnapshot {
  const userConfig = loadUserConfig()
  const providers: ProviderSettingsView[] = PROVIDERS.map((provider) => {
    const status = providerSecretStatus(provider.name)
    return {
      name: provider.name,
      envKey: provider.envKey,
      keyUrl: provider.keyUrl,
      available: input.providers.some((entry) => entry.name === provider.name && entry.available),
      source: status.source,
      hint: status.hint,
      baseUrl: userConfig.baseUrls?.[provider.name] ?? status.baseUrl,
      ...(provider.baseUrlOptions
        ? { baseUrlOptions: provider.baseUrlOptions.map((option) => ({ label: option.label, url: option.url })) }
        : {}),
    }
  })
  const customStatus = providerSecretStatus('custom')
  providers.push({
    name: 'custom',
    envKey: 'OPENAI_COMPATIBLE_API_KEY',
    keyUrl: '',
    available: input.providers.some((entry) => entry.name === 'custom' && entry.available),
    source: customStatus.source,
    hint: customStatus.hint,
    baseUrl: customStatus.baseUrl,
    modelId: loadDesktopSettings().customModelId,
  })

  const skills: SkillSettingsView[] = (input.skillRegistry?.listAll() ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    pluginId: skill.pluginId,
    enabled: !skill.disabled,
    removable: skill.source === 'user' && !skill.pluginId,
    runtime: skillRuntimeView(skill),
  }))
  const tools: ToolSettingsView[] = Object.entries(toolRegistry).map(([name, tool]) => {
    const meta = TOOL_META[name]
    return {
      name,
      label: meta?.label ?? name,
      description: meta?.description ?? (tool as { description?: string }).description ?? '',
      enabled: !input.disabledTools.has(name),
      needsPermission: getPermissionLevel(name, {}) === 'ask',
      alwaysAllow: input.autoAllowedTools.has(name),
    }
  })
  const plugins: PluginSettingsView[] = input.pluginRegistry.listAll().map((plugin) => {
    const fields = toUserConfigFields(plugin.manifest.userConfig)
    return {
      id: plugin.id,
      name: plugin.manifest.name ?? plugin.id,
      version: plugin.manifest.version ?? '',
      scope: plugin.scope,
      enabled: plugin.enabled,
      marketplace: plugin.marketplace,
      ...(fields.length > 0 ? { userConfig: fields } : {}),
    }
  })
  const searchProviders: SearchProviderView[] = WEB_SEARCH_PROVIDERS.filter((provider) => !provider.modelKeyOnly).map(
    (provider) => {
      const status = searchSecretStatus(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        envKey: provider.envKey,
        signup: provider.signup,
        configured: status.source !== 'none',
        source: status.source,
        ...(status.hint ? { hint: status.hint } : {}),
      }
    },
  )

  return {
    workspace: input.workspace,
    activeModelId: input.modelId,
    contextWindow: getContextWindow(input.modelId),
    ...(getModelContextWindowOverride(input.modelId) !== undefined
      ? { contextWindowOverride: getModelContextWindowOverride(input.modelId) }
      : {}),
    providers,
    skills,
    tools,
    searchProviders,
    searchProvider: loadDesktopSettings().searchProvider ?? '',
    plugins,
    pluginErrors: input.pluginErrors,
    mcpServers: input.mcpServers,
    mcpProjectSkipped: input.mcpProjectSkipped,
    ...(input.budget ? { budget: input.budget } : {}),
    externalContentPolicy: input.externalContentPolicy,
    defaultWorkspace: input.defaultWorkspace,
    pricingOverrides: Object.fromEntries(
      Object.entries(input.pricingOverrides).flatMap(([modelId, pricing]) =>
        typeof pricing.inputPerMTok === 'number' && typeof pricing.outputPerMTok === 'number'
          ? [[modelId, { inputPerMTok: pricing.inputPerMTok, outputPerMTok: pricing.outputPerMTok }]]
          : [],
      ),
    ),
    ...(input.activePricing ? { activePricing: input.activePricing } : {}),
    openaiAuth: (() => {
      const status = getOpenAIAuthStatus()
      return {
        mode: status.mode,
        ...(status.email ? { email: maskAccount(status.email) } : {}),
        ...(status.accountId ? { accountId: maskAccount(status.accountId) } : {}),
        ...(status.planType ? { planType: status.planType } : {}),
        ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
        apiKeyConfigured: status.apiKeyConfigured,
        ...(status.credentialError ? { credentialError: status.credentialError } : {}),
      }
    })(),
    toolProfile: (input.baseOptions.toolProfile ?? 'full') as 'full' | 'standard',
    thinking: input.baseOptions.thinking ?? false,
    alwaysAllowAll: input.alwaysAllowAll,
    browser: {
      enabled: input.subAgentNames.includes('browser'),
      visualCheck: input.baseOptions.browserVisualCheckEnabled !== false,
    },
    secretStorage: secretStorageKind(),
    shellSandbox: {
      supported: process.platform === 'darwin',
      enabled: loadDesktopSettings().shellSandbox !== false,
      allowNetwork: loadDesktopSettings().shellSandboxNetwork === true,
      extensions: loadDesktopSettings().shellSandboxExtensions === true,
    },
    notifications: loadDesktopSettings().notifications !== false,
    onboarded: loadDesktopSettings().onboarded === true,
    updateFeed: loadDesktopSettings().updateFeed || DEFAULT_UPDATE_FEED,
  }
}
