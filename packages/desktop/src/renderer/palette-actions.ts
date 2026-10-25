import type { TFunction } from 'i18next'

import type { Dispatch, SetStateAction } from 'react'

import type { AppState, DiagnosticsExportResult } from '../shared/protocol.js'
import type { PaletteAction } from './CommandPalette.js'
import type { InspectorTab } from './Inspector.js'

export interface PaletteActionContext {
  t: TFunction
  appState: AppState | null
  terminalOpen: boolean
  recording: boolean
  newSession: () => Promise<void>
  openInNewWindow: (withCurrent?: boolean) => Promise<void>
  openBranchPicker: () => Promise<void>
  openSettings: (tab?: string) => Promise<void>
  openFilesPanel: (path?: string | null) => void
  openInEditor: (path: string, line?: number) => void
  openDocumentPanel: () => Promise<void>
  openGitPanel: () => Promise<void>
  openChecksPanel: () => Promise<void>
  toggleInspector: (tab: InspectorTab) => void
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setBackgroundOpen: Dispatch<SetStateAction<boolean>>
  setRewindOpen: Dispatch<SetStateAction<boolean>>
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
  setShortcutSheetOpen: Dispatch<SetStateAction<boolean>>
  setManualOpen: Dispatch<SetStateAction<boolean>>
  setReport: Dispatch<SetStateAction<string | null>>
  forkCurrentSession: () => Promise<void>
  scanLocalModels: () => Promise<void>
  runCompact: () => Promise<void>
  exportCurrentSession: (format: 'markdown' | 'json' | 'pdf') => Promise<void>
  cycleTheme: () => void
  toggleLanguage: () => void
  runDiagnostics: () => Promise<void>
  pickDocument: () => Promise<void>
  captureRegion: () => Promise<void>
  captureScreen: () => Promise<void>
  toggleRecording: () => void
}

