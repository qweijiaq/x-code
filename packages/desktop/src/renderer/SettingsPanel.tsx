import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AppState,
  LibrarySearchView,
  LibraryStatsView,
  MarketplaceEntryView,
  MarketplaceListView,
  McpServerView,
  PermissionRuleType,
  PermissionRuleView,
  PermissionRulesResult,
  PluginConsentPreviewView,
  PluginInstallResult,
  PluginInstallTarget,
  RuntimeRequest,
  RuntimeResponse,
  SettingsActionResult,
  SettingsSnapshot,
  SkillImportResult,
  SkillMarketEntryView,
  SkillMarketListView,
  SkillMarketProvider,
  TestConnectionResult,
  UpdateCheckResult,
  UpdateDownloadView,
  UserConfigFieldView,
  UserConfigValues,
} from '../shared/protocol.js'
import { CommandsSettings } from './CommandsSettings.js'
import { HooksSettings } from './HooksSettings.js'
import { MemorySettings } from './MemorySettings.js'
import { ProjectSettings } from './ProjectSettings.js'
import { StorageSettings } from './StorageSettings.js'
import i18n from './i18n.js'

const MIN_CONTEXT_WINDOW = 32_768

type Tab =
  | 'api'
  | 'project'
  | 'skills'
  | 'skillmarket'
  | 'commands'
  | 'hooks'
  | 'memory'
  | 'mcp'
  | 'plugins'
  | 'market'
  | 'tools'
  | 'permissions'
  | 'library'
  | 'storage'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'api', label: '模型与密钥' },
  { id: 'project', label: '项目' },
  { id: 'skills', label: '技能' },
  { id: 'skillmarket', label: '技能市场' },
  { id: 'commands', label: '命令' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: '记忆' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: '插件' },
  { id: 'market', label: '插件市场' },
  { id: 'tools', label: '工具' },
  { id: 'permissions', label: '权限' },
  { id: 'library', label: '文档库' },
  { id: 'storage', label: '存储' },
]

