import type { TFunction } from 'i18next'

import type { Dispatch, SetStateAction } from 'react'

import type { InspectorTab } from './Inspector.js'

export interface SlashCommand {
  name: string
  description: string
  run: () => void | Promise<void>
}

export const INIT_PROMPT =
  'Analyze this repository and create or update AGENTS.md at the project root. Follow the existing AGENTS.md conventions if present. Cover the commands, architecture, conventions, and gotchas that a new agent needs. Keep it concise and do not invent facts.'
export const REVIEW_PROMPT =
  'Review the current uncommitted changes (or the work from this session). Report correctness issues, risks, and missing tests. Do not modify files.'

export interface SlashCommandContext {
  t: TFunction
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  closeInspector: () => void
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>
  openSettings: (tab?: string) => Promise<void>
  openDocumentPanel: () => Promise<void>
  openInspector: (tab: InspectorTab) => void
  openGitPanel: () => Promise<void>
  openChecksPanel: () => Promise<void>
  openSidebar: () => Promise<void>
  toggleInspector: (tab: InspectorTab) => void
  runDiagnostics: () => Promise<void>
  runCompact: () => Promise<void>
  requestTextReport: (method: string, params?: Record<string, unknown>) => Promise<void>
  exportCurrentSession: (format: 'markdown' | 'json' | 'pdf') => Promise<void>
  setBackgroundOpen: Dispatch<SetStateAction<boolean>>
  toggleThinking: () => Promise<void>
  togglePlan: () => Promise<void>
  setReport: Dispatch<SetStateAction<string | null>>
  newSession: () => Promise<void>
  abort: () => Promise<void>
  submit: (prompt: string, alreadyShown?: boolean, files?: string[]) => Promise<void>
  forkCurrentSession: () => Promise<void>
  setRewindOpen: Dispatch<SetStateAction<boolean>>
  setManualOpen: Dispatch<SetStateAction<boolean>>
  append: (entry: { role: 'system'; text: string }) => void
}

export function createSlashCommands(context: SlashCommandContext): SlashCommand[] {
  const {
    t,
    setSettingsOpen,
    closeInspector,
    setModelMenuOpen,
    openSettings,
    openDocumentPanel,
    openInspector,
    openGitPanel,
    openChecksPanel,
    openSidebar,
    toggleInspector,
    runDiagnostics,
    runCompact,
    requestTextReport,
    exportCurrentSession,
    setBackgroundOpen,
    toggleThinking,
    togglePlan,
    setReport,
    newSession,
    abort,
    submit,
    forkCurrentSession,
    setRewindOpen,
    setManualOpen,
    append,
  } = context
  return [
    {
      name: '/model',
      description: t('切换模型'),
      run: () => {
        setSettingsOpen(false)
        closeInspector()
        setModelMenuOpen(true)
      },
    },
    { name: '/settings', description: t('打开设置'), run: () => void openSettings() },
    { name: '/doc', description: t('打开文档面板'), run: () => void openDocumentPanel() },
    { name: '/files', description: t('打开文件浏览器与编辑器'), run: () => openInspector('file') },
    { name: '/git', description: t('查看 Git 变更'), run: () => void openGitPanel() },
    { name: '/checks', description: t('运行项目检查'), run: () => void openChecksPanel() },
    { name: '/sessions', description: t('显示侧边栏'), run: () => void openSidebar() },
    { name: '/resume', description: t('显示侧边栏并选择会话'), run: () => void openSidebar() },
    {
      name: '/terminal',
      description: t('展开 / 收起终端'),
      run: () => {
        setSettingsOpen(false)
        setModelMenuOpen(false)
        toggleInspector('terminal')
      },
    },
    { name: '/diagnostics', description: t('运行诊断'), run: () => void runDiagnostics() },
    { name: '/manual', description: t('打开用户手册'), run: () => setManualOpen(true) },
    { name: '/compact', description: t('压缩上下文'), run: () => void runCompact() },
    { name: '/context', description: t('查看上下文构成'), run: () => void requestTextReport('context:stats') },
    { name: '/usage', description: t('查看本会话用量'), run: () => void requestTextReport('usage:summary') },
    {
      name: '/export',
      description: t('导出当前会话（markdown / json / pdf）'),
      run: () => void exportCurrentSession('markdown'),
    },
    {
      name: '/usage-history',
      description: t('查看最近会话用量'),
      run: () => void requestTextReport('usage:history'),
    },
    { name: '/doctor', description: t('环境 / 插件 / MCP 诊断'), run: () => void requestTextReport('doctor:run') },
    { name: '/ps', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    { name: '/background', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    { name: '/list-agents', description: t('列出子代理'), run: () => void requestTextReport('agents:list') },
    { name: '/goal', description: t('查看 goal 状态'), run: () => void requestTextReport('goal:get') },
    { name: '/thinking', description: t('切换思考模式'), run: () => void toggleThinking() },
    { name: '/plan', description: t('切换计划模式'), run: () => void togglePlan() },
    {
      name: '/clear',
      description: t('新建会话并清空对话'),
      run: () => {
        setReport(null)
        void newSession()
      },
    },
    { name: '/stop', description: t('停止当前回复'), run: () => void abort() },
    {
      name: '/init',
      description: t('分析仓库并生成 AGENTS.md'),
      run: () => {
        append({ role: 'system', text: t('执行 /init') })
        void submit(INIT_PROMPT, true)
      },
    },
    {
      name: '/review',
      description: t('审查当前改动'),
      run: () => {
        append({ role: 'system', text: t('执行 /review') })
        void submit(REVIEW_PROMPT, true)
      },
    },
    {
      name: '/fork',
      description: t('从当前会话派生一个新分支'),
      run: () => void forkCurrentSession(),
    },
    {
      name: '/rewind',
      description: t('回退到检查点（代码 / 对话）'),
      run: () => setRewindOpen(true),
    },
    {
      name: '/memory',
      description: t('查看用户记忆'),
      run: () => void requestTextReport('memory:get'),
    },
    { name: '/theme', description: t('主题说明'), run: () => setReport(t('当前仅提供水墨主题。')) },
    {
      name: '/browser',
      description: t('浏览器子代理说明'),
      run: () => setReport(t('浏览器子代理可在 设置 → 工具 中开启或关闭。')),
    },
    {
      name: '/clear-peer-context',
      description: t('peer 上下文说明'),
      run: () => setReport(t('peer 跨会话消息未在桌面端启用。')),
    },
    {
      name: '/exit',
      description: t('退出应用'),
      run: () => void window.xcode.request({ id: crypto.randomUUID(), method: 'app:quit', params: {} }),
    },
  ]
}