export function createPaletteActions(context: PaletteActionContext): PaletteAction[] {
  const {
    t,
    appState,
    terminalOpen,
    recording,
    newSession,
    openInNewWindow,
    openBranchPicker,
    openSettings,
    openFilesPanel,
    openInEditor,
    openDocumentPanel,
    openGitPanel,
    openChecksPanel,
    toggleInspector,
    setSettingsOpen,
    setBackgroundOpen,
    setRewindOpen,
    setSidebarOpen,
    setShortcutSheetOpen,
    setManualOpen,
    setReport,
    forkCurrentSession,
    scanLocalModels,
    runCompact,
    exportCurrentSession,
    cycleTheme,
    toggleLanguage,
    runDiagnostics,
    pickDocument,
    captureRegion,
    captureScreen,
    toggleRecording,
  } = context
  return [
    { id: 'new-session', label: t('新建会话'), hint: '⌘N', run: () => newSession() },
    { id: 'new-window', label: t('新建窗口'), hint: '⌘⇧N', run: () => openInNewWindow(false) },
    {
      id: 'branch-window',
      label: t('在新窗口打开分支'),
      hint: t('Git worktree'),
      keywords: ['branch', 'worktree', '分支', '工作树'],
      run: () => void openBranchPicker(),
    },
    {
      id: 'current-to-window',
      label: t('将当前会话移到新窗口'),
      hint: '⧉',
      run: () => openInNewWindow(true),
    },
    { id: 'settings', label: t('打开设置'), hint: '⌘,', run: () => openSettings() },
    { id: 'project-settings', label: t('项目设置'), hint: t('当前工作区'), run: () => openSettings('project') },
    { id: 'memory-settings', label: t('用户记忆'), hint: t('主题与事实'), run: () => openSettings('memory') },
    {
      id: 'storage-settings',
      label: t('存储与清理'),
      hint: t('会话 / 附件 / 模型'),
      run: () => openSettings('storage'),
    },
    { id: 'hooks-settings', label: t('Hooks'), hint: t('用户级 / 项目级'), run: () => openSettings('hooks') },
    { id: 'commands-settings', label: t('自定义命令'), hint: t('斜杠命令'), run: () => openSettings('commands') },
    { id: 'files', label: t('文件浏览器与编辑器'), hint: t('浏览工作区'), run: () => openFilesPanel() },
    {
      id: 'workspace-editor',
      label: t('在编辑器中打开工作区'),
      hint: 'VS Code / Cursor',
      run: () => openInEditor(appState?.workspace ?? ''),
    },
    {
      id: 'workspace-reveal',
      label: t('在文件管理器中显示工作区'),
      hint: 'Finder',
      run: () =>
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:reveal-path',
          params: { path: appState?.workspace ?? '' },
        }),
    },
    { id: 'documents', label: t('文档面板'), hint: t('PDF / Office / 表格'), run: () => openDocumentPanel() },
    {
      id: 'attach',
      label: t('附加文件或图片'),
      hint: t('文档 / 图片 / 音频'),
      keywords: ['attach', 'file', 'upload', '图片', '附件', '上传', 'pdf'],
      run: () => pickDocument(),
    },
    {
      id: 'capture-region',
      label: t('截图：框选区域'),
      hint: t('屏幕截图'),
      keywords: ['screenshot', 'capture', 'region', '截图', '截屏'],
      run: () => captureRegion(),
    },
    {
      id: 'capture-screen',
      label: t('截图：整个屏幕'),
      hint: t('屏幕截图'),
      keywords: ['screenshot', 'capture', 'screen', '截图', '截屏'],
      run: () => captureScreen(),
    },
    {
      id: 'voice',
      label: recording ? t('停止录音并转写') : t('语音输入'),
      hint: t('本地 Whisper'),
      keywords: ['voice', 'microphone', 'mic', '录音', '语音', '转写'],
      run: () => toggleRecording(),
    },
    {
      id: 'skill-market',
      label: t('技能市场'),
      hint: 'SkillHub / SkillsMP',
      keywords: ['skill', 'market', 'marketplace', '技能', '安装技能'],
      run: () => openSettings('skillmarket'),
    },
    {
      id: 'permissions',
      label: t('权限规则'),
      hint: t('不再询问 / 允许'),
      keywords: ['permission', 'allow', 'deny', '权限', '授权'],
      run: () => openSettings('permissions'),
    },
    {
      id: 'model-settings',
      label: t('模型与密钥'),
      hint: t('API Key / 上下文上限'),
      keywords: ['api', 'key', 'model', 'context', '模型', '密钥', '上下文'],
      run: () => openSettings('api'),
    },
    {
      id: 'tools-settings',
      label: t('工具与浏览器子代理'),
      hint: t('启用 / 沙箱'),
      keywords: ['tools', 'browser', 'sandbox', '工具', '浏览器', '沙箱'],
      run: () => openSettings('tools'),
    },
    {
      id: 'library',
      label: t('文档库'),
      hint: t('索引 / 搜索'),
      keywords: ['library', 'index', 'search', '索引', '检索'],
      run: () => openSettings('library'),
    },
    {
      id: 'git',
      label: t('Git 变更'),
      hint: t('查看与回退'),
      keywords: ['git', 'diff', 'undo', '撤销', '版本'],
      run: () => openGitPanel(),
    },
    {
      id: 'checks',
      label: t('项目检查'),
      hint: t('类型检查 / 测试'),
      keywords: ['test', 'lint', 'typecheck', '测试', '检查'],
      run: () => openChecksPanel(),
    },
    {
      id: 'terminal',
      label: terminalOpen ? t('收起终端') : t('打开终端'),
      hint: 'PTY',
      run: () => {
        setSettingsOpen(false)
        toggleInspector('terminal')
      },
    },
    { id: 'background', label: t('后台任务'), hint: t('查看与停止'), run: () => setBackgroundOpen(true) },
    { id: 'rewind', label: t('回退到检查点'), hint: t('代码 / 对话'), run: () => setRewindOpen(true) },
    { id: 'fork', label: t('从当前会话分叉'), hint: t('新建分支'), run: () => forkCurrentSession() },
    { id: 'scan-local', label: t('扫描本地模型'), hint: 'Ollama / LM Studio', run: () => scanLocalModels() },
    { id: 'compact', label: t('压缩上下文'), hint: t('手动压缩'), run: () => runCompact() },
    { id: 'export-md', label: t('导出会话为 Markdown'), hint: 'Markdown', run: () => exportCurrentSession('markdown') },
    { id: 'export-json', label: t('导出会话为 JSON'), hint: 'JSON', run: () => exportCurrentSession('json') },
    { id: 'export-pdf', label: t('导出会话为 PDF'), hint: 'PDF', run: () => exportCurrentSession('pdf') },
    { id: 'theme', label: t('切换主题'), hint: t('浅色 / 深色 / 跟随系统'), run: () => cycleTheme() },
    { id: 'language', label: t('切换语言'), hint: '中文 / English', run: () => toggleLanguage() },
    { id: 'sidebar', label: t('显示 / 隐藏侧边栏'), hint: '', run: () => setSidebarOpen((open) => !open) },
    {
      id: 'diagnostics',
      label: t('运行诊断'),
      hint: t('环境 / 插件 / MCP'),
      run: () => runDiagnostics(),
    },
    {
      id: 'export-diagnostics',
      label: t('导出诊断包'),
      hint: t('不含密钥的 JSON 快照'),
      keywords: ['diagnostics', 'support', 'diagnose', '诊断', '日志', '支持'],
      run: async () => {
        const response = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'diagnostics:export',
          params: {},
        })
        if (!response.ok) {
          setReport(t('导出诊断失败：{{message}}', { message: response.error.message }))
          return
        }
        setReport(t('诊断包已导出：{{path}}', { path: (response.result as DiagnosticsExportResult).path }))
      },
    },
    {
      id: 'manual',
      label: t('用户手册'),
      hint: t('功能与使用说明'),
      keywords: ['manual', 'help', 'guide', '手册', '帮助', '说明'],
      run: () => setManualOpen(true),
    },
    { id: 'shortcuts', label: t('键盘快捷键'), hint: '?', run: () => setShortcutSheetOpen(true) },
  ]
}
