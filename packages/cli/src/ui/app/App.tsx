// @x-code-cli/cli — 根 App 组件
import path from 'node:path'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from 'ink'

import {
  PROVIDER_BASE_URLS,
  createModelRegistry,
  errorMessage,
  estimateTokenCount,
  getAvailableProviders,
  getContextWindow,
  getOpenAIAuthSnapshot,
  getOpenAIAuthStatus,
  getOpenAIChatGPTModelCatalogState,
  getProviderModels,
  getReasoningTierOptions,
  listSessions,
  loadSession,
  loadUserConfig,
  pickLatestSession,
  providerOf,
  refreshOpenAIAuthSnapshot,
  refreshOpenAIChatGPTModels,
  resetVisionModelProviders,
  resolveModelId,
  saveUserConfig,
  supportsReasoningTier,
  wrapActivatedSkill,
} from '@x-code-cli/core'
import type { AgentOptions, CacheMissSummary, DiffStats, LanguageModel, LoadedSession } from '@x-code-cli/core'
import type { SkillDefinition, StepStats, TokenUsage, UsageBreakdown } from '@x-code-cli/core'

import { formatOpenAIAuthStatus, loginChatGPT, logoutChatGPT } from '../../auth-cli.js'
import type { CliCleanupController } from '../../cleanup-controller.js'
import { drainPendingUpdateHint, registerUpdateHintHandler } from '../../startup-prints.js'
import { VERSION } from '../../version.js'
import { visibleBackgroundTerminals } from '../agent/shell-session-ui.js'
import { useAgent } from '../agent/use-agent.js'
import { usePeerInboxAdapter } from '../agent/use-peer-inbox-adapter.js'
import { isSlashCommandAllowedWhileBusy } from '../busy-command.js'
import { ChatInput } from '../chat-input/ChatInput.js'
import { rebuildPalette } from '../chat-input/palette.js'
import { buildThemePreview } from '../render/render-diff.js'
import { setShikiTheme } from '../render/shiki-highlight.js'
import { setSyntaxTheme } from '../render/syntax-highlight.js'
import { GLYPH_BULLET } from '../render/terminal-glyphs.js'
import {
  DEFAULT_THEME,
  THEMES,
  type ThemeName,
  getTheme,
  getThemeColors,
  parseThemeName,
  setTheme,
} from '../render/theme.js'
import { formatCompactionResult, formatTokenCount, parseBooleanArg } from '../utils.js'
import { getHeaderRowCount } from './AppHeader.js'
import { refreshCatalogAfterCommittedLogin } from './chatgpt-login-postflight.js'
import { SLASH_COMMANDS } from './command-content.js'
import { formatStopResult } from './commands/background-terminal.js'
import { createBrowserCommandHandler } from './commands/browser.js'
import { createContextCommandHandler } from './commands/context.js'
import { createDoctorCommandHandler } from './commands/doctor.js'
import { parseGoalCreateArgs, tokenizeArgs } from './commands/goal.js'
import { createMcpCommandHandler } from './commands/mcp.js'
import { createPluginCommandHandler } from './commands/plugin.js'
import { routeSlashCommand } from './commands/router.js'
import { createSkillCommandHandler } from './commands/skill.js'
import { replaceActiveModelProvider } from './model-activation.js'
import {
  commitOpenAIAuthTransition,
  createOpenAIAuthTransitionState,
  needsOpenAIAuthTransition,
  needsOpenAIModelEntitlementCheck,
  openAIModelEntitlementKey,
  planOpenAIModelReconciliation,
} from './openai-auth-transition.js'
import type { SessionExitInfo } from './session-exit.js'
import {
  canResumeGoalStatus,
  compactionHintForResume,
  dedupeChoiceLabels,
  forkLineageHint,
  formatGoalStatus,
  formatRelativeTime,
} from './session-format.js'
import { formatUsageReport } from './usage-report.js'

type ModelRequestPreflightResult = Awaited<ReturnType<NonNullable<AgentOptions['beforeModelRequest']>>>

interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
  /** 来自 `xc --continue` 的预加载会话。在首次渲染时水合 agent，让消息在用户
   *  发送任何内容之前就出现在 scrollback 中。全新启动时为 null。 */
  initialSession?: LoadedSession | null
  /** 当为 'pick' 时，App 在挂载时弹出 resume 选择器——`xc --resume` 标志路径。
   *  一旦 Ink 就绪（这样 askQuestion 才能渲染），就会运行与 `/resume` 相同的
   *  代码路径。 */
  resumeIntent?: 'pick' | null
  onCleanupReady?: (controller: CliCleanupController) => void
  /** 把会话的实时快照交给 post-Ink resume 提示。在 app.tsx 中接线——注册的
   *  getter 在终端重置后由 index.ts 的 gracefulShutdown 调用，这样提示会落在
   *  用户的 shell 提示符区域，方便他们复制 `xc --resume <id>` 命令。 */
  onSessionInfoReady?: (getter: () => SessionExitInfo | null) => void
}

