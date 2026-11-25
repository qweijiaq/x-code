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
  exportCurrentSession: (format: 'markdown' | 'json' | 'html' | 'pdf') => Promise<void>
  setBackgroundOpen: Dispatch<SetStateAction<boolean>>
  toggleThinking: () => Promise<void>
  togglePlan: () => Promise<void>
  setReport: Dispatch<SetStateAction<string | null>>
  newSession: () => Promise<void>
  abort: () => Promise<void>
  submit: (prompt: string, alreadyShown?: boolean, files?: string[]) => Promise<void>
  forkCurrentSession: () => Promise<void>
  setRewindOpen: Dispatch<SetStateAction<boolean>>
  setGoalOpen: Dispatch<SetStateAction<boolean>>
  setContextSearchOpen: Dispatch<SetStateAction<boolean>>
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
    setGoalOpen,
    setContextSearchOpen,
    setManualOpen,
    append,
  } = context

  /** 调用方（App / CommandPalette）用 `void command.run()` 丢弃返回值，所以
   *  命令自己必须兜住 rejection：`openSettings` 里的 `refreshSettings()`、IPC
   *  桥接失败、`submit` 抛错若没人接，全都会变成 unhandled rejection——用户点了
   *  命令既没有反馈也没有日志。 */
  const fireAndForget = (start: () => Promise<void>): void => {
    void start().catch((error: unknown) => {
      append({ role: 'system', text: t('命令执行失败：{{message}}', { message: String(error) }) })
    })
  }

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
    { name: '/settings', description: t('打开设置'), run: () => fireAndForget(() => openSettings()) },
    { name: '/doc', description: t('打开文档面板'), run: () => fireAndForget(() => openDocumentPanel()) },
    { name: '/files', description: t('打开文件浏览器与编辑器'), run: () => openInspector('file') },
    { name: '/git', description: t('查看 Git 变更'), run: () => fireAndForget(() => openGitPanel()) },
    { name: '/checks', description: t('运行项目检查'), run: () => fireAndForget(() => openChecksPanel()) },
    { name: '/sessions', description: t('显示侧边栏'), run: () => fireAndForget(() => openSidebar()) },
    { name: '/resume', description: t('显示侧边栏并选择会话'), run: () => fireAndForget(() => openSidebar()) },
    {
      name: '/terminal',
      description: t('展开 / 收起终端'),
      run: () => {
        setSettingsOpen(false)
        setModelMenuOpen(false)
        toggleInspector('terminal')
      },
    },
    { name: '/diagnostics', description: t('运行诊断'), run: () => fireAndForget(() => runDiagnostics()) },
    { name: '/manual', description: t('打开用户手册'), run: () => setManualOpen(true) },
    { name: '/compact', description: t('压缩上下文'), run: () => fireAndForget(() => runCompact()) },
    {
      name: '/context',
      description: t('查看上下文构成'),
      run: () => fireAndForget(() => requestTextReport('context:stats')),
    },
    {
      name: '/usage',
      description: t('查看本会话用量'),
      run: () => fireAndForget(() => requestTextReport('usage:summary')),
    },
    {
      name: '/export',
      description: t('导出当前会话（markdown / json / pdf）'),
      run: () => fireAndForget(() => exportCurrentSession('markdown')),
    },
    {
      name: '/usage-history',
      description: t('查看最近会话用量'),
      run: () => fireAndForget(() => requestTextReport('usage:history')),
    },
    {
      name: '/doctor',
      description: t('环境 / 插件 / MCP 诊断'),
      run: () => fireAndForget(() => requestTextReport('doctor:run')),
    },
    { name: '/ps', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    { name: '/background', description: t('后台任务面板'), run: () => setBackgroundOpen(true) },
    {
      name: '/list-agents',
      description: t('列出子代理'),
      run: () => fireAndForget(() => requestTextReport('agents:list')),
    },
    { name: '/search', description: t('全局检索本地上下文'), run: () => setContextSearchOpen(true) },
    { name: '/goal', description: t('查看 goal 状态'), run: () => setGoalOpen(true) },
    { name: '/thinking', description: t('切换思考模式'), run: () => fireAndForget(() => toggleThinking()) },
    { name: '/plan', description: t('切换计划模式'), run: () => fireAndForget(() => togglePlan()) },
    {
      name: '/clear',
      description: t('新建会话并清空对话'),
      run: () => {
        setReport(null)
        fireAndForget(() => newSession())
      },
    },
    { name: '/stop', description: t('停止当前回复'), run: () => fireAndForget(() => abort()) },
    {
      name: '/init',
      description: t('分析仓库并生成 AGENTS.md'),
      run: () => {
        append({ role: 'system', text: t('执行 /init') })
        fireAndForget(() => submit(INIT_PROMPT, true))
      },
    },
    {
      name: '/review',
      description: t('审查当前改动'),
      run: () => {
        append({ role: 'system', text: t('执行 /review') })
        fireAndForget(() => submit(REVIEW_PROMPT, true))
      },
    },
    {
      name: '/fork',
      description: t('从当前会话派生一个新分支'),
      run: () => fireAndForget(() => forkCurrentSession()),
    },
    {
      name: '/rewind',
      description: t('回退到检查点（代码 / 对话）'),
      run: () => setRewindOpen(true),
    },
    {
      name: '/memory',
      description: t('查看用户记忆'),
      run: () => fireAndForget(() => requestTextReport('memory:get')),
    },
    {
      name: '/theme',
      description: t('打开外观设置（亮色 / 暗色 / 跟随系统）'),
      run: () => fireAndForget(() => openSettings()),
    },
    {
      name: '/browser',
      description: t('打开浏览器子代理与视觉检查设置'),
      run: () => fireAndForget(() => openSettings('tools')),
    },
    {
      name: '/exit',
      description: t('退出应用'),
      run: () =>
        fireAndForget(async () => {
          // 旧实现用 `void` 把 rejection 和 `ok: false` 一起丢掉：IPC 桥接挂掉时
          // 用户按 /exit 什么都不会发生，也没有任何提示。
          const response = await window.xcode.request({ id: crypto.randomUUID(), method: 'app:quit', params: {} })
          if (!response.ok) throw new Error(response.error.message)
        }),
    },
  ]
}