const MCP_PLACEHOLDER = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}`

function newerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] => value.split('-')[0].split('.').map(Number)
  const next = parse(latest)
  const now = parse(current)
  for (let index = 0; index < Math.max(next.length, now.length); index++) {
    const left = next[index] ?? 0
    const right = now[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

function mcpSummary(server: McpServerView): string {
  const command = server.config.command
  const url = server.config.url
  if (typeof command === 'string') {
    const args = Array.isArray(server.config.args) ? server.config.args.filter((a) => typeof a === 'string') : []
    return [command, ...args].join(' ')
  }
  if (typeof url === 'string') return url
  return ''
}

function mcpStatusLabel(server: McpServerView): string {
  const status = server.status
  if (status.kind === 'connected') return i18n.t('已连接 · {{count}} 个工具', { count: status.toolCount })
  if (status.kind === 'connecting') return i18n.t('连接中')
  if (status.kind === 'disabled') return i18n.t('已禁用')
  if (status.kind === 'needs_auth') return i18n.t('需要认证')
  return i18n.t('连接失败：{{message}}', { message: status.error })
}

interface SettingsPanelProps {
  settings: SettingsSnapshot
  onSettings(settings: SettingsSnapshot): void
  onState(state: AppState): void
  onClose(): void
  theme: 'light' | 'dark' | 'system'
  onTheme(theme: 'light' | 'dark' | 'system'): void
  onLanguage(language: 'zh' | 'en'): void
  workspace: string
  onOpenDocument(path: string, page?: number): void
  /** Tab requested from outside (command palette / shortcut). */
  activeTab?: string
  onTabChange?: (tab: string) => void
  onUsage?: (key: 'skill') => void
}

export function SettingsPanel({
  settings,
  onSettings,
  onState,
  onClose,
  theme,
  onTheme,
  onLanguage,
  workspace,
  onOpenDocument,
  activeTab,
  onTabChange,
  onUsage,
}: SettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const language = i18n.language === 'en' ? 'en' : 'zh'
  const skillsMpServer = settings.mcpServers.find((server) => server.name === 'skillsmp')
  const skillsMpStatus = ((): string => {
    if (!skillsMpServer) return t('未注册')
    const status = skillsMpServer.status
    if (status.kind === 'connected') return t('已连接 · {{count}} 个工具', { count: status.toolCount })
    if (status.kind === 'connecting') return t('连接中')
    if (status.kind === 'needs_auth') return t('需要认证')
    if (status.kind === 'disabled') return t('已禁用')
    return t('连接失败：{{message}}', { message: status.error })
  })()
  const [localTab, setLocalTab] = useState<Tab>(() =>
    activeTab && TABS.some((item) => item.id === activeTab) ? (activeTab as Tab) : 'api',
  )
  const tab: Tab = activeTab && TABS.some((item) => item.id === activeTab) ? (activeTab as Tab) : localTab
  const selectTab = (next: Tab): void => {
    setLocalTab(next)
    onTabChange?.(next)
    if (next === 'market' && !market) void loadMarketplace(false)
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [baseUrlDrafts, setBaseUrlDrafts] = useState<Record<string, string>>({})
  const [customModelDraft, setCustomModelDraft] = useState('')
  const [contextWindowDraft, setContextWindowDraft] = useState(
    settings.contextWindowOverride ? String(settings.contextWindowOverride) : '',
  )
  const [permissionRules, setPermissionRules] = useState<PermissionRuleView[] | null>(null)
  const [permissionTool, setPermissionTool] = useState('shell')
  const [permissionType, setPermissionType] = useState<PermissionRuleType>('prefix')
  const [permissionPattern, setPermissionPattern] = useState('')
  const [testResults, setTestResults] = useState<Record<string, TestConnectionResult | { testing: true }>>({})
  const [mcpName, setMcpName] = useState('')
  const [mcpJson, setMcpJson] = useState(MCP_PLACEHOLDER)
  const [notice, setNotice] = useState<string | null>(null)
  const [updateFeedDraft, setUpdateFeedDraft] = useState(settings.updateFeed)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadView | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [installCommand, setInstallCommand] = useState('')
  const [skillCommand, setSkillCommand] = useState('')
  const [skillMarketProvider, setSkillMarketProvider] = useState<SkillMarketProvider>('skillhub')
  const [skillMarketQuery, setSkillMarketQuery] = useState('')
  const [skillMarketResults, setSkillMarketResults] = useState<SkillMarketListView | null>(null)
  const [skillMarketBusy, setSkillMarketBusy] = useState(false)
  const [market, setMarket] = useState<MarketplaceListView | null>(null)
  const [marketQuery, setMarketQuery] = useState('')
  const [marketName, setMarketName] = useState('')
  const [marketSource, setMarketSource] = useState('')
  const [pluginPreview, setPluginPreview] = useState<{
    preview: PluginConsentPreviewView
    target: PluginInstallTarget
  } | null>(null)
  const [uninstallId, setUninstallId] = useState<string | null>(null)
  const [removeSkillName, setRemoveSkillName] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibraryStatsView | null>(null)
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null)
  const [libraryProgress, setLibraryProgress] = useState<string | null>(null)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [librarySearch, setLibrarySearch] = useState<LibrarySearchView | null>(null)
  const [libraryConfirmClear, setLibraryConfirmClear] = useState(false)
  const [pluginConfigDraft, setPluginConfigDraft] = useState<Record<string, string>>({})
  const [pluginConfig, setPluginConfig] = useState<{
    id: string
    fields: UserConfigFieldView[]
    values: UserConfigValues
    setKeys: string[]
  } | null>(null)
  const [pluginConfigEditDraft, setPluginConfigEditDraft] = useState<Record<string, string>>({})

  const request = async (method: string, params: Record<string, unknown>): Promise<RuntimeResponse> => {
    try {
      return await window.xcode.request({
        id: crypto.randomUUID(),
        method,
        params,
      } as unknown as RuntimeRequest)
    } catch (err) {
      return {
        id: '',
        ok: false,
        error: { code: 'ipc', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  useEffect(() => {
    setContextWindowDraft(settings.contextWindowOverride ? String(settings.contextWindowOverride) : '')
  }, [settings.contextWindowOverride, settings.activeModelId])

  const apply = async (
    method: string,
    params: Record<string, unknown>,
    busyKey: string,
  ): Promise<SettingsActionResult | null> => {
    setBusy(busyKey)
    setError(null)
    setNotice(null)
    try {
      const response = await request(method, params)
      if (!response.ok) {
        setError(response.error.message)
        return null
      }
      const result = response.result as SettingsActionResult
      if (result && typeof result === 'object' && 'settings' in result && 'state' in result) {
        onSettings(result.settings)
        onState(result.state)
      }
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(null)
    }
  }

  const saveContextWindow = async (tokens: number | null): Promise<void> => {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_WINDOW)) {
      setError(t('上下文上限不能小于 {{min}} tokens', { min: MIN_CONTEXT_WINDOW }))
      return
    }
    const result = await apply(
      'settings:set-context-window',
      { modelId: settings.activeModelId, tokens },
      'context-window',
    )
    if (result) setNotice(t('上下文上限已更新'))
  }

  const showPermissionRules = (response: RuntimeResponse): boolean => {
    if (!response.ok) {
      setError(response.error.message)
      return false
    }
    setPermissionRules((response.result as PermissionRulesResult).rules)
    return true
  }

  const addPermissionRule = async (): Promise<void> => {
    setBusy('permission-rule')
    setError(null)
    setNotice(null)
    try {
      const response = await request('permissions:add-rule', {
        tool: permissionTool,
        type: permissionType,
        pattern: permissionType === 'tool' ? '*' : permissionPattern,
      })
      if (!showPermissionRules(response)) return
      setPermissionPattern('')
      setNotice(t('权限规则已保存'))
    } finally {
      setBusy(null)
    }
  }

  const removePermissionRule = async (rule: PermissionRuleView): Promise<void> => {
    setBusy('permission-rule')
    setError(null)
    setNotice(null)
    try {
      const response = await request('permissions:remove-rule', {
        tool: rule.tool,
        type: rule.type,
        pattern: rule.pattern,
        cwd: rule.cwd,
      })
      if (showPermissionRules(response)) setNotice(t('权限规则已删除'))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (tab !== 'permissions') return
    let cancelled = false
    void (async () => {
      const response = await request('permissions:rules', {})
      if (cancelled) return
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setPermissionRules((response.result as PermissionRulesResult).rules)
    })()
    return () => {
      cancelled = true
    }
  }, [tab])

  const openExternal = async (url: string): Promise<void> => {
    if (!url.startsWith('https://')) {
      setError(t('只允许打开 https 链接'))
      return
    }
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:open-external',
      params: { url },
    } as unknown as RuntimeRequest)
  }

  const saveKey = async (provider: string): Promise<void> => {
    const key = keyDrafts[provider]?.trim()
    if (!key) return
    const result = await apply(
      'settings:set-api-key',
      { provider, key, baseUrl: provider === 'custom' ? baseUrlDrafts.custom?.trim() : undefined },
      `key:${provider}`,
    )
    if (result) {
      setKeyDrafts((prev) => ({ ...prev, [provider]: '' }))
    }
  }

  const saveCustomModel = async (): Promise<void> => {
    const provider = settings.providers.find((entry) => entry.name === 'custom')
    const modelId = (customModelDraft || provider?.modelId || '').trim()
    if (!modelId) {
      setError(t('请填写模型 ID'))
      return
    }
    const key = keyDrafts.custom?.trim() || undefined
    const baseUrl = (baseUrlDrafts.custom ?? provider?.baseUrl ?? '').trim() || undefined
    const result = await apply('settings:set-custom-model', { modelId, key, baseUrl }, 'custom-model')
    if (result) {
      setKeyDrafts((prev) => ({ ...prev, custom: '' }))
    }
  }

  const removeMcp = async (name: string): Promise<void> => {
    await apply('settings:mcp-remove', { name }, `mcp-remove:${name}`)
  }

  const saveMcp = async (): Promise<void> => {
    const name = mcpName.trim()
    if (!name) {
      setError(t('请填写服务器名称'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(mcpJson)
    } catch {
      setError(t('MCP 配置不是合法 JSON'))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('MCP 配置必须是 JSON 对象'))
      return
    }
    const result = await apply('settings:mcp-save', { name, config: parsed as Record<string, unknown> }, 'mcp-save')
    if (result) setMcpName('')
  }

  const testProvider = async (provider: string): Promise<void> => {
    setTestResults((prev) => ({ ...prev, [provider]: { testing: true } }))
    const response = await request('settings:test-api-key', {
      provider,
      key: keyDrafts[provider]?.trim() || undefined,
      baseUrl: provider === 'custom' ? baseUrlDrafts.custom?.trim() || undefined : undefined,
    })
    const result: TestConnectionResult = response.ok
      ? (response.result as TestConnectionResult)
      : { ok: false, modelId: '', latencyMs: 0, message: response.error.message }
    setTestResults((prev) => ({ ...prev, [provider]: result }))
  }

  const pickPath = async (kind: 'skill' | 'plugin'): Promise<string | null> => {
    const response = await request('app:pick-path', { kind })
    if (!response.ok) {
      setError(response.error.message)
      return null
    }
    return (response.result as { path: string | null }).path
  }

  const importSkill = async (): Promise<void> => {
    const path = await pickPath('skill')
    if (!path) return
    setBusy('skill-import')
    setError(null)
    setNotice(null)
    const response = await request('skills:import', { path })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const result = response.result as SkillImportResult
    onSettings(result.settings)
    onUsage?.('skill')
    setNotice(t('已导入技能：{{names}}', { names: result.added.join(language === 'zh' ? '、' : ', ') }))
  }

  const draftForFields = (fields: UserConfigFieldView[], values?: UserConfigValues): Record<string, string> => {
    const draft: Record<string, string> = {}
    for (const field of fields) {
      if (field.sensitive === true) {
        draft[field.key] = ''
        continue
      }
      const stored = values && Object.hasOwn(values, field.key) ? values[field.key] : undefined
      if (stored !== undefined) draft[field.key] = String(stored)
      else if (field.default !== undefined) draft[field.key] = String(field.default)
      else draft[field.key] = ''
    }
    return draft
  }

  const valuesFromDraft = (fields: UserConfigFieldView[], draft: Record<string, string>): UserConfigValues => {
    const values: UserConfigValues = {}
    for (const field of fields) {
      const raw = draft[field.key] ?? ''
      if (field.sensitive === true && raw === '') continue
      if (field.type === 'boolean') values[field.key] = raw === 'true'
      else if (field.type === 'number') values[field.key] = Number(raw)
      else values[field.key] = raw
    }
    return values
  }

  const configFieldsComplete = (fields: UserConfigFieldView[], draft: Record<string, string>): boolean =>
    fields.every((field) => field.required !== true || (draft[field.key] ?? '') !== '' || field.default !== undefined)

  const openPluginConfig = async (id: string): Promise<void> => {
    setError(null)
    const response = await request('plugins:user-config', { id })
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const result = response.result as {
      fields: UserConfigFieldView[]
      values: UserConfigValues
      setKeys: string[]
    }
    setPluginConfig({ id, ...result })
    setPluginConfigEditDraft(draftForFields(result.fields, result.values))
  }

  const savePluginConfigValues = async (): Promise<void> => {
    if (!pluginConfig) return
    setBusy('plugin-config')
    setError(null)
    try {
      const response = await request('plugins:save-user-config', {
        id: pluginConfig.id,
        values: valuesFromDraft(pluginConfig.fields, pluginConfigEditDraft),
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as SettingsActionResult
      onSettings(result.settings)
      onState(result.state)
      setPluginConfig(null)
      setNotice(t('插件配置已保存'))
    } finally {
      setBusy(null)
    }
  }

  const requestPreview = async (target: PluginInstallTarget): Promise<void> => {
    setBusy('plugin-preview')
    setError(null)
    setNotice(null)
    const response = await request('plugins:preview', { target })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const preview = response.result as PluginConsentPreviewView
    setPluginPreview({ preview, target })
    setPluginConfigDraft(draftForFields(preview.userConfig ?? []))
  }

  const confirmPluginInstall = async (): Promise<void> => {
    const current = pluginPreview
    if (!current) return
    setBusy('plugin-install')
    setError(null)
    const userConfig = valuesFromDraft(current.preview.userConfig ?? [], pluginConfigDraft)
    const response = await request('plugins:install', { target: current.target, userConfig })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const result = response.result as PluginInstallResult
    onSettings(result.settings)
    setNotice(t('已安装 {{id}} v{{version}}', { id: result.pluginId, version: result.version }))
    setPluginPreview(null)
    setInstallCommand('')
    setSkillCommand('')
    if (market) void loadMarketplace(false)
  }

  const importPlugin = async (): Promise<void> => {
    const path = await pickPath('plugin')
    if (!path) return
    await requestPreview({ kind: 'path', path })
  }

  const runInstallCommand = async (): Promise<void> => {
    const command = installCommand.trim()
    if (!command) return
    await requestPreview({ kind: 'command', command })
  }

  const runSkillCommand = async (): Promise<void> => {
    const command = skillCommand.trim()
    if (!command) return
    if (/^(?:xc|x-code|claude)\s+plugin\s+install\b/i.test(command)) {
      await requestPreview({ kind: 'command', command })
      return
    }
    setBusy('skill-command')
    setError(null)
    setNotice(null)
    const response = await request('skills:install-command', { command })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const result = response.result as SkillImportResult
    onSettings(result.settings)
    if (result.plugin) {
      const added =
        result.added.length > 0
          ? t('；新增技能：{{names}}', { names: result.added.join(language === 'zh' ? '、' : ', ') })
          : ''
      setNotice(
        t('已安装插件 {{id}} v{{version}}{{added}}', {
          id: result.plugin.pluginId,
          version: result.plugin.version,
          added,
        }),
      )
    } else {
      onUsage?.('skill')
      setNotice(t('已导入技能：{{names}}', { names: result.added.join(language === 'zh' ? '、' : ', ') }))
    }
    setSkillCommand('')
  }

  const searchSkillMarket = async (): Promise<void> => {
    const query = skillMarketQuery.trim()
    if (!query) {
      setError(t('请输入搜索关键词'))
      return
    }
    setSkillMarketBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await request('skill-market:search', {
        provider: skillMarketProvider,
        query,
        limit: 20,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setSkillMarketResults(response.result as SkillMarketListView)
    } finally {
      setSkillMarketBusy(false)
    }
  }

  const registerSkillsMpMcp = async (): Promise<void> => {
    setSkillMarketBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await request('skill-market:register-mcp', {})
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as SettingsActionResult
      onSettings(result.settings)
      onState(result.state)
      setNotice(t('SkillsMP 已注册为 MCP 服务器'))
    } finally {
      setSkillMarketBusy(false)
    }
  }

  const installMarketSkill = async (entry: SkillMarketEntryView): Promise<void> => {
    setSkillMarketBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await request('skill-market:install', {
        provider: entry.provider,
        id: entry.id,
        version: entry.version,
        sourceUrl: entry.sourceUrl,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as SkillImportResult
      onSettings(result.settings)
      onUsage?.('skill')
      setSkillMarketResults((previous) =>
        previous
          ? {
              ...previous,
              entries: previous.entries.map((item) => (item.id === entry.id ? { ...item, installed: true } : item)),
            }
          : previous,
      )
      setNotice(
        t('已从技能市场安装：{{names}}', {
          names: result.added.join(language === 'zh' ? '、' : ', '),
        }),
      )
    } finally {
      setSkillMarketBusy(false)
    }
  }

  const loadMarketplace = async (refresh: boolean): Promise<void> => {
    setBusy('market-load')
    setError(null)
    const response = await request('settings:marketplace-list', { query: marketQuery, refresh })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setMarket(response.result as MarketplaceListView)
  }

  const installMarketEntry = async (entry: MarketplaceEntryView): Promise<void> => {
    await requestPreview({ kind: 'marketplace', id: entry.id })
  }

  const uninstallPluginEntry = async (id: string): Promise<void> => {
    setUninstallId(null)
    await apply('plugins:uninstall', { id }, `uninstall:${id}`)
  }

  const removeSkillEntry = async (name: string): Promise<void> => {
    setRemoveSkillName(null)
    await apply('skills:remove', { name }, `remove-skill:${name}`)
  }

  const addMarket = async (): Promise<void> => {
    const name = marketName.trim()
    const source = marketSource.trim()
    if (!name || !source) {
      setError(t('请填写市场名称和来源'))
      return
    }
    setBusy('market-add')
    setError(null)
    setNotice(null)
    const response = await request('settings:marketplace-add', { name, source })
    setBusy(null)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setMarket(response.result as MarketplaceListView)
    setMarketName('')
    setMarketSource('')
    setNotice(t('已添加市场 {{name}}', { name }))
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    setUpdateResult(null)
    setError(null)
    try {
      const feed = updateFeedDraft.trim()
      const saved = await request('settings:set-update-feed', { feed })
      if (saved.ok) {
        const result = saved.result as SettingsActionResult
        if (result && typeof result === 'object' && 'settings' in result && 'state' in result) {
          onSettings(result.settings)
          onState(result.state)
        }
      } else {
        setError(saved.error.message)
        return
      }
      const response = await request('app:check-update', { feed })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setUpdateResult(response.result as UpdateCheckResult)
    } finally {
      setUpdateBusy(false)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    setUpdateDownload(null)
    setError(null)
    setNotice(null)
    try {
      const response = await request('app:download-update', { feed: updateFeedDraft.trim() })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setUpdateDownload(response.result as UpdateDownloadView)
      setNotice(t('安装包已下载并通过校验'))
    } finally {
      setUpdateBusy(false)
    }
  }

  const openDownloadedUpdate = async (): Promise<void> => {
    if (!updateDownload) return
    const response = await request('app:open-update', { filePath: updateDownload.filePath })
    if (!response.ok) setError(response.error.message)
  }

  const renderTestResult = (provider: string): React.JSX.Element | null => {
    const result = testResults[provider]
    if (!result) return null
    if ('testing' in result) return <div className="settings-test">{t('测试中…')}</div>
    return (
      <div className={`settings-test ${result.ok ? 'ok' : 'fail'}`}>
        {result.ok
          ? t('连接成功 · {{model}} · {{ms}}ms', { model: result.modelId, ms: result.latencyMs })
          : t('连接失败：{{message}}', { message: result.message })}
      </div>
    )
  }

  const preview = pluginPreview?.preview
  const previewContributions = preview
    ? [
        preview.hasSkillsDir ? t('技能') : '',
        preview.hasAgentsDir ? t('子代理') : '',
        preview.hasCommandsDir ? t('命令') : '',
      ]
        .filter(Boolean)
        .join(language === 'zh' ? '、' : ', ')
    : ''
  const loadLibrary = async (): Promise<void> => {
    const response = await request('library:stats', {})
    if (response.ok) setLibrary(response.result as LibraryStatsView)
  }

  const indexLibraryAt = async (target: string, rebuild = false): Promise<void> => {
    if (!target) return
    setLibraryBusy(rebuild ? 'library-rebuild' : 'library-index')
    setLibraryProgress(null)
    try {
      if (rebuild) await request('library:clear', {})
      const response = await request('library:index', {
        path: target,
        recursive: true,
        semantic: library?.semanticEnabled === true,
      })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      const result = response.result as {
        indexed: number
        skipped: number
        removed: number
        files: number
        chunks: number
        vectors: number
        semantic: boolean
        note?: string
      }
      setNotice(
        t(
          '索引完成：新增/更新 {{indexed}}，跳过 {{skipped}}，移除 {{removed}}；共 {{files}} 个文件，{{chunks}} 个分块，{{vectors}} 个向量{{semantic}}',
          {
            indexed: result.indexed,
            skipped: result.skipped,
            removed: result.removed,
            files: result.files,
            chunks: result.chunks,
            vectors: result.vectors,
            semantic: result.semantic ? '' : t('（仅关键词）'),
          },
        ),
      )
      if (result.note) setError(result.note)
      await loadLibrary()
    } finally {
      setLibraryBusy(null)
      setLibraryProgress(null)
    }
  }

  const pickLibraryFolder = async (): Promise<void> => {
    const picked = await request('app:pick-path', { kind: 'folder' })
    if (!picked.ok) {
      setError(picked.error.message)
      return
    }
    const selected = (picked.result as { path: string | null }).path
    if (selected) await indexLibraryAt(selected)
  }

  const clearLibraryIndex = async (): Promise<void> => {
    setLibraryConfirmClear(false)
    const response = await request('library:clear', {})
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setLibrarySearch(null)
    await loadLibrary()
    setNotice(t('文档库索引已清空'))
  }

  const toggleLibrarySemantic = async (): Promise<void> => {
    if (!library) return
    const response = await request('library:set-semantic', { enabled: !library.semanticEnabled })
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    await loadLibrary()
  }

  const runLibrarySearch = async (): Promise<void> => {
    const query = libraryQuery.trim()
    if (!query) return
    setLibraryBusy('library-search')
    try {
      const response = await request('library:search', { query, limit: 10 })
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setLibrarySearch(response.result as LibrarySearchView)
    } finally {
      setLibraryBusy(null)
    }
  }

  useEffect(() => {
    if (tab !== 'library' || library) return
    void loadLibrary()
  }, [tab, library])

  useEffect(() => {
    const off = window.xcode.onEvent((event) => {
      if (event.type !== 'library:progress') return
      setLibraryProgress(`${event.phase} ${event.processed}/${event.total} · ${event.chunks}`)
    })
    return off
  }, [])

  const previewRisk = preview
    ? preview.hookEvents.length > 0 ||
      preview.hasPathHooks ||
      preview.inlineMcpServerNames.length > 0 ||
      preview.hasPathMcpServers
    : false

  const renderConfigField = (
    field: UserConfigFieldView,
    draft: Record<string, string>,
    setDraft: (next: Record<string, string>) => void,
    storedKeys: string[] = [],
  ): React.JSX.Element => {
    const value = draft[field.key] ?? ''
    const stored = storedKeys.includes(field.key)
    const label = field.prompt ?? field.description ?? field.key
    return (
      <label className="plugin-config-field" key={field.key}>
        <span className="plugin-config-label">
          {label}
          {field.required ? <span className="plugin-config-required">*</span> : null}
          <code>{field.key}</code>
        </span>
        {field.type === 'boolean' ? (
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.checked ? 'true' : 'false' })}
          />
        ) : (
          <input
            className="settings-input"
            type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
            value={value}
            placeholder={field.sensitive && stored ? t('已保存（留空保持不变）') : ''}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
          />
        )}
        {field.description && field.prompt ? <span className="settings-hint">{field.description}</span> : null}
        {field.default !== undefined && field.type !== 'boolean' ? (
          <span className="settings-hint">{t('默认值：{{value}}', { value: String(field.default) })}</span>
        ) : null}
      </label>
    )
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="settings-drawer" aria-label={t('设置')}>
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            {t('设')}
          </span>
          <div className="drawer-titles">
            <div className="drawer-title">{t('设置')}</div>
            <div className="drawer-sub">{settings.workspace}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose}>
            {t('关闭')}
          </button>
        </header>

        <div className="settings-appearance">
          <span className="settings-section-title">{t('外观')}</span>
          <div className="settings-segments">
            <div className="settings-segment">
              {(['light', 'dark', 'system'] as const).map((value) => (
                <button
                  key={value}
                  className={`settings-tab-inline ${theme === value ? 'active' : ''}`}
                  onClick={() => onTheme(value)}
                >
                  {t(value === 'light' ? '亮' : value === 'dark' ? '暗' : '跟随')}
                </button>
              ))}
            </div>
            <div className="settings-segment">
              {(['zh', 'en'] as const).map((value) => (
                <button
                  key={value}
                  className={`settings-tab-inline ${language === value ? 'active' : ''}`}
                  onClick={() => onLanguage(value)}
                >
                  {value === 'zh' ? '中文' : 'English'}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row" data-testid="notifications">
            <div className="setting-main">
              <div className="setting-name">{t('系统通知')}</div>
              <div className="setting-desc">{t('窗口在后台时，任务完成、执行失败或需要你确认时发送系统通知。')}</div>
            </div>
            <div className="setting-actions-col">
              <button
                className={`settings-toggle ${settings.notifications ? 'on' : ''}`}
                disabled={busy !== null}
                onClick={() =>
                  void apply('settings:set-notifications', { enabled: !settings.notifications }, 'notifications')
                }
              >
                {settings.notifications ? t('已开启（点击关闭）') : t('开启')}
              </button>
            </div>
          </div>
          <div className="setting-row" data-testid="update-check">
            <div className="setting-main">
              <div className="setting-name">{t('桌面端更新')}</div>
              <div className="setting-desc">
                {t(
                  '填写发布目录中 RELEASE.json 的 HTTPS 地址即可检查新版本；可下载匹配当前平台的安装包并校验 sha256，下载后手动安装。自动安装仍需要签名后的应用。',
                )}
              </div>
              {updateResult ? (
                <div className="settings-note">
                  {updateResult.error
                    ? t('检查失败：{{message}}', { message: updateResult.error })
                    : !updateResult.configured
                      ? t('未配置更新源（当前 v{{version}}）', { version: updateResult.currentVersion })
                      : t('当前 v{{current}} · 最新 v{{latest}}', {
                          current: updateResult.currentVersion,
                          latest: updateResult.latestVersion ?? '?',
                        })}
                  {updateResult.latestVersion && newerVersion(updateResult.latestVersion, updateResult.currentVersion)
                    ? ` · ${t('有新版本')}`
                    : ''}
                  {updateResult.notes ? ` · ${updateResult.notes}` : ''}
                </div>
              ) : null}
              {updateDownload ? (
                <div className="settings-note" data-testid="update-downloaded">
                  {t('已下载 {{file}}（{{size}} MB），校验通过。', {
                    file: updateDownload.fileName,
                    size: (updateDownload.bytes / 1024 / 1024).toFixed(1),
                  })}
                </div>
              ) : null}
            </div>
            <div className="update-controls">
              <input
                className="settings-input"
                placeholder="https://example.com/x-code/RELEASE.json"
                value={updateFeedDraft}
                onChange={(event) => setUpdateFeedDraft(event.target.value)}
              />
              <div className="update-buttons">
                <button className="btn" disabled={updateBusy} onClick={() => void checkUpdate()}>
                  {updateBusy ? t('检查中…') : t('保存并检查')}
                </button>
                {updateResult?.latestVersion &&
                newerVersion(updateResult.latestVersion, updateResult.currentVersion) &&
                !updateDownload ? (
                  <button
                    className="btn solid"
                    data-testid="update-download"
                    disabled={updateBusy}
                    onClick={() => void downloadUpdate()}
                  >
                    {updateBusy ? t('下载中…') : t('下载更新')}
                  </button>
                ) : null}
                {updateDownload ? (
                  <button className="btn solid" data-testid="update-open" onClick={() => void openDownloadedUpdate()}>
                    {t('打开安装包')}
                  </button>
                ) : null}
                {updateResult?.url?.startsWith('https://') ? (
                  <button
                    className="btn btn-quiet"
                    onClick={() => void request('app:open-external', { url: updateResult.url! })}
                  >
                    {t('打开发布页')}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <nav className="settings-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`settings-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => selectTab(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </nav>

        {error ? <div className="settings-error">{error}</div> : null}
        {notice ? <div className="settings-notice">{notice}</div> : null}

        <div className="settings-body">
          {tab === 'api' ? (
            <>
              <div className="settings-section-title">{t('模型服务密钥')}</div>
              <p className="settings-hint" data-testid="secret-storage">
                {settings.secretStorage === 'encrypted'
                  ? t('密钥使用系统安全存储加密保存（safeStorage）。')
                  : settings.secretStorage === 'plain'
                    ? t('当前平台不支持安全存储，密钥以 0600 权限明文保存在本机。')
                    : t('密钥存储状态未知。')}
              </p>
              <p className="settings-note">
                {t('密钥保存在本机')} <code>~/.x-code/desktop-secrets.json</code>
                {t('（权限 0600），保存后立即重新加载模型。界面只会拿到末四位提示，不会回传完整密钥。')}
              </p>
              {settings.providers.map((provider) => {
                const draft = keyDrafts[provider.name] ?? ''
                const badge =
                  provider.source === 'stored'
                    ? t('已保存')
                    : provider.source === 'env'
                      ? t('来自环境变量')
                      : provider.available
                        ? t('已可用')
                        : t('未配置')
                return (
                  <div className="provider-row" key={provider.name}>
                    <div className="provider-head">
                      <span className="provider-name">{provider.name}</span>
                      <span className={`settings-badge ${provider.source === 'none' ? '' : 'on'}`}>{badge}</span>
                      {provider.hint ? <span className="provider-hint">{provider.hint}</span> : null}
                      {provider.keyUrl.startsWith('https://') ? (
                        <button className="link-button" onClick={() => void openExternal(provider.keyUrl)}>
                          {t('获取 Key')}
                        </button>
                      ) : null}
                    </div>
                    <div className="provider-meta">{provider.envKey}</div>
                    {provider.name === 'custom' ? (
                      <div className="provider-fields" data-testid="provider-fields">
                        <input
                          className="settings-input"
                          placeholder={t('模型 ID，如 gpt-4o-mini')}
                          value={customModelDraft || provider.modelId || ''}
                          onChange={(event) => setCustomModelDraft(event.target.value)}
                        />
                        <input
                          className="settings-input"
                          placeholder={t('Base URL，例如 https://api.example.com/v1')}
                          value={baseUrlDrafts.custom ?? provider.baseUrl ?? ''}
                          onChange={(event) => setBaseUrlDrafts((prev) => ({ ...prev, custom: event.target.value }))}
                        />
                      </div>
                    ) : null}
                    <div className="provider-actions">
                      <input
                        className="settings-input"
                        type="password"
                        autoComplete="off"
                        placeholder={provider.source === 'stored' ? t('输入新 Key 覆盖') : t('粘贴 API Key')}
                        value={draft}
                        onChange={(event) => setKeyDrafts((prev) => ({ ...prev, [provider.name]: event.target.value }))}
                      />
                      <button
                        className="btn solid"
                        disabled={
                          busy !== null ||
                          (provider.name === 'custom'
                            ? !(customModelDraft || provider.modelId || '').trim()
                            : draft.trim().length === 0)
                        }
                        onClick={() =>
                          provider.name === 'custom' ? void saveCustomModel() : void saveKey(provider.name)
                        }
                      >
                        {busy === `key:${provider.name}` || busy === 'custom-model' ? t('保存中…') : t('保存')}
                      </button>
                      <button
                        className="btn"
                        disabled={busy !== null || 'testing' in (testResults[provider.name] ?? {})}
                        onClick={() => void testProvider(provider.name)}
                      >
                        {'testing' in (testResults[provider.name] ?? {}) ? t('测试中…') : t('测试连接')}
                      </button>
                      {provider.source === 'stored' ? (
                        <button
                          className="btn"
                          disabled={busy !== null}
                          onClick={() =>
                            void apply('settings:clear-api-key', { provider: provider.name }, `clear:${provider.name}`)
                          }
                        >
                          {t('清除')}
                        </button>
                      ) : null}
                    </div>
                    {renderTestResult(provider.name)}
                  </div>
                )
              })}
              <div className="settings-section-title">{t('上下文窗口')}</div>
              <p className="settings-note">
                {t('当前模型：{{model}}；有效上限 {{tokens}} tokens。', {
                  model: settings.activeModelId,
                  tokens: settings.contextWindow.toLocaleString(),
                })}
              </p>
              <div className="settings-actions">
                <input
                  className="settings-input"
                  data-testid="context-window-input"
                  type="number"
                  min={MIN_CONTEXT_WINDOW}
                  placeholder={t('覆盖 tokens（≥ {{min}}）', { min: MIN_CONTEXT_WINDOW })}
                  value={contextWindowDraft}
                  onChange={(event) => setContextWindowDraft(event.target.value)}
                />
                <button
                  className="btn solid"
                  data-testid="context-window-save"
                  disabled={busy !== null || !contextWindowDraft.trim()}
                  onClick={() => void saveContextWindow(Number(contextWindowDraft))}
                >
                  {busy === 'context-window' ? t('保存中…') : t('保存覆盖')}
                </button>
                {settings.contextWindowOverride ? (
                  <button
                    className="btn"
                    data-testid="context-window-reset"
                    disabled={busy !== null}
                    onClick={() => void saveContextWindow(null)}
                  >
                    {t('恢复默认')}
                  </button>
                ) : null}
              </div>
              <p className="settings-hint">
                {settings.contextWindowOverride
                  ? t('已为当前模型覆盖上下文上限；切换模型后可为其他模型单独设置。')
                  : t('留空使用模型表或 provider 兜底值；覆盖只影响当前模型。')}
              </p>
            </>
          ) : null}

          {tab === 'skills' ? (
            <>
              <div className="settings-section-title">{t('技能')}</div>
              <p className="settings-note">
                {t('技能来自用户目录、项目目录和插件贡献。启用状态写入用户设置，下一轮对话生效。')}
              </p>
              <div className="settings-actions">
                <button className="btn" disabled={busy !== null} onClick={() => void importSkill()}>
                  {busy === 'skill-import' ? t('导入中…') : t('从文件/文件夹导入')}
                </button>
                <input
                  className="settings-input"
                  data-testid="skill-command"
                  placeholder="npx skills add owner/repo --skill name"
                  value={skillCommand}
                  onChange={(event) => setSkillCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void runSkillCommand()
                    }
                  }}
                />
                <button
                  className="btn solid"
                  disabled={busy !== null || !skillCommand.trim()}
                  onClick={() => void runSkillCommand()}
                >
                  {busy === 'skill-command' ? t('安装中…') : t('执行安装')}
                </button>
              </div>
              <p className="settings-hint">
                {t('支持粘贴 npx skills add / add-skill / xc plugin install 命令；只解析参数，不会执行 shell。')}
              </p>
              {settings.skills.length === 0 ? <div className="settings-empty">{t('未发现技能')}</div> : null}
              {settings.skills.map((skill) => (
                <div className="setting-row" key={skill.name}>
                  <div className="setting-main">
                    <div className="setting-name">{skill.name}</div>
                    <div className="setting-desc">{skill.description}</div>
                    <div className="setting-meta">
                      {skill.source === 'user' ? t('用户级') : t('项目级')}
                      {skill.pluginId ? t(' · 插件 {{id}}', { id: skill.pluginId }) : ''}
                    </div>
                  </div>
                  <div className="setting-actions-col">
                    <button
                      className={`settings-toggle ${skill.enabled ? 'on' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void apply(
                          'settings:set-skill-enabled',
                          { name: skill.name, enabled: !skill.enabled },
                          `skill:${skill.name}`,
                        )
                      }
                    >
                      {skill.enabled ? t('已启用') : t('已禁用')}
                    </button>
                    {skill.removable ? (
                      <button
                        className={`btn ${removeSkillName === skill.name ? 'danger' : ''}`}
                        disabled={busy !== null}
                        onClick={() =>
                          removeSkillName === skill.name
                            ? void removeSkillEntry(skill.name)
                            : setRemoveSkillName(skill.name)
                        }
                      >
                        {removeSkillName === skill.name ? t('确认删除') : t('删除')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'skillmarket' ? (
            <div data-testid="skill-market">
              <div className="settings-section-title">{t('技能市场')}</div>
              <p className="settings-note">
                {t(
                  '从 SkillHub 或 SkillsMP 搜索并安装 Agent Skills。技能写入 ~/.x-code/skills，下一轮对话生效；安装前请自行确认来源可信。',
                )}
              </p>
              {skillMarketProvider === 'skillsmp' ? (
                <div className="setting-row" data-testid="skill-market-mcp">
                  <div className="setting-main">
                    <div className="setting-name">
                      {t('SkillsMP MCP 工具')}
                      {skillsMpServer ? <span className="settings-badge">{t('已注册')}</span> : null}
                    </div>
                    <div className="setting-desc">
                      {t(
                        '把 https://skillsmp.com/mcp 注册为用户级 MCP 服务器后，agent 可以在对话中直接调用 search_skills / get_skill / list_categories。',
                      )}
                    </div>
                    <div className="setting-meta">{skillsMpStatus}</div>
                  </div>
                  <div className="setting-actions-col">
                    <button
                      className="btn solid"
                      data-testid="skill-market-register-mcp"
                      disabled={skillMarketBusy || Boolean(skillsMpServer)}
                      onClick={() => void registerSkillsMpMcp()}
                    >
                      {skillsMpServer ? t('已注册') : t('注册为 MCP 服务器')}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="settings-actions">
                <div className="segmented">
                  <button
                    className={`segment ${skillMarketProvider === 'skillhub' ? 'active' : ''}`}
                    data-testid="skill-market-skillhub"
                    onClick={() => {
                      setSkillMarketProvider('skillhub')
                      setSkillMarketResults(null)
                    }}
                  >
                    SkillHub
                  </button>
                  <button
                    className={`segment ${skillMarketProvider === 'skillsmp' ? 'active' : ''}`}
                    data-testid="skill-market-skillsmp"
                    onClick={() => {
                      setSkillMarketProvider('skillsmp')
                      setSkillMarketResults(null)
                    }}
                  >
                    SkillsMP
                  </button>
                </div>
                <input
                  className="settings-input"
                  data-testid="skill-market-query"
                  placeholder={t('搜索技能，如 pdf、playwright')}
                  value={skillMarketQuery}
                  onChange={(event) => setSkillMarketQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void searchSkillMarket()
                    }
                  }}
                />
                <button
                  className="btn solid"
                  data-testid="skill-market-search"
                  disabled={skillMarketBusy || !skillMarketQuery.trim()}
                  onClick={() => void searchSkillMarket()}
                >
                  {skillMarketBusy ? t('搜索中…') : t('搜索')}
                </button>
              </div>
              <p className="settings-hint">
                {skillMarketProvider === 'skillhub'
                  ? t('SkillHub 为国内优先源，搜索和下载无需登录；安装包会校验 zip 结构后再写入用户技能目录。')
                  : t(
                      'SkillsMP 是只读社区目录，匿名搜索有每小时额度；设置 SKILLSMP_API_KEY 可使用账号额度。技能从结果指向的 GitHub 仓库安装。',
                    )}
              </p>
              {skillMarketResults ? (
                skillMarketResults.entries.length === 0 ? (
                  <div className="settings-empty" data-testid="skill-market-empty">
                    {t('没有匹配的技能')}
                  </div>
                ) : (
                  <div data-testid="skill-market-results">
                    {skillMarketResults.entries.map((entry) => (
                      <div className="setting-row" key={entry.id} data-testid="skill-market-entry">
                        <div className="setting-main">
                          <div className="setting-name">
                            {entry.name}
                            <span className="settings-badge">
                              {entry.provider === 'skillhub' ? 'SkillHub' : 'SkillsMP'}
                            </span>
                            {entry.version ? <span className="settings-badge">v{entry.version}</span> : null}
                            {entry.installed ? <span className="settings-badge">{t('已安装')}</span> : null}
                            {entry.requiresKey ? <span className="settings-badge">{t('需要 API Key')}</span> : null}
                          </div>
                          <div className="setting-desc">
                            {language === 'zh' ? entry.descriptionZh || entry.description : entry.description}
                          </div>
                          <div className="setting-meta">
                            {[entry.author, entry.category].filter(Boolean).join(' · ')}
                            {entry.stars !== undefined ? ` · ★ ${entry.stars.toLocaleString()}` : ''}
                            {entry.downloads !== undefined ? ` · ${entry.downloads.toLocaleString()} ${t('下载')}` : ''}
                          </div>
                        </div>
                        <div className="setting-actions-col">
                          {entry.homepage ? (
                            <button className="btn btn-quiet" onClick={() => void openExternal(entry.homepage!)}>
                              {t('查看来源')}
                            </button>
                          ) : null}
                          <button
                            className="btn solid"
                            data-testid="skill-market-install"
                            disabled={skillMarketBusy || entry.installed}
                            onClick={() => void installMarketSkill(entry)}
                          >
                            {entry.installed ? t('已安装') : t('安装')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          {tab === 'project' ? (
            <ProjectSettings settings={settings} onSettings={onSettings} onState={onState} onNotice={setNotice} />
          ) : null}
          {tab === 'commands' ? <CommandsSettings onNotice={setNotice} /> : null}
          {tab === 'hooks' ? <HooksSettings onNotice={setNotice} /> : null}
          {tab === 'memory' ? <MemorySettings onNotice={setNotice} /> : null}

          {tab === 'storage' ? <StorageSettings onNotice={setNotice} /> : null}

          {tab === 'mcp' ? (
            <>
              <div className="settings-section-title">{t('MCP 服务器')}</div>
              <p className="settings-note">
                {t('新增和修改写入用户级')} <code>~/.x-code/config.json</code>
                {t('，保存后重新连接。项目级配置需先在 CLI 中完成信任。')}
              </p>
              {settings.mcpProjectSkipped ? (
                <div className="settings-warn">
                  {t('项目级 MCP 配置因未信任被跳过。')}
                  <div className="settings-actions">
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => void apply('settings:mcp-trust-project', {}, 'mcp-trust')}
                    >
                      {busy === 'mcp-trust' ? t('加载中…') : t('信任并加载项目 MCP')}
                    </button>
                  </div>
                </div>
              ) : null}
              {settings.mcpServers.length === 0 ? (
                <div className="settings-empty">{t('尚未配置 MCP 服务器')}</div>
              ) : null}
              {settings.mcpServers.map((server) => {
                const authUrl = server.status.kind === 'needs_auth' ? server.status.authUrl : undefined
                return (
                  <div className="setting-row" key={server.name}>
                    <div className="setting-main">
                      <div className="setting-name">
                        {server.name}
                        <span className={`settings-badge ${server.status.kind === 'connected' ? 'on' : ''}`}>
                          {mcpStatusLabel(server)}
                        </span>
                      </div>
                      <div className="setting-meta">
                        {server.scope === 'user'
                          ? t('用户级')
                          : server.scope === 'project'
                            ? t('项目级')
                            : t('插件提供')}
                        {server.enabled ? '' : t(' · 已禁用')}
                      </div>
                      <div className="setting-code">{mcpSummary(server)}</div>
                      {server.status.kind === 'needs_auth' ? (
                        <div className="settings-actions">
                          <button
                            className="btn"
                            disabled={busy !== null}
                            onClick={() =>
                              void apply('settings:mcp-auth', { name: server.name }, `mcp-auth:${server.name}`)
                            }
                          >
                            {busy === `mcp-auth:${server.name}` ? t('授权中…') : t('重新授权')}
                          </button>
                          {authUrl ? (
                            <button className="link-button" onClick={() => void openExternal(authUrl)}>
                              {t('打开授权页')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <button
                      className="btn"
                      disabled={busy !== null || server.scope !== 'user'}
                      onClick={() => void removeMcp(server.name)}
                    >
                      {t('删除')}
                    </button>
                  </div>
                )
              })}

              <div className="mcp-form">
                <div className="settings-section-title">{t('添加 / 更新')}</div>
                <input
                  className="settings-input"
                  placeholder={t('服务器名称')}
                  value={mcpName}
                  onChange={(event) => setMcpName(event.target.value)}
                />
                <textarea
                  className="settings-textarea"
                  value={mcpJson}
                  spellCheck={false}
                  onChange={(event) => setMcpJson(event.target.value)}
                />
                <div className="provider-actions">
                  <button className="btn solid" disabled={busy !== null} onClick={() => void saveMcp()}>
                    {busy === 'mcp-save' ? t('保存并连接…') : t('保存并连接')}
                  </button>
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => void apply('settings:mcp-reload', {}, 'mcp-reload')}
                  >
                    {busy === 'mcp-reload' ? t('重连中…') : t('重新连接')}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'plugins' ? (
            <>
              <div className="settings-section-title">{t('插件')}</div>
              <p className="settings-note">
                {t(
                  '插件来自已安装的 marketplace 或项目目录。启用状态变更会重新加载技能、子代理、命令、hooks 与 MCP 贡献。',
                )}
              </p>
              <div className="settings-actions">
                <button className="btn" disabled={busy !== null} onClick={() => void importPlugin()}>
                  {busy === 'plugin-import' ? t('导入中…') : t('导入本地插件')}
                </button>
                <span className="settings-hint">{t('选择包含插件清单的目录；市场安装与命令安装见「插件市场」。')}</span>
              </div>
              {settings.pluginErrors.length > 0 ? (
                <div className="settings-warn">{settings.pluginErrors.join('\n')}</div>
              ) : null}
              {settings.plugins.length === 0 ? <div className="settings-empty">{t('未安装插件')}</div> : null}
              {settings.plugins.map((plugin) => (
                <div className="setting-row" key={plugin.id}>
                  <div className="setting-main">
                    <div className="setting-name">{plugin.name}</div>
                    <div className="setting-desc">
                      {plugin.id} · v{plugin.version || '?'} · {plugin.marketplace}
                    </div>
                    <div className="setting-meta">{plugin.scope === 'user' ? t('用户级') : t('项目级')}</div>
                  </div>
                  <div className="setting-actions-col">
                    <button
                      className={`settings-toggle ${plugin.enabled ? 'on' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void apply(
                          'settings:set-plugin-enabled',
                          { id: plugin.id, enabled: !plugin.enabled },
                          `plugin:${plugin.id}`,
                        )
                      }
                    >
                      {plugin.enabled ? t('已启用') : t('已禁用')}
                    </button>
                    {plugin.userConfig && plugin.userConfig.length > 0 ? (
                      <button className="btn" disabled={busy !== null} onClick={() => void openPluginConfig(plugin.id)}>
                        {t('配置')}
                      </button>
                    ) : null}
                    {plugin.scope === 'user' ? (
                      <button
                        className={`btn ${uninstallId === plugin.id ? 'danger' : ''}`}
                        disabled={busy !== null}
                        onClick={() =>
                          uninstallId === plugin.id ? void uninstallPluginEntry(plugin.id) : setUninstallId(plugin.id)
                        }
                      >
                        {uninstallId === plugin.id ? t('确认卸载') : t('卸载')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
              <p className="settings-note">{t('启用状态修改会立即重新加载贡献；卸载会清除缓存与安装记录。')}</p>
            </>
          ) : null}

          {tab === 'market' ? (
            <>
              <div className="settings-section-title">{t('插件市场')}</div>
              <p className="settings-note">
                {t(
                  '从已订阅 marketplace 的缓存中搜索。刷新会重新拉取索引；安装前请确认来源可信，插件可能包含 hooks 与 MCP 服务器。',
                )}
              </p>
              <div className="settings-actions">
                <input
                  className="settings-input"
                  placeholder={t('搜索插件名称、分类或关键词')}
                  value={marketQuery}
                  onChange={(event) => setMarketQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void loadMarketplace(false)
                    }
                  }}
                />
                <button className="btn" disabled={busy !== null} onClick={() => void loadMarketplace(false)}>
                  {t('搜索')}
                </button>
                <button className="btn" disabled={busy !== null} onClick={() => void loadMarketplace(true)}>
                  {busy === 'market-load' ? t('刷新中…') : t('刷新市场')}
                </button>
              </div>
              {market?.errors.length ? <div className="settings-warn">{market.errors.join('\n')}</div> : null}
              {market && market.marketplaces.length > 0 ? (
                <div className="market-meta">
                  {t('已订阅：')}
                  {market.marketplaces.map((item) => `${item.displayName || item.name} (${item.count})`).join(' · ')}
                </div>
              ) : null}
              {market && market.entries.length === 0 ? (
                <div className="settings-empty">{t('没有匹配的插件。缓存为空时请先「刷新市场」。')}</div>
              ) : null}
              {market?.entries.map((entry) => (
                <div className="market-entry" key={entry.id}>
                  <div className="setting-main">
                    <div className="setting-name">
                      {entry.name}
                      {entry.verified ? <span className="settings-badge on">{t('已认证')}</span> : null}
                      {entry.installed ? <span className="settings-badge on">{t('已安装')}</span> : null}
                    </div>
                    <div className="setting-desc">{entry.description || t('无描述')}</div>
                    <div className="setting-meta">
                      {entry.id}
                      {entry.version ? ` · v${entry.version}` : ''}
                      {entry.category ? ` · ${entry.category}` : ''}
                    </div>
                    {entry.homepage ? (
                      <button className="link-button" onClick={() => void openExternal(entry.homepage!)}>
                        {t('主页')}
                      </button>
                    ) : null}
                  </div>
                  <button
                    className="btn solid"
                    disabled={busy !== null || entry.installed}
                    onClick={() => void installMarketEntry(entry)}
                  >
                    {busy === `market:${entry.id}` ? t('安装中…') : entry.installed ? t('已安装') : t('安装')}
                  </button>
                </div>
              ))}

              <div className="market-form">
                <div className="settings-section-title">{t('从安装命令安装')}</div>
                <p className="settings-note">
                  {t('支持粘贴')} <code>xc plugin install &lt;目标&gt;</code> {t('或')}{' '}
                  <code>claude plugin install &lt;目标&gt;</code>
                  {t('。只解析目标参数，不会执行 shell。')}
                </p>
                <div className="settings-actions">
                  <input
                    className="settings-input"
                    placeholder="xc plugin install name@marketplace"
                    value={installCommand}
                    onChange={(event) => setInstallCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void runInstallCommand()
                      }
                    }}
                  />
                  <button
                    className="btn solid"
                    disabled={busy !== null || !installCommand.trim()}
                    onClick={() => void runInstallCommand()}
                  >
                    {busy === 'install-command' ? t('安装中…') : t('执行安装')}
                  </button>
                </div>
              </div>

              <div className="market-form">
                <div className="settings-section-title">{t('添加市场')}</div>
                <p className="settings-note">
                  {t('来源可以是')} <code>github:owner/repo</code>、Git URL，或 marketplace.json 的 HTTPS 地址。
                </p>
                <div className="settings-actions">
                  <input
                    className="settings-input"
                    placeholder={t('市场名称（如 my-market）')}
                    value={marketName}
                    onChange={(event) => setMarketName(event.target.value)}
                  />
                  <input
                    className="settings-input"
                    placeholder={t('来源')}
                    value={marketSource}
                    onChange={(event) => setMarketSource(event.target.value)}
                  />
                  <button className="btn" disabled={busy !== null} onClick={() => void addMarket()}>
                    {busy === 'market-add' ? t('添加中…') : t('添加并刷新')}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'tools' ? (
            <>
              <div className="settings-section-title">{t('工具')}</div>
              <p className="settings-note">
                {t(
                  '禁用后，下一轮对话不再向模型提供该工具。禁用任意工具会切换到受限工具面（内置工具直接注入、不再按需加载），并可能增加提示体积；全部恢复后回到默认工具面。',
                )}
              </p>
              <div className="setting-row" data-testid="shell-sandbox">
                <div className="setting-main">
                  <div className="setting-name">{t('Shell 沙箱（macOS）')}</div>
                  <div className="setting-desc">
                    {settings.shellSandbox.supported
                      ? t(
                          'Agent 执行的 shell 命令运行在 workspace-write 沙箱中：仅可写入工作区与临时目录，敏感目录不可读写，网络默认禁用，密钥类环境变量会被清理。右侧终端始终不受限制；Hooks 与 MCP 可通过下方开关一并纳入沙箱。',
                        )
                      : t('当前平台暂不支持该沙箱（仅 macOS）。')}
                  </div>
                </div>
                <div className="setting-actions-col">
                  <button
                    className={`settings-toggle ${settings.shellSandbox.enabled ? 'on' : ''}`}
                    disabled={busy !== null || !settings.shellSandbox.supported}
                    onClick={() =>
                      void apply(
                        'settings:set-shell-sandbox',
                        { enabled: !settings.shellSandbox.enabled },
                        'shell-sandbox',
                      )
                    }
                  >
                    {settings.shellSandbox.enabled ? t('已开启（点击关闭）') : t('开启')}
                  </button>
                  {settings.shellSandbox.supported && settings.shellSandbox.enabled ? (
                    <button
                      className={`settings-toggle ${settings.shellSandbox.allowNetwork ? 'on' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void apply(
                          'settings:set-shell-sandbox',
                          { allowNetwork: !settings.shellSandbox.allowNetwork },
                          'shell-sandbox-net',
                        )
                      }
                    >
                      {settings.shellSandbox.allowNetwork ? t('允许网络（点击禁用）') : t('允许网络')}
                    </button>
                  ) : null}
                  {settings.shellSandbox.supported && settings.shellSandbox.enabled ? (
                    <button
                      className={`settings-toggle ${settings.shellSandbox.extensions ? 'on' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void apply(
                          'settings:set-shell-sandbox',
                          { extensions: !settings.shellSandbox.extensions },
                          'shell-sandbox-ext',
                        )
                      }
                      title={t(
                        'Hooks 使用与 shell 相同的网络设置；stdio MCP 服务器保留网络访问，但写入仅限工作区与临时目录。',
                      )}
                    >
                      {settings.shellSandbox.extensions
                        ? t('Hooks / MCP 也在沙箱（点击关闭）')
                        : t('同时沙箱 Hooks / MCP')}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className={`setting-row ${settings.alwaysAllowAll ? 'risk' : ''}`}>
                <div className="setting-main">
                  <div className="setting-name">{t('全部工具始终允许')}</div>
                  <div className="setting-desc">
                    {t(
                      '跳过所有工具的权限确认（等价于 trustMode），包括写入、编辑和执行命令。只应在完全信任当前会话时开启。',
                    )}
                  </div>
                </div>
                <button
                  className={`settings-toggle ${settings.alwaysAllowAll ? 'on' : ''}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void apply('settings:set-always-allow-all', { enabled: !settings.alwaysAllowAll }, 'allow-all')
                  }
                >
                  {settings.alwaysAllowAll ? t('已开启（点击关闭）') : t('开启')}
                </button>
              </div>
              {settings.alwaysAllowAll ? (
                <div className="settings-warn">{t('全部工具已自动放行，写文件和执行命令不会再弹出确认。')}</div>
              ) : null}
              <div className="setting-row" data-testid="browser-agent">
                <div className="setting-main">
                  <div className="setting-name">{t('浏览器子代理')}</div>
                  <div className="setting-desc">
                    {t(
                      '允许 task 工具把点击、输入、登录等多步浏览器操作委派给 browser 子代理。首次使用会通过 npx @playwright/mcp 启动受管 Chrome（需要 Node 和 Chrome，首次可能需要数十秒）。',
                    )}
                  </div>
                </div>
                <div className="setting-actions-col">
                  <button
                    className={`settings-toggle ${settings.browser.enabled ? 'on' : ''}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void apply('settings:set-browser-enabled', { enabled: !settings.browser.enabled }, 'browser')
                    }
                  >
                    {settings.browser.enabled ? t('已开启（点击关闭）') : t('开启')}
                  </button>
                </div>
              </div>
              <div className="setting-row" data-testid="browser-visual-check">
                <div className="setting-main">
                  <div className="setting-name">{t('自动视觉检查')}</div>
                  <div className="setting-desc">
                    {t('根代理在显著的界面改动后，可对 localhost 截取一次临时截图。与浏览器子代理独立开关。')}
                  </div>
                </div>
                <div className="setting-actions-col">
                  <button
                    className={`settings-toggle ${settings.browser.visualCheck ? 'on' : ''}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void apply(
                        'settings:set-browser-visual-check',
                        { enabled: !settings.browser.visualCheck },
                        'browser-visual',
                      )
                    }
                  >
                    {settings.browser.visualCheck ? t('已开启（点击关闭）') : t('开启')}
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">{t('工具面')}</div>
                  <div className="setting-desc">{t('完整保留全部内置工具；标准只提供常用子集。')}</div>
                </div>
                <div className="segmented">
                  <button
                    className={`segment ${settings.toolProfile === 'full' ? 'active' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void apply('settings:set-tool-profile', { profile: 'full' }, 'profile')}
                  >
                    {t('完整')}
                  </button>
                  <button
                    className={`segment ${settings.toolProfile === 'standard' ? 'active' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void apply('settings:set-tool-profile', { profile: 'standard' }, 'profile')}
                  >
                    {t('标准')}
                  </button>
                </div>
              </div>
              {settings.tools.map((tool) => (
                <div className="setting-row" key={tool.name}>
                  <div className="setting-main">
                    <div className="setting-name">
                      {t(tool.label)}
                      <span className="settings-badge">{tool.name}</span>
                      {tool.needsPermission ? <span className="settings-badge">{t('需要授权')}</span> : null}
                    </div>
                    <div className="setting-desc">{t(tool.description)}</div>
                  </div>
                  <div className="setting-actions-col">
                    <button
                      className={`settings-toggle ${tool.enabled ? 'on' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void apply(
                          'settings:set-tool-enabled',
                          { name: tool.name, enabled: !tool.enabled },
                          `tool:${tool.name}`,
                        )
                      }
                    >
                      {tool.enabled ? t('已启用') : t('已禁用')}
                    </button>
                    {tool.needsPermission ? (
                      <button
                        className={`settings-toggle ${tool.alwaysAllow ? 'on' : ''}`}
                        disabled={busy !== null}
                        onClick={() =>
                          void apply(
                            'settings:set-tool-always-allow',
                            { name: tool.name, enabled: !tool.alwaysAllow },
                            `always:${tool.name}`,
                          )
                        }
                      >
                        {tool.alwaysAllow ? t('已始终允许') : t('始终允许')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </>
          ) : null}
          {tab === 'permissions' ? (
            <div data-testid="permissions-tab">
              <div className="settings-section-title">{t('权限规则')}</div>
              <p className="settings-note">
                {t(
                  '这里显示当前项目已持久化的“不再询问”规则。规则只会跳过“询问”级操作，不会绕过拒绝级命令、路径校验或计划模式。',
                )}
              </p>
              <div className="settings-actions">
                <input
                  className="settings-input"
                  data-testid="permission-tool"
                  value={permissionTool}
                  placeholder={t('工具名，如 shell')}
                  onChange={(event) => setPermissionTool(event.target.value)}
                />
                <select
                  className="settings-input"
                  data-testid="permission-type"
                  value={permissionType}
                  onChange={(event) => setPermissionType(event.target.value as PermissionRuleType)}
                >
                  <option value="prefix">{t('前缀匹配')}</option>
                  <option value="exact">{t('完全匹配')}</option>
                  <option value="tool">{t('整个工具')}</option>
                </select>
                <input
                  className="settings-input"
                  data-testid="permission-pattern"
                  value={permissionPattern}
                  disabled={permissionType === 'tool'}
                  placeholder={t('命令前缀或完整命令')}
                  onChange={(event) => setPermissionPattern(event.target.value)}
                />
                <button
                  className="btn solid"
                  data-testid="permission-add"
                  disabled={busy !== null || (permissionType !== 'tool' && permissionPattern.trim().length === 0)}
                  onClick={() => void addPermissionRule()}
                >
                  {t('添加规则')}
                </button>
              </div>
              <p className="settings-hint">{t('前缀与精确匹配只对 shell 生效；其他工具请使用“整个工具”。')}</p>
              {permissionRules === null ? (
                <p className="settings-hint">{t('加载中…')}</p>
              ) : permissionRules.length === 0 ? (
                <p className="settings-hint" data-testid="permission-empty">
                  {t('暂无持久化权限规则。')}
                </p>
              ) : (
                <div data-testid="permission-rules">
                  {permissionRules.map((rule) => (
                    <div className="setting-row" key={`${rule.tool}:${rule.type}:${rule.pattern}:${rule.cwd ?? ''}`}>
                      <div className="setting-main">
                        <div className="setting-name">
                          <span className="settings-badge">{rule.tool}</span>
                          {rule.label}
                        </div>
                        <div className="setting-desc">
                          {rule.type === 'prefix'
                            ? t('前缀匹配')
                            : rule.type === 'exact'
                              ? t('完全匹配')
                              : t('整个工具')}
                          {rule.cwd ? ` · ${rule.cwd}` : ''}
                        </div>
                      </div>
                      <button
                        className="btn"
                        data-testid="permission-remove"
                        data-rule={rule.label}
                        disabled={busy !== null}
                        onClick={() => void removePermissionRule(rule)}
                      >
                        {t('删除')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {tab === 'library' ? (
            <div data-testid="library-tab">
              <div className="settings-section-title">{t('文档库')}</div>
              <p className="settings-note">
                {t(
                  '文档库在本机建立索引：解析 PDF、Word、Excel、Markdown 等文档并分块，供关键词与可选语义检索使用。最多索引 200 个文件 / 500 万字符；内容不会上传。',
                )}
              </p>

              {library ? (
                <>
                  <div className="library-status">
                    <div>
                      <span>{t('文件')}</span>
                      <b>{library.files}</b>
                    </div>
                    <div>
                      <span>{t('分块')}</span>
                      <b>{library.chunks}</b>
                    </div>
                    <div>
                      <span>{t('字符')}</span>
                      <b>{library.characters}</b>
                    </div>
                    <div>
                      <span>{t('向量')}</span>
                      <b>
                        {library.vectors}
                        {library.dimensions > 0 ? ` (${library.dimensions}d)` : ''}
                      </b>
                    </div>
                  </div>

                  <div className="setting-row">
                    <div className="setting-main">
                      <div className="setting-name">{t('语义索引')}</div>
                      <div className="setting-desc">{library.semantic.note}</div>
                    </div>
                    <button
                      className={`settings-toggle ${library.semanticEnabled ? 'on' : ''}`}
                      disabled={libraryBusy !== null}
                      onClick={() => void toggleLibrarySemantic()}
                    >
                      {library.semanticEnabled ? t('已开启（点击关闭）') : t('开启')}
                    </button>
                  </div>

                  <div className="settings-actions">
                    <button
                      className="settings-btn"
                      data-testid="library-index"
                      disabled={libraryBusy !== null}
                      onClick={() => void indexLibraryAt(workspace)}
                    >
                      {libraryBusy === 'library-index' ? t('索引中…') : t('索引当前项目')}
                    </button>
                    <button
                      className="settings-btn"
                      disabled={libraryBusy !== null}
                      onClick={() => void pickLibraryFolder()}
                    >
                      {t('选择文件夹并索引…')}
                    </button>
                    <button
                      className="settings-btn"
                      disabled={libraryBusy !== null || !library.lastRoot}
                      onClick={() => void indexLibraryAt(library.lastRoot ?? workspace, true)}
                    >
                      {libraryBusy === 'library-rebuild' ? t('重建中…') : t('重建上次索引')}
                    </button>
                    {libraryConfirmClear ? (
                      <>
                        <button className="settings-btn danger" onClick={() => void clearLibraryIndex()}>
                          {t('确认清空')}
                        </button>
                        <button className="settings-btn" onClick={() => setLibraryConfirmClear(false)}>
                          {t('取消')}
                        </button>
                      </>
                    ) : (
                      <button className="settings-btn" onClick={() => setLibraryConfirmClear(true)}>
                        {t('清空索引')}
                      </button>
                    )}
                  </div>
                  {libraryProgress ? <div className="settings-hint">{libraryProgress}</div> : null}

                  <div className="settings-section-title">{t('检索')}</div>
                  <div className="settings-actions">
                    <input
                      className="settings-input"
                      data-testid="library-search-input"
                      value={libraryQuery}
                      placeholder={t('搜索已索引的文档…')}
                      onChange={(event) => setLibraryQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void runLibrarySearch()
                      }}
                    />
                    <button
                      className="settings-btn primary"
                      data-testid="library-search-run"
                      disabled={libraryBusy !== null || !libraryQuery.trim()}
                      onClick={() => void runLibrarySearch()}
                    >
                      {libraryBusy === 'library-search' ? t('检索中…') : t('检索')}
                    </button>
                  </div>
                  {librarySearch ? (
                    <div className="library-results" data-testid="library-results">
                      <div className="settings-hint">
                        {librarySearch.mode === 'hybrid' ? t('混合检索（关键词 + 语义）') : t('关键词检索')} ·{' '}
                        {t('{{count}} 条结果', { count: librarySearch.results.length })}
                      </div>
                      {librarySearch.results.map((result, index) => (
                        <button
                          key={`${result.filePath}-${index}`}
                          className="library-result"
                          onClick={() => onOpenDocument(result.filePath, result.page)}
                        >
                          <span className="library-result-title">
                            {result.fileName}
                            {result.page ? ` · ${t('第 {{page}} 页', { page: result.page })}` : ''}
                          </span>
                          <span className="library-result-snippet">{result.snippet}</span>
                          <span className="library-result-path">{result.filePath}</span>
                        </button>
                      ))}
                      {librarySearch.results.length === 0 ? (
                        <div className="settings-empty">{t('没有匹配的文档')}</div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="settings-hint">{library.indexPath}</div>
                </>
              ) : (
                <div className="settings-empty">{t('加载中…')}</div>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      {pluginPreview && preview ? (
        <div className="modal-scrim">
          <div className="approval-card plugin-preview" data-testid="plugin-consent">
            <header className="approval-head">
              <span className="drawer-seal" aria-hidden="true">
                {t('装')}
              </span>
              <div>
                <div className="approval-title">{t('安装插件')}</div>
                <div className="approval-sub">
                  {preview.pluginId} · v{preview.version}
                </div>
              </div>
            </header>
            <div className="approval-body text">
              <div>{preview.description || t('无描述')}</div>
              <div className="preview-grid">
                <div>
                  <span>{t('来源')}</span>
                  <span>
                    {preview.source.kind} · {preview.source.label}
                  </span>
                </div>
                <div>
                  <span>{t('市场')}</span>
                  <span>
                    {preview.marketplace}
                    {preview.verified ? t(' · 已认证') : ''}
                    {preview.fromReservedMarketplace ? t(' · 官方') : ''}
                  </span>
                </div>
                <div>
                  <span>{t('贡献')}</span>
                  <span>{previewContributions || t('无')}</span>
                </div>
                <div>
                  <span>Hooks</span>
                  <span>
                    {preview.hookEvents.join(language === 'zh' ? '、' : ', ') ||
                      (preview.hasPathHooks ? t('通过文件提供') : t('无'))}
                  </span>
                </div>
                <div>
                  <span>MCP</span>
                  <span>
                    {preview.inlineMcpServerNames.join(language === 'zh' ? '、' : ', ') ||
                      (preview.hasPathMcpServers ? t('通过文件提供') : t('无'))}
                  </span>
                </div>
                {preview.author ? (
                  <div>
                    <span>{t('作者')}</span>
                    <span>{preview.author}</span>
                  </div>
                ) : null}
                {preview.license ? (
                  <div>
                    <span>{t('许可')}</span>
                    <span>{preview.license}</span>
                  </div>
                ) : null}
                {preview.homepage ? (
                  <div>
                    <span>{t('主页')}</span>
                    <button className="link-button" onClick={() => void openExternal(preview.homepage!)}>
                      {preview.homepage}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {previewRisk ? (
              <div className="settings-warn">
                {t('此插件会注册 hooks 或 MCP 服务器，安装后相关命令会在本机执行。仅在你信任来源时继续。')}
              </div>
            ) : null}
            {preview.userConfig && preview.userConfig.length > 0 ? (
              <div className="plugin-config-form" data-testid="plugin-config-form">
                <div className="settings-section-title">{t('插件配置')}</div>
                <p className="settings-note">{t('该插件需要以下配置；安装后可在「插件」页修改。')}</p>
                {preview.userConfig.map((field) => renderConfigField(field, pluginConfigDraft, setPluginConfigDraft))}
              </div>
            ) : null}
            <div className="approval-actions">
              <button className="btn" onClick={() => setPluginPreview(null)}>
                {t('取消')}
              </button>
              <button
                className="btn solid"
                disabled={busy !== null || !configFieldsComplete(preview.userConfig ?? [], pluginConfigDraft)}
                onClick={() => void confirmPluginInstall()}
              >
                {busy === 'plugin-install' ? t('安装中…') : t('确认安装')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pluginConfig ? (
        <div className="modal-scrim">
          <div className="approval-card plugin-preview" data-testid="plugin-config">
            <header className="approval-head">
              <span className="drawer-seal" aria-hidden="true">
                {t('配')}
              </span>
              <div>
                <div className="approval-title">{t('插件配置')}</div>
                <div className="approval-sub">{pluginConfig.id}</div>
              </div>
            </header>
            <div className="approval-body text">
              {pluginConfig.fields.map((field) =>
                renderConfigField(field, pluginConfigEditDraft, setPluginConfigEditDraft, pluginConfig.setKeys),
              )}
            </div>
            <div className="approval-actions">
              <button className="btn" onClick={() => setPluginConfig(null)}>
                {t('取消')}
              </button>
              <button
                className="btn solid"
                disabled={busy !== null || !configFieldsComplete(pluginConfig.fields, pluginConfigEditDraft)}
                onClick={() => void savePluginConfigValues()}
              >
                {busy === 'plugin-config' ? t('保存中…') : t('保存')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