export function App({
  model,
  options,
  initialPrompt,
  initialSession,
  resumeIntent,
  onCleanupReady,
  onSessionInfoReady,
}: AppProps) {
  const { exit } = useApp()
  const {
    state,
    activeTurnOwner,
    hasActiveForkBoundary,
    submit,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
    queueMessage,
    popQueuedMessage,
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    resolvePermission,
    resolveAuthority,
    resolveQuestion,
    abort,
    quiesce,
    cleanup,
    cleanupShells,
    listShellSessions,
    stopShellSessions,
    fork,
    clear,
    clearPeerContext,
    compact,
    resume,
    rewind,
    getCheckpoints,
    getDiffStats,
    getContextBreakdown,
    getSessionInfo,
    switchModel,
    setThinking,
    getThinking,
    reloadMemory,
    invalidateSystemPromptCache,
    addInfoMessage,
    echoCommand,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    setPermissionMode,
  } = useAgent(model, options, initialSession)
  options.beforeModelRequest = handleExternalAuthChange

  const peerInbox = usePeerInboxAdapter({
    service: options.peerService,
    activeOwner: activeTurnOwner,
    dialogsBlocked:
      state.permissionQueue.length > 0 || state.authorityRequest !== null || state.pendingQuestion !== null,
    enqueuePeerInput,
    addPeerStatus,
    addHeldPeerPreview,
    askQuestion,
  })

  // 每当 /skill refresh 原地变更 registry 时自增。registry 的对象身份在 refresh
  // 前后保持稳定（reload() 重写内部 map），所以 React 需要一个显式依赖才能知道
  // 可见技能列表已变化——没有这个计数器，memo 化的 skillCommands 数组会一直
  // 保持过期。
  const [skillRegistryVersion, setSkillRegistryVersion] = useState(0)
  const [authOperation, setAuthOperation] = useState<'login' | 'logout' | null>(null)
  const authControllerRef = useRef<AbortController | null>(null)
  const modelRefreshInProgressRef = useRef(false)
  const unavailableModelRef = useRef<{ authRevision: string; message: string; modelId: string } | null>(null)
  const openAIAuthTransitionRef = useRef(createOpenAIAuthTransitionState(getOpenAIAuthSnapshot()))
  const checkedOpenAIEntitlementKeyRef = useRef<string | null>(null)

  // 当前模型的 reasoning-effort 层级标签（如 "High"、"Max"），显示在 footer 里
  // 模型名旁边。放在 state 里而不是每次渲染都重算，因为 resolveReasoningTierLabel
  // 会同步读配置文件；在 /model 切换和层级选择时刷新。
  const [reasoningTierLabel, setReasoningTierLabel] = useState<string | null>(() =>
    resolveReasoningTierLabel(state.modelId),
  )

  // 派生自 options.skillRegistry。当 registry 版本自增（通过 /skill refresh）时
  // 重算，这样 tab 补全 + /help 无需重启就能反映新的技能集。
  const skillCommands = useMemo(
    () => (options.skillRegistry ? options.skillRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 基于文件的斜杠命令（用户 / 项目 / 插件 markdown 文件）。与技能使用同一个
  // 版本计数器重算——/plugin refresh 在重载两个 registry 后自增它。
  const fileCommands = useMemo(
    () => (options.commandRegistry ? options.commandRegistry.list() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillRegistryVersion],
  )

  // 合并的命令列表：内置 + 已加载技能 + 文件命令（用于 tab 补全）。
  const allCommands = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...skillCommands.map((s) => ({ name: `/${s.name}`, description: s.description })),
      ...fileCommands.map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
    ],
    [skillCommands, fileCommands],
  )

  /** 技能待注入：当用户只输入 `/skillname` 而不带参数时设置（这样我们不会仅仅
   *  因为技能 XML 就立即触发 AI 响应）。技能内容会被前置到 NEXT 条非斜杠命令的
   *  用户消息。在 /clear 或消费后清除。 */
  const pendingSkillRef = useRef<SkillDefinition | null>(null)

  // 显示在输入框下方（ChatInput 的 footer 槽位，与 plan 模式 / accept-edits
  // 指示器并列）的瞬态单行提示。目前只用于 "Press Ctrl+C again to exit" 双击
  // 提示——刻意保持窄，这样未来的用例可以共享同一个渲染槽位。镜像 Claude Code
  // 的 PromptInputFooter 布局。
  const [notice, setNotice] = useState<string | null>(null)
  // 追踪当前 notice 是否是更新提示（相对 Ctrl+C 提示而言）。需要它是因为更新
  // 提示字符串包含 ANSI 转义码，无法通过 startsWith 与纯文本提示区分。
  const isUpdateNoticeRef = useRef(false)
  // 最近一次 Ctrl+C 的时间戳。在 arm 窗口内，下一次 Ctrl+C 就退出；窗口外，
  // Ctrl+C 只是重新 arm（并取消进行中的回合，如果有的话）。镜像 Claude Code 的
  // `useExitOnCtrlCD` 2 秒窗口。
  const ctrlCArmedAtRef = useRef(0)
  const ctrlCArmWindowMs = 2000
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // arm 窗口过期后自动清除 notice。
  // 对更新提示跳过——它们持续到用户发送第一条消息为止（在 handleSubmit 中通过
  // isUpdateNoticeRef 清除）。
  useEffect(() => {
    if (!notice) return
    if (isUpdateNoticeRef.current) return
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ctrlCArmWindowMs)
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  /** Ctrl+C 处理器——双击退出，单击取消进行中的回合（如果有的话）并 arm 退出
   *  提示。镜像 Claude Code 的行为：
   *
   *    Idle   + 第 1 次按下 → 显示 "Press Ctrl+C again to exit"，arm 2 秒窗口
   *    Idle   + 第 2 次按下 → 退出
   *    Loading + 第 1 次按下 → 中止当前回合，显示提示，arm 2 秒窗口
   *    Loading + 第 2 次按下 → 退出
   *
   *  arm 窗口自动过期（notice 通过上面的 effect 清除）。 */
  const handleCtrlC = useCallback(() => {
    const now = Date.now()
    const armed = now - ctrlCArmedAtRef.current < ctrlCArmWindowMs
    if (armed) {
      // 窗口内的第二次按下——用户是认真的。干净地退出（Ink 卸载 → 通过
      // onCleanupReady 触发 gracefulShutdown）。
      exit()
      return
    }
    ctrlCArmedAtRef.current = now
    if (authControllerRef.current) {
      authControllerRef.current.abort()
    } else if (state.isLoading) {
      abort()
    }
    setNotice('Press Ctrl+C again to exit')
  }, [exit, abort, state.isLoading])

  const cancelActiveOperation = useCallback(() => {
    if (authControllerRef.current) authControllerRef.current.abort()
    else abort()
  }, [abort])

  // 注册用于优雅退出（SIGINT）的清理函数
  useEffect(() => {
    onCleanupReady?.({ quiesce, terminateShells: cleanupShells, drain: cleanup })
  }, [cleanup, cleanupShells, quiesce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      authControllerRef.current?.abort()
    },
    [],
  )

  // 注册退出后的 session-info getter。Index.ts 在 resetTerminal 之后用它向 shell
  // 打印 "Resume: xc --resume <id>"。由于 getSessionInfo 直接读 loopStateRef，
  // 它在各次渲染间保持稳定——挂载时注册一次就够了。
  useEffect(() => {
    onSessionInfoReady?.(getSessionInfo)
  }, [getSessionInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  // 把更新提示回调（来自 startup-prints）接入 ChatInput 输入框下方的 footer
  // `notice` 槽位。这避免了 stderr 与 cell-grid 渲染冲突——该冲突曾导致前导字符
  // （"Update" 里的 "U"）被吞掉。
  //
  // 两种情况：
  //   a) cache 命中：提示在挂载前到达 → 现在 drainPendingUpdateHint
  //   b) 网络获取：提示稍后到达 → registerUpdateHintHandler
  useEffect(() => {
    registerUpdateHintHandler((msg) => {
      isUpdateNoticeRef.current = true
      setNotice(msg)
    })
    const drained = drainPendingUpdateHint()
    if (drained) {
      isUpdateNoticeRef.current = true
      setNotice(drained)
    }
    return () => registerUpdateHintHandler(null)
  }, [])

  /** /resume——列出本项目里所有历史会话，让用户挑一个加载。复用 askQuestion
   *  选择器（与 /model 和 askUser 工具同一个对话框），这样我们免费获得一致的
   *  键盘导航、"Other"-作为自由形式的逃生通道、以及 Esc 取消。
   *
   *  选择器标签格式：`[<短提示词>] <相对时间> · N msgs`
   *  每个选项在其 description 里携带绝对文件路径，让用户可以核实自己选的是哪个
   *  会话。用户选择后，我们调用 `loadSession`（这次是完整文件读取，不是 head/tail
   *  增强扫描）并把它传给 `useAgent.resume`，由其热切换 agent 状态。包在 useCallback
   *  里，这样挂载时的 effect 就能引用它而不会触发 react-hooks linter（即便 JS
   *  会提升，定义在组件体靠后位置的函数声明仍会被标记闭包新鲜度问题）。 */
  const handleResume = useCallback(async () => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage(
        '**No past sessions found in this project.** Sessions are saved automatically — start working and one will appear here next time.',
      )
      return
    }
    const byId = new Map(sessions.map((s) => [s.sessionId, s]))
    const choices = dedupeChoiceLabels(
      sessions.slice(0, 30).map((s) => {
        const preview = (s.firstPrompt || '(empty)').slice(0, 60).replace(/\s+/g, ' ').trim()
        const ago = formatRelativeTime(s.mtime)
        const totalTokens = s.tokenUsage ? s.tokenUsage.totalTokens.toLocaleString('en-US') : '—'
        const lineage = forkLineageHint(s, byId)
        return {
          label: `${s.name ? `${s.name}  ·  ` : ''}${preview}  ·  ${ago}`,
          description: `${s.modelId}  ·  ${totalTokens} tokens  ·  ${s.sessionId}${lineage ? `  ·  ${lineage}` : ''}`,
          sessionId: s.sessionId,
          filePath: s.filePath,
        }
      }),
    )
    const answer = await askQuestion(
      `Pick a session to resume (${sessions.length} total in this project):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 用户在 "Other" 里输入了自由格式的值。按取消处理——我们不尝试对 session
      // id 做模糊匹配；选择器才是受支持的挑选方式。
      addInfoMessage('Resume cancelled.')
      return
    }
    const loaded = await loadSession(picked.filePath)
    if (!loaded) {
      addInfoMessage(`Failed to load session at ${picked.filePath}. The file may be corrupted.`)
      return
    }
    const resumed = await resume(loaded)
    if (!resumed.ok) {
      addInfoMessage(
        `Resume was not completed: ${resumed.reason}.${resumed.result ? `\n\n${formatStopResult(resumed.result)}` : ''}`,
      )
      return
    }
    const hint =
      compactionHintForResume(
        loaded.tokenUsage.inputTokens || null,
        estimateTokenCount(loaded.messages),
        loaded.modelId,
      ) ?? ''
    addInfoMessage(
      `**Resumed session:** ${loaded.name ? `${loaded.name} — ` : ''}${loaded.firstPrompt.slice(0, 80) || '(no first prompt)'}\n\nContinuing from ${loaded.messages.length} message${loaded.messages.length === 1 ? '' : 's'}.${hint}`,
    )
  }, [addInfoMessage, askQuestion, resume])

  /** 把 DiffStats 对象格式化成 "+42 -18 in main.ts" 这样的紧凑字符串。 */
  function formatDiffStats(stats: DiffStats | null): string {
    if (!stats || stats.filesChanged.length === 0) return 'no code changes'
    const ins = `+${stats.insertions}`
    const del = `-${stats.deletions}`
    if (stats.filesChanged.length === 1) {
      return `${ins} ${del} in ${path.basename(stats.filesChanged[0]!)}`
    }
    return `${ins} ${del} in ${stats.filesChanged.length} files`
  }

  /** `/rewind` 的选择器 + 执行器。带参数时，直接跳到命名的 checkpoint（完整或
   *  sha1 风格前缀）。不带参数时，按最新优先列出本会话每个 checkpoint，用触发它的
   *  用户提示词作为预览。当没有任何 checkpoint 时（例如在第一条用户消息落定前的
   *  第一个回合），选择器静默 no-op。 */
  const handleRewind = useCallback(
    async (arg: string) => {
      const checkpoints = getCheckpoints()
      if (checkpoints.length === 0) {
        addInfoMessage(
          '**No rewind points yet.** A checkpoint is taken at the start of every user message — type something first, then `/rewind` will offer it.',
        )
        return
      }

      // 直接参数：先精确匹配 ckptId，再前缀匹配。不做模糊匹配——歧义前缀会
      // 静默回滚到错误的点。
      let pickedId: string | null = null
      if (arg) {
        const exact = checkpoints.find((c) => c.ckptId === arg)
        if (exact) pickedId = exact.ckptId
        else {
          const prefixed = checkpoints.filter((c) => c.ckptId.startsWith(arg))
          if (prefixed.length === 1) pickedId = prefixed[0]!.ckptId
          else if (prefixed.length > 1) {
            addInfoMessage(
              `Ambiguous checkpoint prefix \`${arg}\` (${prefixed.length} matches). Run \`/rewind\` and pick.`,
            )
            return
          } else {
            addInfoMessage(`No checkpoint matches \`${arg}\`. Run \`/rewind\` and pick.`)
            return
          }
        }
      }

      if (!pickedId) {
        // 最新优先符合用户在想到 "回退一两步" 时的直觉——最新的决策点在最上面。
        const ordered = [...checkpoints].reverse()

        // 并行计算每个 checkpoint 的 diff 统计。
        const statsArr = await Promise.all(ordered.slice(0, 30).map((c) => getDiffStats(c.ckptId)))

        const choices = ordered.slice(0, 30).map((c, i) => {
          const preview = (c.userPrompt || '(empty prompt)')
            .replace(/[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50)
          const ago = formatRelativeTime(new Date(c.ts).getTime())
          const stats = statsArr[i]
          const diffLabel = formatDiffStats(stats ?? null)
          return {
            label: `${preview}  ·  ${ago}`,
            description: `${diffLabel}  ·  ${c.ckptId}`,
            ckptId: c.ckptId,
            stats,
          }
        })
        const answer = await askQuestion(
          `Pick a checkpoint to rewind to (${ordered.length} total in this session):`,
          choices.map((c) => ({ label: c.label, description: c.description })),
        )
        const picked = choices.find((c) => c.label === answer)
        if (!picked) {
          addInfoMessage('Rewind cancelled.')
          return
        }
        pickedId = picked.ckptId
      }

      // 第 2 步：确认——让用户选择要恢复什么。
      const stats = await getDiffStats(pickedId)
      const hasCodeChanges = stats !== null && stats.filesChanged.length > 0

      const restoreOptions = hasCodeChanges
        ? [
            { label: 'Restore code and conversation', description: `Rewind both (${formatDiffStats(stats)})` },
            { label: 'Restore conversation only', description: 'Keep current files unchanged' },
            { label: 'Restore code only', description: 'Keep full conversation, revert files' },
            { label: 'Cancel', description: '' },
          ]
        : [
            { label: 'Restore conversation', description: 'No code changes to revert' },
            { label: 'Cancel', description: '' },
          ]

      const restoreAnswer = await askQuestion('What would you like to restore?', restoreOptions)
      if (restoreAnswer === 'Cancel') {
        addInfoMessage('Rewind cancelled.')
        return
      }

      const restoreCode = restoreAnswer === 'Restore code and conversation' || restoreAnswer === 'Restore code only'
      const restoreConversation = restoreAnswer !== 'Restore code only'

      const mode = restoreCode && restoreConversation ? 'both' : restoreCode ? 'code' : 'conversation'
      const result = await rewind(pickedId, mode)
      if (!result.ok) {
        addInfoMessage(`**Rewind failed:** ${result.reason}`)
        return
      }

      const diffSummary = hasCodeChanges ? ` (${formatDiffStats(stats)})` : ''
      if (mode === 'both') {
        addInfoMessage(
          `**Rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles and conversation restored${diffSummary}. Continue from here.`,
        )
      } else if (mode === 'code') {
        addInfoMessage(
          `**Code restored** to the state before: ${result.preview || '(empty prompt)'}${diffSummary}\n\nConversation unchanged.`,
        )
      } else {
        addInfoMessage(`**Conversation rewound to:** ${result.preview || '(empty prompt)'}\n\nFiles unchanged.`)
      }
    },
    [addInfoMessage, askQuestion, getCheckpoints, getDiffStats, rewind],
  )

  /** 把 ThemeName 解析回它的显示标签。 */
  function themeLabel(name: ThemeName): string {
    return THEMES.find((t) => t.name === name)?.label ?? name
  }

  /** 应用主题：更新活动的 UI 主题状态，并把语法高亮调色板切换为主题捆绑的那个。
   *  集中在这里，让 /theme、首次运行选择器和启动加载器都保持同步——很容易忘记
   *  两者之一，结果得到与代码颜色不匹配的背景色。 */
  function applyTheme(name: ThemeName) {
    setTheme(name)
    setSyntaxTheme(getThemeColors(name).syntaxPalette)
    setShikiTheme(getThemeColors(name).syntaxPalette)
    rebuildPalette()
  }

  /**
   * 首次运行引导选择器。当 `config.json` 没有 `theme` 键时触发一次——即全新用户
   * 在首次交互式启动时（resume / `--print` / 行内初始提示词会跳过它；见下方的
   * 启动流程 effect）。用户选择（或关闭）后，我们持久化这个选择，让下次启动不再
   * 询问——即便他们没做显式选择就退出，那也算他们的答案（"默认就好"）。
   */
  async function runFirstRunThemePicker() {
    addInfoMessage(
      [
        '**Welcome to X-Code!**',
        '',
        'Choose the theme that looks best with your terminal. You can change it any time with `/theme`.',
      ].join('\n'),
    )

    const cols = Math.max(40, process.stdout.columns ?? 100)
    // 为对话框的左边距（1 个缩进）+ 预览子缩进（2）预留空间。预览辅助函数会自己
    // 填充到该列，所以预算稍微放宽一点没关系。
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))

    const answer = await askQuestion(
      'Pick a theme:',
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
      { noOther: true },
    )

    const picked = choices.find((c) => c.label === answer)
    const resolved = picked?.name ?? DEFAULT_THEME

    applyTheme(resolved)
    saveUserConfig({ theme: resolved })

    if (picked) {
      addInfoMessage(`Theme set to **${themeLabel(resolved)}**. Type a message to get started.`)
    } else {
      addInfoMessage(`Using default theme **${themeLabel(resolved)}**. Run \`/theme\` any time to switch.`)
    }
  }

  // 挂载时的 resume 处理。由 CLI 入口设置的三条互斥路径：
  //   - 设置了 initialSession：`xc -c` 已经同步加载了最近的会话。useAgent 已从它
  //     水合 scrollback；我们只需丢一条横幅，让用户知道他们 resume 了（而不是
  //     以为这些消息神秘地预填充了）。没有异步工作——只是一个视觉提示。
  //   - resumeIntent === 'pick'：`xc -r` 想要选择器。我们弹出与 `/resume` 相同的
  //     对话框。
  //   - 两者皆非：常规启动，可选带 initialPrompt 来自动提交。
  // 选择器 await askQuestion，它只在用户选择后才 resolve，所以我们把它隔离在
  // effect 里并忽略返回的 promise——Ink 不关心 effect 里挂起的异步工作。
  useEffect(() => {
    if (initialSession) {
      const preview = initialSession.firstPrompt.slice(0, 80) || '(no first prompt)'
      const hint =
        compactionHintForResume(
          initialSession.tokenUsage.inputTokens || null,
          estimateTokenCount(initialSession.messages),
          initialSession.modelId,
        ) ?? ''
      addInfoMessage(
        `**Resumed session** — ${initialSession.name ? `${initialSession.name} — ` : ''}${preview}\n\nRestored ${initialSession.messages.length} message${initialSession.messages.length === 1 ? '' : 's'}. Continuing the same conversation.${hint}`,
      )
      return
    }
    if (resumeIntent === 'pick') {
      void handleResume()
      return
    }
    // 首次运行主题选择器——只在普通交互式启动时（无 resume、无自动提交的初始
    // 提示词）。通过磁盘配置里缺少 `theme` 来检测。用户选择（或关闭）后，我们
    // 持久化一个值，让这个分支不再触发。Resume / 行内提示词启动刻意跳过——那些
    // 用户是来干活的，不是来配置的。
    if (!initialPrompt && loadUserConfig().theme === undefined) {
      void runFirstRunThemePicker()
      return
    }
    if (initialPrompt) {
      void submit(initialPrompt)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Print 模式不再经过 Ink——见 packages/cli/src/print.ts。之前的 effect 曾试图
  // 在这里 `cleanup().then(exit)`，但 usePromptInput 的 raw-stdin ref 让事件循环
  // 在卸载后仍存活，于是 exit 会挂起直到有按键或终端 resize。

  /** 处理用户输入（包括斜杠命令） */
  async function handleSubmit(text: string) {
    // 在第一次用户操作时清除任何更新提示——用户已经看到了，没必要让它继续占着
    // footer。
    if (isUpdateNoticeRef.current) {
      isUpdateNoticeRef.current = false
      setNotice(null)
    }

    if (authControllerRef.current) {
      addInfoMessage('Wait for the ChatGPT authentication operation to finish, or press Esc to cancel it.')
      return
    }
    if (!text.startsWith('/') && unavailableModelRef.current?.modelId === state.modelId) {
      const unavailable = unavailableModelRef.current
      const observed = await refreshOpenAIAuthSnapshot()
      if (unavailable.authRevision === observed.revision) {
        addInfoMessage(unavailable.message)
        return
      }
    }

    // 中途队列：当回合进行中时，纯文本不会启动一个竞争的 agentLoop（并发循环会
    // 破坏共享的消息历史）——它落入待处理队列，并在下一个工具边界被注入（见
    // use-agent 里的 consumeQueuedInputs）。斜杠命令仍在下方正常路由；ChatInput 和
    // 这个处理器共享同一个显式的 busy-safe 命令策略。
    const activeOwner = activeTurnOwner()
    if (activeOwner && !text.startsWith('/')) {
      const pendingSkill = pendingSkillRef.current
      if (pendingSkill) {
        pendingSkillRef.current = null
        // 显示/注入分离：待处理列表 + scrollback 显示用户自己的文本；模型收到
        // 技能信封（与空闲路径的 silent submit 相同）。
        queueMessage(text, `${wrapActivatedSkill(pendingSkill)}\n\n${text}`)
      } else {
        queueMessage(text)
      }
      return
    }

    if (activeOwner && text.startsWith('/')) {
      if (!isSlashCommandAllowedWhileBusy(text, activeOwner, hasActiveForkBoundary())) {
        addInfoMessage(`Cannot run ${text.split(/\s+/, 1)[0]} while ${activeOwner} owns the active turn.`)
        return
      }
    }

    if (text.startsWith('/')) {
      await routeSlashCommand(text, {
        agent: {
          addCommandMessage,
          addCommandResult,
          addInfoMessage,
          clear,
          clearPeerContext,
          echoCommand,
          fork,
          listShellSessions,
          stopShellSessions,
          submit,
        },
        options,
        skillCommands,
        fileCommands,
        pendingSkillRef,
        handlers: {
          login: handleLogin,
          logout: handleLogout,
          model: handleModelSwitch,
          context: handleContext,
          thinking: handleThinkingToggle,
          theme: handleThemeSwitch,
          plan: handlePlanToggle,
          compact: handleCompact,
          goal: handleGoal,
          resume: handleResume,
          rewind: handleRewind,
          usage: handleUsage,
          usageHistory: handleUsageHistory,
          memory: handleMemory,
          skill: handleSkill,
          mcp: handleMcp,
          plugin: handlePlugin,
          browser: handleBrowser,
          doctor: handleDoctor,
        },
        exit,
      })
      return
    }

    // 把任何待注入的技能上下文前置到用户消息，然后清除它。
    const pendingSkill = pendingSkillRef.current
    if (pendingSkill) {
      pendingSkillRef.current = null
      await submit(`${wrapActivatedSkill(pendingSkill)}\n\n${text}`, { silent: true })
      return
    }
    await submit(text)
  }

  /** 为 model id 查找人类友好的标签；回退到原始 id。 */
  function renderModelLabel(modelId: string): string {
    for (const models of Object.values(getProviderModels())) {
      for (const m of models) if (m.id === modelId) return m.label
    }
    return modelId
  }

  /** 从 UserConfig.modelReasoningEffort 解析模型的 reasoning-effort 层级标签
   *  （如 "High"、"Max"），当模型没有配置层级或不支持层级时返回 null。镜像 agent
   *  循环的 effort 解析（getReasoningLevel），这样 footer 永远不会显示一个循环会
   *  忽略的层级。 */
  function resolveReasoningTierLabel(modelId: string): string | null {
    if (!supportsReasoningTier(modelId)) return null
    const effort = loadUserConfig().modelReasoningEffort?.[modelId]
    if (!effort) return null
    return getReasoningTierOptions(modelId)?.find((option) => option.value === effort)?.label ?? effort
  }

  /**
   * 提交一次模型切换：重建 provider registry（这样新 provider 的环境变量 API key
   * 才被拾取）、交换实时的 language-model 引用、持久化到用户配置，并回显一条确认
   * 消息。
   */
  function commitModelChange(commandText: string, newModelId: string) {
    if (getOpenAIAuthStatus().mode === 'chatgpt' && newModelId.startsWith('openai:')) {
      const catalog = getOpenAIChatGPTModelCatalogState()
      if (catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid') {
        addCommandMessage(commandText, 'ChatGPT authentication needs attention. Run /login again.')
        return
      }
      if (!(getProviderModels().openai ?? []).some((model) => model.id === newModelId)) {
        addCommandMessage(commandText, `${newModelId} is not available for the signed-in ChatGPT account.`)
        return
      }
    }
    try {
      activateModel(newModelId)
      if (getOpenAIAuthStatus().mode === 'chatgpt' && newModelId.startsWith('openai:')) {
        const snapshot = getOpenAIAuthSnapshot()
        checkedOpenAIEntitlementKeyRef.current = openAIModelEntitlementKey(
          snapshot,
          getOpenAIChatGPTModelCatalogState(),
        )
      }
      addCommandMessage(commandText, `Set model to ${renderModelLabel(newModelId)}`)
    } catch (err) {
      addCommandMessage(commandText, `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function activateModel(newModelId: string) {
    replaceActiveModelProvider(newModelId, options, switchModel)
    options.modelId = newModelId
    unavailableModelRef.current = null
    setReasoningTierLabel(resolveReasoningTierLabel(newModelId))
    saveUserConfig({ model: newModelId })
  }

  function formatChatGPTCatalogStatus(): string {
    const catalog = getOpenAIChatGPTModelCatalogState()
    if (!catalog) return 'The ChatGPT model catalog is not active.'
    const count = `${catalog.models.length} GPT model${catalog.models.length === 1 ? '' : 's'}`
    if (catalog.errorCode === 'login-required' || catalog.errorCode === 'credentials-invalid') {
      const source = catalog.source === 'cache' ? 'the last verified cache' : 'the bundled fallback'
      return `${count} loaded from ${source}; ChatGPT authentication needs attention. Run /login again.`
    }
    if (catalog.source === 'remote') return `${count} verified for this ChatGPT account.`
    if (catalog.source === 'cache') {
      return catalog.error
        ? `${count} loaded from the last verified cache; the latest refresh failed. Run /model refresh to retry.`
        : `${count} loaded from the verified cache.`
    }
    return catalog.error
      ? `${count} shown from the bundled fallback; the latest refresh failed. Run /model refresh to retry.`
      : `${count} shown from the bundled fallback and not yet verified. Run /model refresh to verify this account.`
  }

  function reconcileCurrentOpenAIModel(models: readonly { id: string }[]): string {
    if (!state.modelId.startsWith('openai:')) return ''
    const plan = planOpenAIModelReconciliation(
      state.modelId,
      models,
      getAvailableProviders(),
      'The signed-in ChatGPT account has no available models. Use /logout or configure another provider.',
      renderModelLabel,
    )
    if (plan.modelId) {
      activateModel(plan.modelId)
      const snapshot = getOpenAIAuthSnapshot()
      checkedOpenAIEntitlementKeyRef.current = openAIModelEntitlementKey(snapshot, getOpenAIChatGPTModelCatalogState())
      return plan.note
    }
    const snapshot = getOpenAIAuthSnapshot()
    unavailableModelRef.current = {
      authRevision: snapshot.revision,
      message: plan.blockedMessage!,
      modelId: state.modelId,
    }
    checkedOpenAIEntitlementKeyRef.current = openAIModelEntitlementKey(snapshot, getOpenAIChatGPTModelCatalogState())
    return plan.note
  }

  async function prepareInitialOpenAIEntitlementCheck(
    currentModelId: string,
    observed: ReturnType<typeof getOpenAIAuthSnapshot>,
  ): Promise<ModelRequestPreflightResult> {
    let catalog = getOpenAIChatGPTModelCatalogState()
    let models = catalog?.models ?? []
    if (!catalog || (catalog.source === 'fallback' && !catalog.error)) {
      models = await refreshOpenAIChatGPTModels(VERSION)
      catalog = getOpenAIChatGPTModelCatalogState()
    }
    const latest = await refreshOpenAIAuthSnapshot()
    if (latest.revision !== observed.revision) return handleExternalAuthChange(currentModelId)
    const candidates =
      catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid' ? [] : models
    const plan = planOpenAIModelReconciliation(
      currentModelId,
      candidates,
      getAvailableProviders(),
      'The active ChatGPT credentials cannot provide a usable model. Run /login again or configure another provider.',
      renderModelLabel,
    )
    const registry = createModelRegistry()
    const nextModel = plan.modelId ? registry.languageModel(plan.modelId as `${string}:${string}`) : undefined
    const notice =
      plan.modelId !== currentModelId || plan.blockedMessage
        ? `The saved OpenAI model was checked against the active ChatGPT account. ${formatChatGPTCatalogStatus()}${plan.note}`
        : undefined
    return {
      ...(nextModel && plan.modelId ? { model: nextModel, modelId: plan.modelId } : {}),
      ...(plan.blockedMessage ? { blockedMessage: plan.blockedMessage } : {}),
      ...(notice ? { notice } : {}),
      onApplied: () => {
        options.modelRegistry = registry
        resetVisionModelProviders()
        if (nextModel && plan.modelId) {
          switchModel(plan.modelId, nextModel)
          options.modelId = plan.modelId
          unavailableModelRef.current = null
          setReasoningTierLabel(resolveReasoningTierLabel(plan.modelId))
          if (plan.modelId !== currentModelId) saveUserConfig({ model: plan.modelId })
        } else if (plan.blockedMessage) {
          unavailableModelRef.current = {
            authRevision: observed.revision,
            message: plan.blockedMessage,
            modelId: currentModelId,
          }
        }
        checkedOpenAIEntitlementKeyRef.current = openAIModelEntitlementKey(
          observed,
          getOpenAIChatGPTModelCatalogState(),
        )
      },
    }
  }

  async function handleExternalAuthChange(
    currentModelId: string,
    retryCount = 0,
  ): Promise<ModelRequestPreflightResult> {
    const observed = await refreshOpenAIAuthSnapshot()
    const transition = openAIAuthTransitionRef.current
    const applied = transition.applied
    if (!needsOpenAIAuthTransition(transition, observed)) {
      const unavailable = unavailableModelRef.current
      if (unavailable?.modelId === currentModelId && unavailable.authRevision === observed.revision) {
        return { blockedMessage: unavailable.message }
      }
      if (
        needsOpenAIModelEntitlementCheck(
          checkedOpenAIEntitlementKeyRef.current,
          observed,
          currentModelId,
          getOpenAIChatGPTModelCatalogState(),
        )
      ) {
        return prepareInitialOpenAIEntitlementCheck(currentModelId, observed)
      }
      return undefined
    }

    let notice = 'OpenAI authentication changed in another process.'
    if (observed.context.mode === 'chatgpt') {
      notice =
        applied.context.mode === 'chatgpt'
          ? 'The ChatGPT account changed in another process.'
          : 'OpenAI now uses ChatGPT authentication from another process.'
    } else if (observed.context.mode === 'api-key') {
      notice = 'ChatGPT was signed out in another process; OPENAI_API_KEY is now active.'
    } else {
      notice = 'OpenAI authentication was removed in another process.'
    }

    let plan: { blockedMessage?: string; modelId?: string; note: string } = { note: '' }
    if (currentModelId.startsWith('openai:')) {
      if (observed.context.mode === 'chatgpt') {
        const models = await refreshOpenAIChatGPTModels(VERSION, { signal: AbortSignal.timeout(8_000) })
        const latest = await refreshOpenAIAuthSnapshot()
        if (latest.revision !== observed.revision) {
          if (retryCount >= 2) {
            return {
              blockedMessage:
                'OpenAI authentication is changing in another process. Wait for it to settle, then retry.',
            }
          }
          return handleExternalAuthChange(currentModelId, retryCount + 1)
        }
        const catalog = getOpenAIChatGPTModelCatalogState()
        const candidates =
          catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid' ? [] : models
        plan = planOpenAIModelReconciliation(
          currentModelId,
          candidates,
          getAvailableProviders(),
          'The active ChatGPT credentials cannot provide a usable model. Run /login again or configure another provider.',
          renderModelLabel,
        )
        notice += ` ${formatChatGPTCatalogStatus()}`
      } else if (observed.context.mode === 'none') {
        plan = planOpenAIModelReconciliation(
          currentModelId,
          [],
          getAvailableProviders(),
          'No authenticated model is available. Run /login or configure another provider.',
          renderModelLabel,
        )
      } else {
        plan = { modelId: currentModelId, note: '' }
      }
      notice += plan.note
    }

    const registry = createModelRegistry()
    const nextModel = plan.modelId ? registry.languageModel(plan.modelId as `${string}:${string}`) : undefined
    return {
      ...(nextModel && plan.modelId ? { model: nextModel, modelId: plan.modelId } : {}),
      ...(plan.blockedMessage ? { blockedMessage: plan.blockedMessage } : {}),
      notice,
      onApplied: () => {
        options.modelRegistry = registry
        resetVisionModelProviders()
        if (nextModel && plan.modelId) {
          switchModel(plan.modelId, nextModel)
          options.modelId = plan.modelId
          unavailableModelRef.current = null
          setReasoningTierLabel(resolveReasoningTierLabel(plan.modelId))
          if (plan.modelId !== currentModelId) saveUserConfig({ model: plan.modelId })
        } else if (plan.blockedMessage) {
          unavailableModelRef.current = {
            authRevision: observed.revision,
            message: plan.blockedMessage,
            modelId: currentModelId,
          }
        }
        checkedOpenAIEntitlementKeyRef.current =
          observed.context.mode === 'chatgpt' && currentModelId.startsWith('openai:')
            ? openAIModelEntitlementKey(observed, getOpenAIChatGPTModelCatalogState())
            : null
        commitOpenAIAuthTransition(transition, observed)
      },
    }
  }

  async function handleLogin(commandText: string, arg: string) {
    const option = arg.trim().toLowerCase()
    if (option === 'status') {
      await refreshOpenAIAuthSnapshot()
      addCommandMessage(commandText, formatOpenAIAuthStatus())
      return
    }
    if (option && option !== '--device-auth') {
      addCommandMessage(commandText, 'Usage: /login [--device-auth|status]')
      return
    }
    if (authControllerRef.current) {
      addCommandMessage(commandText, 'A ChatGPT authentication operation is already in progress.')
      return
    }
    if (modelRefreshInProgressRef.current) {
      addCommandMessage(commandText, 'Wait for the ChatGPT model refresh to finish before signing in.')
      return
    }

    echoCommand(commandText)
    const controller = new AbortController()
    authControllerRef.current = controller
    setAuthOperation('login')
    try {
      const deviceAuth = option === '--device-auth'
      addCommandResult(deviceAuth ? 'Starting ChatGPT device sign-in…' : 'Opening ChatGPT sign-in in your browser…')
      let result: Awaited<ReturnType<typeof loginChatGPT>>
      try {
        result = await loginChatGPT({
          deviceAuth,
          signal: controller.signal,
          onAuthorizationUrl: (url) => addCommandResult(`Complete ChatGPT sign-in in your browser:\n${url}`),
          onUserCode: (url, code) => addCommandResult(`Open ${url}\nEnter code: ${code}`),
        })
      } catch (error) {
        addCommandResult(
          controller.signal.aborted ? 'ChatGPT login cancelled.' : `ChatGPT login failed: ${errorMessage(error)}`,
        )
        return
      }

      let modelNote = 'The model catalog has not been refreshed yet. Run /model refresh to retry.'
      try {
        if (state.modelId.startsWith('openai:')) activateModel(state.modelId)
        else options.modelRegistry = createModelRegistry()
        resetVisionModelProviders()
        commitOpenAIAuthTransition(openAIAuthTransitionRef.current, getOpenAIAuthSnapshot())

        const catalogResult = await refreshCatalogAfterCommittedLogin((signal) =>
          refreshOpenAIChatGPTModels(VERSION, { signal, force: true }),
        )
        if ('error' in catalogResult) {
          modelNote = `The model catalog could not be refreshed: ${errorMessage(catalogResult.error)} Run /model refresh to retry.`
          if (state.modelId.startsWith('openai:')) {
            const snapshot = getOpenAIAuthSnapshot()
            checkedOpenAIEntitlementKeyRef.current = openAIModelEntitlementKey(
              snapshot,
              getOpenAIChatGPTModelCatalogState(),
            )
          }
        } else {
          options.modelRegistry = createModelRegistry()
          const catalog = getOpenAIChatGPTModelCatalogState()
          const candidates =
            catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid'
              ? []
              : catalogResult.models
          modelNote = `${formatChatGPTCatalogStatus()}${reconcileCurrentOpenAIModel(candidates)}`
        }
      } catch (error) {
        modelNote = `The active model could not be updated: ${errorMessage(error)} Run /model to choose another model.`
      }

      addCommandResult(
        `ChatGPT login successful. ${modelNote}${
          result.apiKeyConfigured ? '\nOPENAI_API_KEY is inactive until /logout.' : ''
        }`,
      )
    } finally {
      if (authControllerRef.current === controller) authControllerRef.current = null
      setAuthOperation(null)
    }
  }

  async function handleLogout(commandText: string, arg: string) {
    if (arg.trim()) {
      addCommandMessage(commandText, 'Usage: /logout')
      return
    }
    if (authControllerRef.current) {
      addCommandMessage(commandText, 'A ChatGPT authentication operation is already in progress.')
      return
    }
    if (modelRefreshInProgressRef.current) {
      addCommandMessage(commandText, 'Wait for the ChatGPT model refresh to finish before signing out.')
      return
    }

    echoCommand(commandText)
    const controller = new AbortController()
    authControllerRef.current = controller
    setAuthOperation('logout')
    try {
      addCommandResult('Signing out of ChatGPT…')
      let result: Awaited<ReturnType<typeof logoutChatGPT>>
      try {
        result = await logoutChatGPT(controller.signal)
      } catch (error) {
        addCommandResult(
          controller.signal.aborted ? 'ChatGPT logout cancelled.' : `ChatGPT logout failed: ${errorMessage(error)}`,
        )
        return
      }

      const snapshot = getOpenAIAuthSnapshot()
      let modelNote = ''
      try {
        options.modelRegistry = createModelRegistry()
        resetVisionModelProviders()
        if (state.modelId.startsWith('openai:')) {
          const availableProviders = new Set(getAvailableProviders())
          if (availableProviders.has('openai')) {
            activateModel(state.modelId)
            modelNote = ' OPENAI_API_KEY is now active for the current model.'
          } else {
            const plan = planOpenAIModelReconciliation(
              state.modelId,
              [],
              getAvailableProviders(),
              'No authenticated model is available. Run /login or configure another provider.',
              renderModelLabel,
            )
            if (plan.modelId) activateModel(plan.modelId)
            else if (plan.blockedMessage) {
              unavailableModelRef.current = {
                authRevision: snapshot.revision,
                message: plan.blockedMessage,
                modelId: state.modelId,
              }
            }
            modelNote = plan.note
          }
        }
        commitOpenAIAuthTransition(openAIAuthTransitionRef.current, snapshot)
        checkedOpenAIEntitlementKeyRef.current = null
      } catch (error) {
        modelNote = ` Authentication was removed, but the active model could not be updated: ${errorMessage(error)}`
      }

      if (!result.removed) {
        addCommandResult(`ChatGPT is already signed out.${modelNote}`)
      } else {
        addCommandResult(
          `ChatGPT logout complete.${
            result.revokeFailed ? ' The remote revoke request failed, but local credentials were removed.' : ''
          }${modelNote}`,
        )
      }
    } finally {
      if (authControllerRef.current === controller) authControllerRef.current = null
      setAuthOperation(null)
    }
  }

  async function handleModelSwitch(commandText: string, arg: string) {
    if (arg.trim().toLowerCase() === 'refresh') {
      if (getOpenAIAuthStatus().mode !== 'chatgpt') {
        addCommandMessage(commandText, 'ChatGPT model refresh requires /login first.')
        return
      }
      if (modelRefreshInProgressRef.current) {
        addCommandMessage(commandText, 'A ChatGPT model refresh is already in progress.')
        return
      }
      echoCommand(commandText)
      addCommandResult('Refreshing the ChatGPT model catalog…')
      modelRefreshInProgressRef.current = true
      try {
        const models = await refreshOpenAIChatGPTModels(VERSION, {
          signal: AbortSignal.timeout(8_000),
          force: true,
        })
        options.modelRegistry = createModelRegistry()
        const catalog = getOpenAIChatGPTModelCatalogState()
        const candidates =
          catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid' ? [] : models
        addCommandResult(`${formatChatGPTCatalogStatus()}${reconcileCurrentOpenAIModel(candidates)}`)
      } catch (error) {
        addCommandResult(`ChatGPT model refresh failed: ${errorMessage(error)}`)
      } finally {
        modelRefreshInProgressRef.current = false
      }
      return
    }

    const requestedModel = arg ? resolveModelId(arg) : undefined
    // 带显式参数：保留旧的脚本化路径（别名或完整 id）。
    if (arg) {
      const newModelId = requestedModel
      if (!newModelId) {
        addCommandMessage(commandText, `Could not resolve model: ${arg}`)
        return
      }
      commitModelChange(commandText, newModelId)
      return
    }

    // 无参数 → 交互式选择器。枚举 provider 有活动认证方法的模型，这样列表是
    // 可操作的，而不是空想。
    const availableProviders = new Set(getAvailableProviders())
    const chatGPTCatalog = getOpenAIChatGPTModelCatalogState()
    const openAIUnavailable =
      chatGPTCatalog?.errorCode === 'login-required' || chatGPTCatalog?.errorCode === 'credentials-invalid'
    const choices: { id: string; label: string; description: string }[] = []
    for (const [provider, models] of Object.entries(getProviderModels())) {
      if (!availableProviders.has(provider)) continue
      if (provider === 'openai' && openAIUnavailable) continue
      for (const m of models) {
        const marker = m.id === state.modelId ? `${GLYPH_BULLET} ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    if (choices.length === 0) {
      addCommandMessage(commandText, 'No models available — run `/login` for ChatGPT or configure a provider API key.')
      return
    }

    // askQuestion 解析为所选选项的 LABEL（不是 id）。SelectOptions 对话框是为
    // 人类可读的选择设计的，所以我们通过我们推入的 label 反查 id。
    const catalogHint =
      getOpenAIAuthStatus().mode === 'chatgpt' ? `\nChatGPT catalog: ${formatChatGPTCatalogStatus()}` : ''
    const answer = await askQuestion(
      `Current: ${state.modelId}${catalogHint}\nPick a model (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 空答案 = Esc 关闭的对话框。安静取消——不要把它跑一遍 resolveModelId
      // （那会带着空 id 打印 "Could not resolve model: "）。
      if (!answer) {
        addCommandMessage(commandText, `Cancelled — model stays **${renderModelLabel(state.modelId)}**.`)
        return
      }
      // 用户选择了 "Other" 或输入了自由格式的内容。把它当作直接的 model id /
      // 别名，这样高级用户仍能跳到选择器没列出的冷门模型。对自由格式条目跳过
      // 层级 / base-url 对话框——它们是边缘的一次性场景。
      const resolved = resolveModelId(answer)
      if (!resolved) {
        addCommandMessage(commandText, `Could not resolve model: ${answer}`)
        return
      }
      commitModelChange(commandText, resolved)
      return
    }
    const modelId = picked.id

    // ── Base URL 选择器（多端点 provider）──
    const modelProvider = providerOf(modelId)
    const baseUrlConfig = PROVIDER_BASE_URLS[modelProvider]
    if (baseUrlConfig) {
      const baseAnswer = await askQuestion(
        `Pick the API endpoint for ${modelProvider}:`,
        baseUrlConfig.options.map((o) => ({ label: o.label, description: o.url })),
        { noOther: true },
      )
      const chosen = baseUrlConfig.options.find((o) => o.label === baseAnswer)
      if (chosen) {
        const prev = loadUserConfig().baseUrls ?? {}
        saveUserConfig({ baseUrls: { ...prev, [modelProvider]: chosen.url } })
      }
      // Esc 取消仍有效——配置保持原样（可能是空，也可能带着之前选择器会话里的
      // 选择）。
    }

    // ── Reasoning 层级选择器 ──
    // 只对真正支持层级的模型显示（例如 thinkingLevel 仅 Gemini 3 有，Kimi 的
    // reasoningEffort 仅 K3 有）；其他模型保留二元的 /thinking 开关作为唯一旋钮。
    const tierOptions = getReasoningTierOptions(modelId)
    if (tierOptions?.length) {
      const tierAnswer = await askQuestion(
        `Reasoning effort for ${renderModelLabel(modelId)}:`,
        tierOptions.map((option) => ({ label: option.label, description: option.description })),
        { noOther: true },
      )
      const chosen = tierOptions.find((option) => option.label === tierAnswer)
      if (chosen) {
        const prev = loadUserConfig().modelReasoningEffort ?? {}
        saveUserConfig({ modelReasoningEffort: { ...prev, [modelId]: chosen.value } })
      }
      // Esc 取消 = 不保存层级；/thinking 开关回退适用。
    }

    commitModelChange(commandText, modelId)
  }

  /** 提交一次 thinking 模式变更：更新实时 ref 让下一个 agent 回合使用它、持久化
   *  到磁盘，并回显一个 Claude 风格的两行命令块。 */
  function commitThinkingChange(commandText: string, next: boolean) {
    setThinking(next)
    saveUserConfig({ thinking: next })
    addCommandMessage(commandText, `Extended thinking → **${next ? 'on' : 'off'}**. Takes effect on the next message.`)
  }

  /**
   * `/thinking`——翻转扩展思考开关。
   *
   * 无参数 → 交互式选择器。与 `/model` 无参数时的 UX 相同：显示当前状态（活动
   *   选项上标 `●`），让用户用方向键 + Enter 选另一个。取消 / 选择已是活动状态的
   *   选项都导致无变化。
   * `on` / `off`（以及 `true`/`false`/`enable`/`disable` 等别名）
   *   → 直接切换，便于脚本化和肌肉记忆。
   * 任何其他参数 → 带提示拒绝，不静默吞掉。
   *
   * 该开关在各 provider 间是统一的（见 providers/thinking.ts）：
   *   ON  应用每个 provider 支持的最大 reasoning；
   *   OFF 请求最小值 / 在暴露处禁用（Gemini 2.5 Pro 无法完全禁用——它会被
   *       钳制到 128 token 的最小值）。
   *
   * 持久化到 ~/.x-code/config.json，让选择在重启后仍保留。agent 循环每个回合都
   * 通过 useAgent 里的 thinkingRef 读取它，所以切换后的下一条消息就已经使用新
   * 模式（不需要像 /model 那样重建模型）。
   */
  async function handleThinkingToggle(commandText: string, arg: string) {
    const current = getThinking()
    const trimmed = arg.trim().toLowerCase()

    // 直接切换的快捷路径。
    if (trimmed) {
      const next = parseBooleanArg(trimmed)
      if (next === null) {
        addCommandMessage(
          commandText,
          `Unknown value: \`${arg}\`. Use \`/thinking\`, \`/thinking on\`, or \`/thinking off\`.`,
        )
        return
      }

      if (next === current) {
        addCommandMessage(commandText, `Extended thinking is already **${next ? 'on' : 'off'}** — no change.`)
        return
      }

      commitThinkingChange(commandText, next)
      return
    }

    // 无参数 → 交互式选择器。我们总是显示两个选项，让用户看到完整的状态空间，
    // 用 `● ` 标记当前选择（镜像 `/model` 的渲染）。
    const onMarker = current ? `${GLYPH_BULLET} ` : '  '
    const offMarker = current ? '  ' : `${GLYPH_BULLET} `
    const choices = [
      {
        label: `${onMarker}On`,
        description: 'Opt every supported provider into max reasoning. Slower, costs more, better on hard problems.',
      },
      {
        label: `${offMarker}Off`,
        description: 'Each provider runs its non-thinking default. Faster, cheaper, sufficient for most chat.',
      },
    ]
    const answer = await askQuestion(
      `Extended thinking is currently **${current ? 'on' : 'off'}**. Pick a mode (${GLYPH_BULLET} = current):`,
      choices,
      { noOther: true },
    )
    const wantOn = answer === choices[0].label
    const wantOff = answer === choices[1].label
    if (!wantOn && !wantOff) {
      // 用户在选择器里输入了自由格式的内容。尊重标准别名；否则 no-op（用户
      // 大概是想退出）。
      const free = (answer ?? '').trim().toLowerCase()
      if (free === 'on' || free === 'true' || free === '1' || free === 'enable' || free === 'enabled') {
        if (current) {
          addCommandMessage(commandText, 'Extended thinking is already **on** — no change.')
          return
        }
        commitThinkingChange(commandText, true)
        return
      }
      if (free === 'off' || free === 'false' || free === '0' || free === 'disable' || free === 'disabled') {
        if (!current) {
          addCommandMessage(commandText, 'Extended thinking is already **off** — no change.')
          return
        }
        commitThinkingChange(commandText, false)
        return
      }
      addCommandMessage(commandText, `Cancelled — extended thinking stays **${current ? 'on' : 'off'}**.`)
      return
    }
    const next = wantOn
    if (next === current) {
      addCommandMessage(commandText, `Already **${next ? 'on' : 'off'}** — no change.`)
      return
    }
    commitThinkingChange(commandText, next)
  }

  // themeLabel + applyTheme + runFirstRunThemePicker 位于 launch useEffect（大约
  // 350 行的那个）上方，因为那个 effect 正是触发首次运行选择器的地方。
  // `react-compiler` 会标记 `[]` deps 的 effect 里"先引用后声明"的问题，所以我们
  // 把这些辅助函数提升到那里。/theme 处理器（commitThemeChange、handleThemeSwitch）
  // 则留在其他斜杠命令处理器附近，因为它们从常规 handleSubmit 路径调用，而那条
  // 路径的提升要求更宽松。

  /** 应用一次主题切换：翻转活动的 UI 主题及其捆绑的语法调色板，让紧接着的下一次
   *  diff 渲染使用新颜色，持久化到用户配置，回显确认。agent 循环 / scrollback
   *  写入器不缓存颜色，所以变更在下一次工具结果上立即可见——无需重启。 */
  function commitThemeChange(commandText: string, name: ThemeName) {
    applyTheme(name)
    saveUserConfig({ theme: name })
    addCommandMessage(commandText, `Set theme to **${themeLabel(name)}**.`)
  }

  /**
   * `/theme`——挑选 UI 主题。驱动 diff 背景色以及关联的语法高亮调色板。
   *
   * 无参数 → 交互式选择器，展示全部六个主题，当前选择标 `●`，并带一个实时预览，
   *   用户用方向键浏览时预览会重新着色。与 `/model` 和 `/thinking` 相同的 UX。
   * `<theme-name>` → 直接切换。接受规范的 kebab-case 名称（`dark`、`light`、
   *   `dark-daltonized`、`light-daltonized`、`dark-ansi`、`light-ansi`）以及别名
   *   （`colorblind`、`ansi` 等）——见 `parseThemeName`。
   *
   * 持久化到 ~/.x-code/config.json，让选择在重启后仍保留。
   */
  async function handleThemeSwitch(commandText: string, arg: string) {
    const current = getTheme()

    if (arg.trim()) {
      const next = parseThemeName(arg)
      if (next === null) {
        const names = THEMES.map((t) => t.name).join(', ')
        addCommandMessage(commandText, `Unknown theme: \`${arg}\`. Available: ${names}.`)
        return
      }
      if (next === current) {
        addCommandMessage(commandText, `Theme is already **${themeLabel(next)}** — no change.`)
        return
      }
      commitThemeChange(commandText, next)
      return
    }

    // 无参数 → 交互式选择器。展示每个主题；用 `●` 标记当前那个。使用与模型选择器
    // 相同的对话框组件，外加一个实时预览窗格，随用户方向键浏览而重新着色。
    const cols = Math.max(40, process.stdout.columns ?? 100)
    const previewWidth = Math.max(40, cols - 4)
    const choices = THEMES.map((t) => ({
      name: t.name,
      label: `${t.name === current ? `${GLYPH_BULLET} ` : '  '}${t.label}`,
      description: t.description,
      preview: buildThemePreview(t.name, previewWidth),
    }))
    const answer = await askQuestion(
      `Current: **${themeLabel(current)}**. Choose the text style that looks best with your terminal (${GLYPH_BULLET} = current):`,
      choices.map((c) => ({ label: c.label, description: c.description, preview: c.preview })),
      { noOther: true },
    )
    const picked = choices.find((c) => c.label === answer)
    if (!picked) {
      // 空答案 = Esc 关闭的对话框（noOther 移除了自由格式路径，所以非选择答案
      // 只可能是 Esc）。
      addCommandMessage(commandText, `Cancelled — theme stays **${themeLabel(current)}**.`)
      return
    }
    if (picked.name === current) {
      addCommandMessage(commandText, `Theme is already **${themeLabel(current)}** — no change.`)
      return
    }
    commitThemeChange(commandText, picked.name)
  }

  /** 通过 /plan 切换 plan 模式。直接进入/退出，没有选择器——`/plan` 是用户明确
   *  要求 plan 模式，所以我们直接执行。`/plan` 在 plan ↔ 之前的状态之间切换；
   *  `/plan on` / `/plan off` 是脚本化流程的幂等设置器。匹配 Claude Code 的 `/plan`
   *  单行确认输出。 */
  function handlePlanToggle(commandText: string, arg: string) {
    const current = state.permissionMode === 'plan'
    const trimmed = arg.trim().toLowerCase()

    let next: boolean
    if (!trimmed) {
      next = !current
    } else {
      const parsed = parseBooleanArg(trimmed)
      if (parsed === null) {
        addCommandMessage(commandText, `Unknown value: \`${arg}\`. Use \`/plan\`, \`/plan on\`, or \`/plan off\`.`)
        return
      }
      next = parsed
    }

    if (next === current) {
      addCommandMessage(commandText, `Plan mode is already **${current ? 'on' : 'off'}** — no change.`)
      return
    }

    // /plan 直接在 plan 和 default 之间跳转。我们自己把模式应用到 loopState 上，
    // 并让已有的 onPlanModeChange 回调路径通过 setPermissionMode 完成 React state /
    // UI 同步。
    setPermissionMode(next ? 'plan' : 'default')
    addCommandMessage(commandText, next ? 'Enabled plan mode' : 'Disabled plan mode')
  }

  async function handleGoal(arg: string) {
    try {
      const [subcommand = '', ...rest] = tokenizeArgs(arg)
      const goal = state.goalStatus
      const lower = subcommand.toLowerCase()

      if (!arg.trim() || lower === 'status') {
        addCommandResult(goal ? formatGoalStatus(goal, state.usage) : 'No current goal.')
        return
      }

      if (lower === 'pause') {
        const paused = await pauseGoal()
        addCommandResult(paused ? `Goal paused: ${paused.objective}` : 'No active goal to pause.')
        return
      }

      if (lower === 'resume') {
        const maxTurnsArg = rest[0] === '--max-turns' ? rest[1] : undefined
        if (maxTurnsArg && goal && canResumeGoalStatus(goal)) {
          if (maxTurnsArg.startsWith('+') && goal.maxTurns === undefined) {
            addCommandResult('Cannot add relative turns to an unlimited goal. Use an absolute --max-turns value.')
            return
          }
          const maxTurns = maxTurnsArg.startsWith('+')
            ? goal.maxTurns! + Number(maxTurnsArg.slice(1))
            : Number(maxTurnsArg)
          if (Number.isFinite(maxTurns) && maxTurns > 0) {
            await editGoal({ maxTurns })
          }
        }
        const resumed = await resumeGoal()
        addCommandResult(resumed ? `Goal resumed: ${resumed.objective}` : 'No goal to resume.')
        return
      }

      if (lower === 'cancel') {
        const cancelled = await cancelGoal()
        addCommandResult(cancelled ? `Goal cancelled: ${cancelled.objective}` : 'No goal to cancel.')
        return
      }

      if (lower === 'clear') {
        await clearGoal()
        addCommandResult('Goal cleared.')
        return
      }

      if (lower === 'steer') {
        const steering = rest.join(' ').trim()
        if (!steering) {
          addCommandResult('Usage: /goal steer <instruction>')
          return
        }
        const steered = await steerGoal(steering)
        addCommandResult(steered ? 'Goal steering queued.' : 'No goal to steer.')
        return
      }

      if (lower === 'edit') {
        const parsed = parseGoalCreateArgs(rest.join(' '))
        const edited = await editGoal({
          objective: parsed.objective || undefined,
          maxTurns: parsed.maxTurns,
        })
        addCommandResult(edited ? `Goal edited: ${edited.objective}` : 'No goal to edit.')
        return
      }

      if (lower === 'verify') {
        if (!goal) {
          addCommandResult('No goal to verify.')
          return
        }
        const verified = await verifyGoal()
        addCommandResult(
          verified
            ? `Goal verification ${verified.ok ? 'passed' : 'failed'}: ${verified.summary}`
            : 'No goal to verify.',
        )
        return
      }

      const parsed = parseGoalCreateArgs(arg)
      if (!parsed.objective) {
        addCommandResult(
          'Usage: /goal <objective> [--verify "cmd"] [--verifier-agent name] [--verifier-prompt "prompt"] [--max-turns n] [--token-budget n] [--confirm]',
        )
        return
      }
      if (goal?.status === 'active' || goal?.status === 'paused') {
        addCommandResult(`Cannot create a new goal while goal ${goal.id} is ${goal.status}`)
        return
      }
      addCommandResult(`Goal started: ${parsed.objective}`)
      await runGoal({
        objective: parsed.objective,
        maxTurns: parsed.maxTurns,
        tokenBudget: parsed.tokenBudget,
        verifiers: parsed.verifiers,
        requiresUserConfirmation: parsed.requiresUserConfirmation,
      })
    } catch (err) {
      addCommandResult(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCompact() {
    const result = await compact()
    switch (result.status) {
      case 'nothing':
        if (result.reason === 'no-conversation') {
          addCommandResult('Nothing to compress — no active conversation.')
        } else if (result.reason === 'too-few-messages') {
          addCommandResult(
            `Nothing to compress — ${result.messageCount} model message${result.messageCount === 1 ? '' : 's'}; at least ${result.minimumMessages} are required.`,
          )
        } else {
          addCommandResult(
            `Nothing to compress — conversation is ~${formatTokenCount(result.estimatedTokens)} tokens and fits within the ~${formatTokenCount(result.retentionTokens)} recent-message window.`,
          )
        }
        return
      case 'cancelled':
        addCommandResult('Compression cancelled.')
        return
      case 'failed':
        addCommandResult(`Compression failed: ${result.message}`)
        return
    }
    addCommandResult(formatCompactionResult(result.estimatedTokensBefore, result.estimatedTokensAfter))
  }

  async function handleUsage() {
    let usage: TokenUsage = state.usage
    let modelId = state.modelId
    let source: 'live' | 'snapshot' = 'live'
    let breakdown: UsageBreakdown | null | undefined = state.usageBreakdown
    let cacheMissSummary: CacheMissSummary | null | undefined = state.cacheMissSummary
    let sessionName: string | undefined
    let steps: StepStats[] | undefined = state.stepStats.length > 0 ? state.stepStats : undefined
    const info = getSessionInfo()
    if (info?.firstPrompt) {
      sessionName = info.firstPrompt
    }
    if (usage.totalTokens === 0) {
      const latest = await pickLatestSession()
      if (latest && latest.tokenUsage) {
        usage = latest.tokenUsage
        modelId = latest.modelId
        source = 'snapshot'
        sessionName = latest.firstPrompt.slice(0, 80) || undefined
        steps = undefined
        breakdown = latest.usageBreakdown
        cacheMissSummary = latest.cacheMissSummary
      }
    }
    const contextEstimate = source === 'live' && usage.currentContextTokens > 0 ? getContextBreakdown() : null
    addInfoMessage(
      formatUsageReport(usage, modelId, source, sessionName, steps, breakdown, cacheMissSummary, contextEstimate),
    )
  }

  async function handleUsageHistory() {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      addInfoMessage('**Usage history** — no past sessions found in this project.')
      return
    }

    const byId = new Map(sessions.map((s) => [s.sessionId, s]))
    const fmt = (n: number) => n.toLocaleString('en-US')
    const choices = dedupeChoiceLabels(
      sessions.map((s) => {
        const preview = (s.firstPrompt || '(empty)').slice(0, 50).replace(/\s+/g, ' ').trim()
        const ago = formatRelativeTime(s.mtime)
        const total = s.tokenUsage ? fmt(s.tokenUsage.totalTokens) : '—'
        const lineage = forkLineageHint(s, byId)
        return {
          label: `${s.name ? `${s.name}  ·  ` : ''}${preview}  ·  ${ago}`,
          description: `${s.modelId}  ·  ${total} tokens${lineage ? `  ·  ${lineage}` : ''}`,
          sessionId: s.sessionId,
          session: s,
        }
      }),
    )

    const BACK_LABEL = '← Back to list'
    const tick = () => new Promise<void>((r) => setTimeout(r, 50))

    while (true) {
      const answer = await askQuestion(
        `**Usage history** — ${sessions.length} session${sessions.length === 1 ? '' : 's'}. Pick one to view details:`,
        choices.map((c) => ({ label: c.label, description: c.description })),
        { noOther: true },
      )

      const picked = choices.find((c) => c.label === answer)
      if (!picked) break

      const s = picked.session
      const usage = s.tokenUsage
      if (!usage) {
        addInfoMessage(
          `**${s.name ? `${s.name} — ` : ''}${(s.firstPrompt || '(empty)').slice(0, 60)}**\n\nNo usage data recorded (interrupted before first turn).`,
        )
      } else {
        addInfoMessage(
          formatUsageReport(
            usage,
            s.modelId,
            'history',
            s.name ?? (s.firstPrompt.slice(0, 80) || undefined),
            undefined,
            s.usageBreakdown,
            s.cacheMissSummary,
          ),
        )
      }

      await tick()

      const back = await askQuestion(
        'Press Enter to return, or Esc to exit.',
        [{ label: BACK_LABEL, description: 'Go back to the session list.' }],
        { noOther: true },
      )

      if (!back) break
    }
  }

  async function handleMemory(rawArg: string) {
    const service = options.memoryService
    if (!service) {
      addInfoMessage('Memory v2 is unavailable in this session.')
      return
    }
    const arg = rawArg.trim()
    if (!arg) {
      const topics = service.listTopics()
      if (topics.length === 0) {
        addInfoMessage('**Global memory** — empty.')
        return
      }
      const lines = [`**Global memory** — ${topics.length} topic${topics.length === 1 ? '' : 's'}.`, '']
      for (const topic of topics) {
        const detail = topic.summary || topic.description
        lines.push(`- ${topic.pinned ? '📌 ' : ''}\`${topic.id}\` · ${topic.type} · ${topic.facts} facts — ${detail}`)
      }
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg === 'status') {
      const status = await service.status()
      const lines = [
        `**Memory status** — ${status.error ? 'error' : status.initialized ? 'ready' : 'initializing'}`,
        '',
        `- Schema: ${status.schemaVersion ?? 'unsupported'} · generation ${status.generation}`,
        `- Topics: ${status.topics} · facts: ${status.facts}`,
        `- Queue: ${status.queue.pending} pending · ${status.queue.running} running · ${status.queue.failed} failed`,
        `- Worker: ${status.worker}`,
      ]
      if (status.lastRun) {
        lines.push(
          `- Last run: ${status.lastRun.status} · ${status.lastRun.operations} operations · ${status.lastRun.durationMs} ms`,
        )
      }
      if (status.error) lines.push(`- Error: ${status.error}`)
      for (const invalid of status.invalidTopics) lines.push(`- Invalid: \`${invalid.path}\` — ${invalid.error}`)
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg === 'reload') {
      try {
        await reloadMemory()
        const status = await service.status()
        addInfoMessage(
          `Memory reloaded — generation ${status.generation}, ${status.topics} topics, ${status.invalidTopics.length} invalid.`,
        )
      } catch (error) {
        addInfoMessage(`Memory reload failed: ${errorMessage(error)}`)
      }
      return
    }
    if (arg === 'explain') {
      const trace = service.getLastTrace()
      if (!trace) {
        addInfoMessage('No memory recall has run in this session yet.')
        return
      }
      const lines = [
        `**Memory recall** — generation ${trace.generation}${trace.selectorUsed ? ' · semantic selector used' : ''}`,
        '',
        `- Query: ${trace.query}`,
        `- Selected: ${trace.selectedTopicIds.join(', ') || '(none)'}`,
        `- Packed: ${trace.packedTokens} estimated tokens`,
        '',
        ...trace.candidates
          .slice(0, 10)
          .map(
            (candidate) =>
              `- \`${candidate.topicId}\` · ${candidate.score.toFixed(3)} · ${candidate.routes.join('+')} · coverage ${Math.round(candidate.coverage * 100)}%`,
          ),
      ]
      addInfoMessage(lines.join('\n'))
      return
    }
    if (arg.startsWith('search ')) {
      let query = arg.slice('search '.length).trim()
      const semantic = query.startsWith('--semantic ')
      if (semantic) query = query.slice('--semantic '.length).trim()
      if (!query) {
        addInfoMessage('Usage: /memory search [--semantic] <query>')
        return
      }
      try {
        const results = await service.search({ query, semantic, maxResults: 5 }, { repositoryId: process.cwd() })
        if (results.length === 0) {
          addInfoMessage(`No memory matched \`${query}\`.`)
          return
        }
        addInfoMessage(
          [`**Memory search** — ${results.length} results.`, '']
            .concat(
              results.map(
                (result) =>
                  `- \`${result.topicId}\` / ${result.section} — ${result.snippet.replace(/\s+/g, ' ').slice(0, 240)}`,
              ),
            )
            .join('\n'),
        )
      } catch (error) {
        addInfoMessage(`Memory search failed: ${errorMessage(error)}`)
      }
      return
    }
    addInfoMessage('Usage: /memory [status|search [--semantic] <query>|explain|reload]')
  }

  // 斜杠命令处理器位于 ./commands/{skill,plugin,mcp}.ts。每个工厂闭包捕获
  // App 渲染时的依赖，并返回上方分发器调用的处理器。与这些曾是行内函数声明时的
  // 逐渲染身份行为相同。
  const { handleSkill } = createSkillCommandHandler({
    options,
    addCommandMessage,
    invalidateSystemPromptCache,
    pendingSkillRef,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handlePlugin } = createPluginCommandHandler({
    options,
    addCommandMessage,
    askQuestion,
    invalidateSystemPromptCache,
    bumpSkillRegistryVersion: () => setSkillRegistryVersion((v) => v + 1),
  })

  const { handleMcp } = createMcpCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    askQuestion,
    invalidateSystemPromptCache,
  })

  const { handleContext } = createContextCommandHandler({
    modelId: state.modelId,
    addCommandMessage,
  })

  const { handleBrowser } = createBrowserCommandHandler({
    options,
    addCommandMessage,
    addCommandResult,
    invalidateSystemPromptCache,
  })

  const handleDoctor = createDoctorCommandHandler({
    options,
    modelId: state.modelId,
    addInfoMessage,
    echoCommand,
  })

  // 渲染架构
  //
  // `ChatInput` 拥有初始 header 之下的整个终端区域：
  //   - scrollback 消息通过直接写 stdout 提交
  //   - spinner / 输入 / 分隔符 / 补全 / 错误 / Permission 对话框 /
  //     SelectOptions 对话框全部渲染进一个单元级 diff 缓冲
  //
  // Ink 的动态区域始终为空——我们不在 Ink 自己的子树里渲染任何子元素。如果 Ink
  // 在那里写入，它内部对 `\x1b7`/`\x1b8` 的使用会破坏我们的光标锚点并留下僵尸
  // 帧。早期版本把 SelectOptions 作为直接 Ink 子元素保留，但当对话框变得比
  // ChatInput 更高时，它的渲染触发终端自动滚动，在对话框关闭后在 scrollback 里
  // 留下永久空行——所以它也被移进了 ChatInput 的 cell 缓冲。
  const permissionRequest = state.permissionQueue[0]
  const authorityRequest = state.authorityRequest
  const selectActive = !!state.pendingQuestion
  const visibleTerminals = visibleBackgroundTerminals(state.backgroundTerminals)

  return (
    <ChatInput
      messages={state.messages}
      initialContentRows={getHeaderRowCount(state.modelId)}
      onSubmit={handleSubmit}
      onInterrupt={handleCtrlC}
      onEscapeCancel={cancelActiveOperation}
      permissionMode={state.permissionMode}
      isLoading={state.isLoading || authOperation !== null}
      notice={notice}
      peerInfluenced={state.peerInfluenced}
      trustMode={options.trustMode}
      pendingPeerCount={peerInbox.accepted + peerInbox.held}
      // 当选择对话框打开时，抑制 spinner 的 "Working" 行，但保持 ChatInput 本身
      // 可见——对话框现在渲染在它的 cell 缓冲内部，而不是 Ink 的顶层子树。
      //
      // Permission 对话框绝不能抑制 spinner：活动工具列表渲染在 ChatInput 的
      // `if (spinner)` 块内部，所以把 spinner 置 null 会隐藏那些 Running 指示器——
      // 用户看到的是没有可见权限提示的冻结屏幕。
      spinner={
        (state.isLoading || authOperation !== null) && !selectActive
          ? {
              // 当一连串可折叠的只读工具进行中时，逐工具的实时指示器被抑制
              // （每次快速读取都会闪烁 "出现 → 消失"），而通用的 "Working…" 标签
              // 会让持续数秒的读取链看起来卡住了。`bufferingReads` 在连续读取之间
              // 50-200ms 的间隙里是粘性的——没有它，标签会在每个工具上闪烁
              // Reading-Working-Reading。由 useAgent 在 tool-call / text-delta /
              // loop-end / abort 时更新。
              label:
                authOperation === 'login'
                  ? 'Signing in'
                  : authOperation === 'logout'
                    ? 'Signing out'
                    : state.reconnectLabel
                      ? state.reconnectLabel
                      : state.ingestLabel
                        ? state.ingestLabel
                        : state.compressionLabel
                          ? `Compressing — ${state.compressionLabel}`
                          : state.bufferingReads
                            ? 'Reading'
                            : 'Working',
              mode: authOperation === null && state.activeToolCalls.length > 0 ? 'tool-use' : 'requesting',
            }
          : null
      }
      activeTurnOwner={activeTurnOwner()}
      hasStableForkBoundary={hasActiveForkBoundary()}
      contextUsage={
        // Footer 指示器（`6.6k / 200k · 3%`）——使用最近一次 API 响应的快照，而非
        // 累积的会话计数器。累积计数每个回合都把消息历史重复计算一次（cache 命中
        // 的输入仍会出现在 `inputTokens` 里），所以它的数字会远超实际计费。在第一个
        // 回合落定之前隐藏。
        state.usage.currentContextTokens > 0
          ? { used: state.usage.currentContextTokens, window: getContextWindow(state.modelId) }
          : null
      }
      // Footer 右侧：活动的模型标签，始终显示。由于 switchModel 更新 state.modelId，
      // 它在 /model 切换时自动重渲染。当模型配置了 reasoning-effort 层级（通过
      // /model 层级选择器）时，它追加在名称旁——例如 "deepseek-flash · High"。
      modelLabel={
        reasoningTierLabel
          ? `${renderModelLabel(state.modelId)} · ${reasoningTierLabel}`
          : renderModelLabel(state.modelId)
      }
      activeToolCalls={state.activeToolCalls}
      shellWaitStreak={state.shellWaitStreak}
      backgroundTerminalCount={visibleTerminals.length}
      backgroundTerminalWarningCount={
        visibleTerminals.filter((terminal) => terminal.status === 'termination-failed').length
      }
      todos={state.todos}
      queuedMessages={state.queuedMessages}
      onPopQueued={popQueuedMessage}
      draftRestore={state.restoredDraft}
      errorMessage={state.error}
      permission={
        permissionRequest
          ? {
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              mcp: permissionRequest.mcp,
              onResolve: resolvePermission,
            }
          : null
      }
      authorityRequest={
        authorityRequest
          ? {
              requestId: authorityRequest.requestId,
              toolName: authorityRequest.toolName,
              preview: authorityRequest.preview,
              onResolve: resolveAuthority,
            }
          : null
      }
      selectRequest={
        state.pendingQuestion
          ? {
              question: state.pendingQuestion.question,
              options: state.pendingQuestion.options,
              onResolve: resolveQuestion,
              dismissible: state.pendingQuestion.dismissible,
              layout: state.pendingQuestion.layout,
            }
          : null
      }
      commands={allCommands}
    />
  )
}
