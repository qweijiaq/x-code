import type { Dispatch, SetStateAction } from 'react'

import type {
  AppState,
  BranchListView,
  DiagnosticsExportResult,
  HooksView,
  LoadedSessionView,
  ProjectSettingsView,
  RuntimeRequest,
  SessionListItem,
  SessionSearchResult,
  SettingsActionResult,
  SettingsSnapshot,
  SmokeReport,
  StorageUsageView,
  TextReport,
  UiSmokeCheck,
  UpdateCheckResult,
} from '../shared/protocol.js'
import i18n from './i18n.js'
import { base64FromBuffer, isImageAttachment } from './media.js'
import { applyTheme, storedTheme } from './theme.js'
import { encodeWav } from './wav.js'

export const isUiSmoke = new URLSearchParams(window.location.search).has('ui-smoke')
export const forcedOnboarding = isUiSmoke && new URLSearchParams(window.location.search).has('onboard')

export interface UiSmokeContext {
  setInput: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<string[]>>
  openDocument: (filePath: string, page?: number) => Promise<void>
  closeInspector: () => void
  activeSessionId: string | null
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) {
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** 渲染进程侧的 UI smoke。放在 App.tsx 之外，让组件文件专注
 *  于交互代码。 */
export async function runUiSmoke(context: UiSmokeContext): Promise<void> {
  const { setInput, setAttachments, openDocument, closeInspector, activeSessionId } = context
  const reportProgress = (name: string): void => window.xcode.reportUiSmokeProgress(name)
  const checks: Record<string, UiSmokeCheck> = new Proxy({} as Record<string, UiSmokeCheck>, {
    set(target, property, value) {
      const stored = Reflect.set(target, property, value)
      reportProgress(`check:${String(property)}`)
      return stored
    },
  })
  reportProgress('start')
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === 'xcode.lastSession' || key.startsWith('xcode.draft.')) localStorage.removeItem(key)
    }
    setInput('')
    setAttachments([])
  } catch {
    // Smoke 隔离是尽力而为。
  }
  const openToolsMenu = async (): Promise<boolean> => {
    document.querySelector<HTMLButtonElement>('[data-testid="tools-menu-toggle"]')?.click()
    return waitFor(() => document.querySelector('[data-testid="tools-menu"]') !== null, 2_000)
  }
  let originalModelId: string | null = null
  let workspace = ''
  const originalLanguage = i18n.language === 'en' ? 'en' : 'zh'
  const originalTheme = storedTheme()
  if (originalLanguage !== 'zh') await i18n.changeLanguage('zh')
  applyTheme('light')
  try {
    if (forcedOnboarding) {
      const shown = await waitFor(() => document.querySelector('[data-testid="onboarding"]') !== null, 5_000)
      const title = document.querySelector('.onboarding-title')?.textContent ?? ''
      const nextButton = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
      ).find((button) => !button.classList.contains('btn-quiet'))
      nextButton?.click()
      const providerStep = await waitFor(
        () => document.querySelector('[data-testid="onboarding"] .onboarding-provider') !== null,
        2_000,
      )
      // 既没输入 key 也没有存储的 key 时，测试按钮必须自己说明原因，
      // 而不是静默忽略这次点击。
      const anyConfigured = document.querySelector('[data-testid="onboarding"] .onboarding-available') !== null
      let testResponded = anyConfigured
      let testDetail = anyConfigured ? 'skipped (provider configured)' : 'no feedback'
      if (!anyConfigured) {
        const testButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn-quiet'),
        ).find((button) => (button.textContent ?? '').includes('测试连接'))
        testButton?.click()
        testResponded = await waitFor(
          () => document.querySelector('[data-testid="onboarding"] .onboarding-test.fail') !== null,
          2_000,
        )
        testDetail = testResponded
          ? (document.querySelector('[data-testid="onboarding"] .onboarding-test.fail')?.textContent ?? 'error shown')
          : 'no result shown'
      }
      // 用一个一次性 key 走「保存并继续」路径，然后清除它，
      // 回到演示模型做剩下的检查。
      const keyInput = document.querySelector<HTMLInputElement>('[data-testid="onboarding"] input[type="password"]')
      let keySaveStep = false
      let keySaveDetail = 'password input missing'
      if (keyInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(keyInput, 'sk-ant-smoke-test')
        keyInput.dispatchEvent(new Event('input', { bubbles: true }))
        const saveButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
        ).find((button) => (button.textContent ?? '').includes('保存并继续'))
        saveButton?.click()
        keySaveStep = await waitFor(
          () => document.querySelector('[data-testid="onboarding"] .onboarding-choices') !== null,
          10_000,
        )
        keySaveDetail = keySaveStep
          ? 'saved and advanced'
          : (document.querySelector('[data-testid="onboarding"] .settings-warn')?.textContent ?? 'no error shown')
        const activeProvider =
          document.querySelector('[data-testid="onboarding"] .onboarding-provider.active span')?.textContent ??
          'anthropic'
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:clear-api-key',
          params: { provider: activeProvider },
        })
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'models:set',
          params: { modelId: 'demo:mock' },
        })
      }
      if (!keySaveStep) {
        const quietButtons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn-quiet'),
        )
        quietButtons[quietButtons.length - 1]?.click()
      }
      const preferenceStep = await waitFor(
        () => document.querySelector('[data-testid="onboarding"] .onboarding-choices') !== null,
        2_000,
      )
      const startButton = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding"] .onboarding-actions .btn'),
      ).find((button) => (button.textContent ?? '').includes('开始使用'))
      startButton?.click()
      const dismissed = await waitFor(() => document.querySelector('[data-testid="onboarding"]') === null, 3_000)
      checks.onboarding = {
        ok: shown && providerStep && preferenceStep && dismissed && title.length > 0 && testResponded,
        detail: `shown=${shown} provider=${providerStep} test=${testDetail} saveKey=${keySaveDetail} prefs=${preferenceStep} dismissed=${dismissed} title=${title}`,
      }
    }
    const stateResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:state',
      params: {},
    })
    if (stateResponse.ok) {
      const state = stateResponse.result as AppState
      workspace = state.workspace
      originalModelId = state.demo ? null : state.activeModelId
      if (!state.demo) {
        await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'models:set',
          params: { modelId: 'demo:mock' },
        })
      }
    }

    let text = ''
    const offText = window.xcode.onEvent((event) => {
      if (event.type === 'agent:text-delta') text += event.delta
    })
    const agent = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: 'ui smoke' },
    })
    offText()
    checks.agent = {
      ok: agent.ok && text.includes('演示模型'),
      detail: agent.ok ? `streamed ${text.length} chars` : agent.error.message,
    }
    const contextMeterReady = await waitFor(
      () => document.querySelector('.context-meter .context-numbers')?.textContent?.includes('/') ?? false,
      2_000,
    )
    const contextNumbersText = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
    checks.contextMeter = {
      ok: contextMeterReady && /\d.*\/.*\d/.test(contextNumbersText),
      detail: contextNumbersText || 'context meter missing',
    }

    const attachmentState: {
      event: { files: string[]; mediaParts: number; textBytes: number } | null
    } = { event: null }
    const offAttach = window.xcode.onEvent((event) => {
      if (event.type === 'agent:attachments') attachmentState.event = event
    })
    const attachmentTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: 'attachment smoke', attachments: [`${workspace}/README.md`] },
    })
    offAttach()
    checks.attachment = {
      ok:
        attachmentTurn.ok &&
        attachmentState.event !== null &&
        attachmentState.event.files.length === 1 &&
        attachmentState.event.textBytes > 0,
      detail: attachmentState.event
        ? `${attachmentState.event.files.length} file(s), ${attachmentState.event.textBytes} chars, ${attachmentState.event.mediaParts} media`
        : 'no agent:attachments event',
    }

    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[markdown-demo]' },
    })
    const markdownReady = await waitFor(
      () =>
        document.querySelector('.code-block') !== null &&
        document.querySelector('.markdown table') !== null &&
        document.querySelector('.code-block .copy-btn') !== null,
      5_000,
    )
    const copyButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.code-block .copy-btn')).find(
      (button) => button.textContent?.trim() === '复制',
    )
    copyButton?.click()
    const copied = await waitFor(() => copyButton?.textContent === '已复制', 2_000)
    checks.markdown = {
      ok: markdownReady && copied,
      detail: markdownReady
        ? `code block, table rendered; copy=${copied ? 'ok' : 'failed'}`
        : 'markdown did not render',
    }

    const composer = document.querySelector('.composer textarea') as HTMLTextAreaElement | null
    if (composer) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(composer, '@')
      composer.setSelectionRange(1, 1)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      const paletteReady = await waitFor(
        () => document.querySelectorAll('[data-testid="mention-palette"] .slash-item').length > 1,
        3_000,
      )
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
      const arrowKept = await waitFor(
        () =>
          document.querySelectorAll('[data-testid="mention-palette"] .slash-item')[1]?.classList.contains('active') ??
          false,
        1_500,
      )
      const firstItem = document.querySelector(
        '[data-testid="mention-palette"] .slash-item',
      ) as HTMLButtonElement | null
      firstItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const inserted = await waitFor(() => composer.value.startsWith('@') && composer.value.length > 2, 2_000)
      checks.mention = {
        ok: paletteReady && arrowKept && inserted,
        detail: `palette=${paletteReady} arrow=${arrowKept} inserted=${inserted}`,
      }
      setValue?.call(composer, '')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      checks.mention = { ok: false, detail: 'composer textarea missing' }
    }

    let sawApproval = false
    let sawDiff = false
    let diffEdit: { toolCallId: string; filePath: string } | null = null
    const offTool = window.xcode.onEvent((event) => {
      if (event.type === 'approval:request' && event.kind === 'permission') {
        sawApproval = true
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'approval:respond',
          params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
        })
      }
      if (event.type === 'agent:file-edit') {
        sawDiff = true
        diffEdit = { toolCallId: event.toolCallId, filePath: event.payload.filePath }
      }
    })
    const toolTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[tool-demo]' },
    })
    offTool()
    checks.toolFlow = {
      ok: toolTurn.ok && sawApproval && sawDiff,
      detail: `approval=${sawApproval} diff=${sawDiff}`,
    }
    const lastToolCard = Array.from(document.querySelectorAll('.chat > .tool-card')).pop()
    const lastAssistant = Array.from(document.querySelectorAll('.chat > .message.assistant')).pop()
    const toolOrderBits = lastToolCard && lastAssistant ? lastToolCard.compareDocumentPosition(lastAssistant) : 0
    const toolOrderOk = (toolOrderBits & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    checks.toolOrder = {
      ok: toolOrderOk,
      detail: `tool=${Boolean(lastToolCard)} answer=${Boolean(lastAssistant)} after=${toolOrderOk}`,
    }
    const capturedEdit = diffEdit as { toolCallId: string; filePath: string } | null
    if (capturedEdit) {
      const revertResponse = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'edit:revert',
        params: { toolCallId: capturedEdit.toolCallId },
      })
      checks.editRevert = {
        ok: revertResponse.ok,
        detail: revertResponse.ok
          ? (revertResponse.result as { message: string }).message
          : revertResponse.error.message,
      }
    } else {
      checks.editRevert = { ok: false, detail: 'no file-edit event captured' }
    }

    let tempHint = false
    let tempMoved = false
    const offTemp = window.xcode.onEvent((event) => {
      if (event.type === 'approval:request' && event.kind === 'permission') {
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'approval:respond',
          params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
        })
      }
    })
    const hintsBefore = document.querySelectorAll('[data-testid="temp-deliverable-hint"]').length
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[temp-deliverable-demo]' },
    })
    offTemp()
    tempHint = await waitFor(
      () => document.querySelectorAll('[data-testid="temp-deliverable-hint"]').length > hintsBefore,
      10_000,
    )
    const tempHintNodes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="temp-deliverable-hint"]'))
    const tempHintNode = tempHintNodes.at(-1) ?? null
    if (tempHintNode) {
      await waitFor(() => {
        const moveButton = tempHintNode.querySelector<HTMLButtonElement>('button')
        return Boolean(moveButton && !moveButton.disabled)
      }, 10_000)
      tempHintNode.querySelector<HTMLButtonElement>('button')?.click()
      tempMoved = await waitFor(() => document.querySelector('[data-testid="temp-deliverable-moved"]') !== null, 5_000)
    }
    const tempError = Array.from(document.querySelectorAll('.message.error')).pop()?.textContent ?? ''
    checks.tempDeliverable = {
      ok: tempHint && tempMoved,
      detail: `hint=${tempHint} moved=${tempMoved}${tempError ? ` error=${tempError.slice(0, 120)}` : ''}`,
    }

    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[background-task-demo]' },
    })
    let backgroundTaskSeen = false
    for (let attempt = 0; attempt < 60; attempt++) {
      const list = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'background:list',
        params: {},
      })
      const tasks = list.ok ? ((list.result as { tasks?: Array<{ agentName?: string }> }).tasks ?? []) : []
      if (tasks.some((task) => task.agentName === 'general-purpose')) {
        backgroundTaskSeen = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    checks.backgroundTask = {
      ok: backgroundTaskSeen,
      detail: `task=${backgroundTaskSeen}`,
    }
    let backgroundSharedSeen = false
    for (let attempt = 0; attempt < 40; attempt++) {
      const shared = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'background:shared',
        params: {},
      })
      const items = shared.ok ? ((shared.result as { items?: Array<{ kind?: string }> }).items ?? []) : []
      if (items.some((item) => item.kind === 'agent')) {
        backgroundSharedSeen = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    checks.backgroundShared = {
      ok: backgroundSharedSeen,
      detail: `shared=${backgroundSharedSeen}`,
    }

    let subagentStart = false
    let subagentEnd = false
    const offSubagent = window.xcode.onEvent((event) => {
      if (event.type === 'agent:subagent') {
        if (event.phase === 'start') subagentStart = true
        if (event.phase === 'end') subagentEnd = true
      }
      if (event.type === 'approval:request' && event.kind === 'permission') {
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'approval:respond',
          params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
        })
      }
    })
    const subagentTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[subagent-demo]' },
    })
    offSubagent()
    const subagentDom = await waitFor(() => document.querySelector('[data-testid="subagent"]') !== null, 3_000)
    checks.subagent = {
      ok: subagentTurn.ok && subagentStart && subagentEnd && subagentDom,
      detail: `turn=${subagentTurn.ok} start=${subagentStart} end=${subagentEnd} dom=${subagentDom}`,
    }

    let sawDenyApproval = false
    let deniedDiff = false
    const offDeny = window.xcode.onEvent((event) => {
      if (event.type === 'approval:request' && event.kind === 'permission') {
        sawDenyApproval = true
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'approval:respond',
          params: { requestId: event.requestId, kind: 'permission', decision: 'no' },
        })
      }
      if (event.type === 'agent:file-edit') deniedDiff = true
    })
    const denyTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[tool-demo]' },
    })
    offDeny()
    checks.toolDeny = {
      ok: denyTurn.ok && sawDenyApproval && !deniedDiff,
      detail: `approval=${sawDenyApproval} diff=${deniedDiff}`,
    }

    const turnToggles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="turn-tool-toggle"]'))
    const lastTurnToggle = turnToggles.at(-1)
    const turnToolCount = Number(/工具调用\s*(\d+)\s*次/.exec(lastTurnToggle?.textContent ?? '')?.[1] ?? 0)
    const toolCardsBefore = document.querySelectorAll('.tool-card').length
    lastTurnToggle?.querySelector<HTMLButtonElement>('[data-testid="turn-tool-toggle-button"]')?.click()
    const toolsHidden = await waitFor(
      () => document.querySelectorAll('.tool-card').length === toolCardsBefore - turnToolCount,
      2000,
    )
    const toggleStays = lastTurnToggle?.isConnected === true
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="turn-tool-toggle"]'))
      .at(-1)
      ?.querySelector<HTMLButtonElement>('[data-testid="turn-tool-toggle-button"]')
      ?.click()
    const toolsRestored = await waitFor(() => document.querySelectorAll('.tool-card').length === toolCardsBefore, 2000)
    checks.turnToolCollapse = {
      ok: turnToggles.length >= 2 && turnToolCount > 0 && toolsHidden && toggleStays && toolsRestored,
      detail: `turns=${turnToggles.length} tools=${turnToolCount} hidden=${toolsHidden} keeps=${toggleStays} restored=${toolsRestored}`,
    }

    // 构造足够的历史，让响应式压缩有内容可总结，然后让演示模型
    // 用上下文溢出错误拒绝下一次请求。该轮必须自行恢复。
    const filler = '上下文填充内容，用于触发自动压缩。'.repeat(4000)
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: `填充一：${filler}` },
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: `填充二：${filler}` },
    })
    let sawCompression = false
    let compactText = ''
    const offCompact = window.xcode.onEvent((event) => {
      if (event.type === 'agent:context-compressed') sawCompression = true
      if (event.type === 'agent:text-delta') compactText += event.delta
    })
    const compactTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[compact-demo]' },
    })
    offCompact()
    checks.contextCompaction = {
      ok: compactTurn.ok && sawCompression && compactText.includes('压缩'),
      detail: `compressed=${sawCompression} chars=${compactText.length}`,
    }

    const sessionList = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:list',
      params: {},
    })
    const list = sessionList.ok ? (sessionList.result as SessionListItem[]) : []
    const currentSessionId = toolTurn.ok ? (toolTurn.result as { sessionId: string }).sessionId : ''
    const target = list.find((item) => item.sessionId === currentSessionId) ?? list[0]
    checks.sessions = { ok: list.length > 0, detail: `${list.length} session(s)` }
    if (target) {
      const loaded = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:load',
        params: { filePath: target.filePath },
      })
      const view = loaded.ok ? (loaded.result as LoadedSessionView) : null
      checks.sessionResume = {
        ok: Boolean(view && view.messages.length > 0),
        detail: loaded.ok ? `${view?.messages.length ?? 0} message(s)` : loaded.error.message,
      }
    } else {
      checks.sessionResume = { ok: false, detail: 'no session to resume' }
    }

    const backgroundFork = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:fork-background',
      params: {},
    })
    const forkResult = backgroundFork.ok
      ? (backgroundFork.result as { sessionId: string; snapshot?: string })
      : undefined
    checks.sessionForkBackground = {
      ok: Boolean(forkResult && forkResult.snapshot?.includes('Parent window snapshot')),
      detail: backgroundFork.ok
        ? `fork=${forkResult?.sessionId ?? ''} snapshot=${forkResult?.snapshot?.slice(0, 40) ?? 'missing'}`
        : backgroundFork.error.message,
    }

    const settingsResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:get',
      params: {},
    })
    const snapshot = settingsResponse.ok ? (settingsResponse.result as SettingsSnapshot) : null
    checks.settings = {
      ok: Boolean(snapshot && snapshot.providers.length > 0 && snapshot.tools.length > 0),
      detail: snapshot
        ? `${snapshot.providers.length} providers, ${snapshot.tools.length} tools, ${snapshot.mcpServers.length} mcp`
        : settingsResponse.ok
          ? 'empty settings'
          : settingsResponse.error.message,
    }
    const settingsButton = document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')
    settingsButton?.click()
    const settingsMounted = await waitFor(() => document.querySelector('.settings-drawer') !== null, 3000)
    const appearanceMounted = await waitFor(() => document.querySelector('.settings-appearance') !== null, 2_000)
    checks.settingsPanel = {
      ok: settingsMounted && appearanceMounted,
      detail: settingsMounted
        ? `settings drawer mounted${appearanceMounted ? ', appearance controls present' : ', appearance missing'}`
        : 'settings drawer missing',
    }
    const customFields = Array.from(
      document.querySelectorAll<HTMLInputElement>('[data-testid="provider-fields"] input'),
    )
    const customGap =
      customFields.length >= 2
        ? customFields[1].getBoundingClientRect().top - customFields[0].getBoundingClientRect().bottom
        : 0
    checks.customProviderFields = {
      ok: customFields.length >= 2 && customGap >= 8,
      detail:
        customFields.length >= 2
          ? `custom fields mounted, gap=${customGap.toFixed(1)}px`
          : 'custom model fields missing',
    }
    const updateInput = document.querySelector<HTMLInputElement>(
      '[data-testid="update-check"] .update-controls .settings-input',
    )
    const updateButton = document.querySelector<HTMLButtonElement>('[data-testid="update-check"] .update-buttons .btn')
    const updateGap =
      updateInput && updateButton
        ? updateButton.getBoundingClientRect().top - updateInput.getBoundingClientRect().bottom
        : 0
    checks.updateSpacing = {
      ok: Boolean(updateInput && updateButton) && updateGap >= 8,
      detail: updateInput && updateButton ? `update controls gap=${updateGap.toFixed(1)}px` : 'update controls missing',
    }
    const settingsTabs = document.querySelectorAll<HTMLButtonElement>('.settings-tab')
    const clickSettingsTab = (label: string): void => {
      Array.from(settingsTabs)
        .find((tab) => tab.textContent?.trim() === label)
        ?.click()
    }
    clickSettingsTab('技能')
    const skillCommandMounted = await waitFor(
      () => document.querySelector('[data-testid="skill-command"]') !== null,
      2000,
    )
    const skillReloadButton = document.querySelector('[data-testid="skills-reload"]') !== null
    const envRefreshButton = document.querySelector('[data-testid="env-refresh"]') !== null
    checks.skillCommandTab = {
      ok: skillCommandMounted && skillReloadButton && envRefreshButton,
      detail: skillCommandMounted
        ? `skill command field mounted, reload=${skillReloadButton} env=${envRefreshButton}`
        : 'skill command field missing',
    }
    const skillReload = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'skills:reload',
      params: {},
    })
    checks.skillReload = {
      ok: skillReload.ok,
      detail: skillReload.ok
        ? `rescanned ${(skillReload.result as SettingsActionResult).settings.skills.length} skill(s)`
        : skillReload.error.message,
    }
    clickSettingsTab('技能市场')
    const skillMarketMounted = await waitFor(
      () => document.querySelector('[data-testid="skill-market-query"]') !== null,
      2000,
    )
    const skillMarketProviders =
      document.querySelector('[data-testid="skill-market-skillhub"]') !== null &&
      document.querySelector('[data-testid="skill-market-skillsmp"]') !== null
    document.querySelector<HTMLButtonElement>('[data-testid="skill-market-skillsmp"]')?.click()
    const skillMarketMcpRow = await waitFor(
      () => document.querySelector('[data-testid="skill-market-mcp"]') !== null,
      2000,
    )
    const skillMarketMcpButton = document.querySelector('[data-testid="skill-market-register-mcp"]') !== null
    document.querySelector<HTMLButtonElement>('[data-testid="skill-market-skillhub"]')?.click()
    const skillMarketSearchDisabled =
      document.querySelector<HTMLButtonElement>('[data-testid="skill-market-search"]')?.disabled === true
    checks.skillMarketTab = {
      ok:
        skillMarketMounted &&
        skillMarketProviders &&
        skillMarketMcpRow &&
        skillMarketMcpButton &&
        skillMarketSearchDisabled,
      detail: `tab=${skillMarketMounted} providers=${skillMarketProviders} mcpRow=${skillMarketMcpRow} mcpButton=${skillMarketMcpButton} emptyQueryDisabled=${skillMarketSearchDisabled}`,
    }
    clickSettingsTab('插件市场')
    const marketMounted = await waitFor(() => document.querySelector('.market-form') !== null, 3000)
    checks.marketplaceTab = {
      ok: marketMounted,
      detail: marketMounted ? 'marketplace tab mounted' : 'marketplace tab missing',
    }

    clickSettingsTab('文档库')
    const libraryPanel = await waitFor(() => document.querySelector('[data-testid="library-tab"]') !== null, 3_000)
    let libraryIndexed = false
    let librarySearchOk = false
    if (libraryPanel) {
      document.querySelector<HTMLButtonElement>('[data-testid="library-index"]')?.click()
      libraryIndexed = await waitFor(() => {
        const value = document.querySelector('[data-testid="library-tab"] .library-status b')?.textContent ?? '0'
        return Number(value) > 0
      }, 30_000)
      const libraryInput = document.querySelector<HTMLInputElement>('[data-testid="library-search-input"]')
      if (libraryInput) {
        const setLibraryValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setLibraryValue?.call(libraryInput, 'Attachment smoke')
        libraryInput.dispatchEvent(new Event('input', { bubbles: true }))
        libraryInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        librarySearchOk = await waitFor(
          () => document.querySelectorAll('[data-testid="library-results"] .library-result').length > 0,
          20_000,
        )
      }
    }
    checks.library = {
      ok: libraryPanel && libraryIndexed && librarySearchOk,
      detail: `panel=${libraryPanel} indexed=${libraryIndexed} search=${librarySearchOk}`,
    }
    clickSettingsTab('模型与密钥')
    const contextInputMounted = await waitFor(
      () => document.querySelector('[data-testid="context-window-input"]') !== null,
      3000,
    )
    const contextInput = document.querySelector<HTMLInputElement>('[data-testid="context-window-input"]')
    let contextSaved = false
    let contextReset = false
    if (contextInput) {
      const setContextValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setContextValue?.call(contextInput, '131072')
      contextInput.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(
        () => document.querySelector<HTMLButtonElement>('[data-testid="context-window-save"]')?.disabled === false,
        2000,
      )
      document.querySelector<HTMLButtonElement>('[data-testid="context-window-save"]')?.click()
      contextSaved = await waitFor(() => document.querySelector('[data-testid="context-window-reset"]') !== null, 4000)
      document.querySelector<HTMLButtonElement>('[data-testid="context-window-reset"]')?.click()
      contextReset = await waitFor(() => document.querySelector('[data-testid="context-window-reset"]') === null, 4000)
    }
    checks.contextWindow = {
      ok: contextInputMounted && contextSaved && contextReset,
      detail: `input=${contextInputMounted} saved=${contextSaved} reset=${contextReset}`,
    }
    clickSettingsTab('权限')
    const permissionTabMounted = await waitFor(
      () => document.querySelector('[data-testid="permission-tool"]') !== null,
      3000,
    )
    let permissionAdded = false
    let permissionRemoved = false
    if (permissionTabMounted) {
      const permissionToolInput = document.querySelector<HTMLInputElement>('[data-testid="permission-tool"]')
      const permissionPatternInput = document.querySelector<HTMLInputElement>('[data-testid="permission-pattern"]')
      const setPermissionValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setPermissionValue?.call(permissionToolInput, 'shell')
      permissionToolInput?.dispatchEvent(new Event('input', { bubbles: true }))
      setPermissionValue?.call(permissionPatternInput, 'echo smoke-perm')
      permissionPatternInput?.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(
        () => document.querySelector<HTMLButtonElement>('[data-testid="permission-add"]')?.disabled === false,
        2000,
      )
      document.querySelector<HTMLButtonElement>('[data-testid="permission-add"]')?.click()
      permissionAdded = await waitFor(
        () => document.querySelector('[data-testid="permission-remove"][data-rule="shell:echo smoke-perm:*"]') !== null,
        4000,
      )
      document
        .querySelector<HTMLButtonElement>('[data-testid="permission-remove"][data-rule="shell:echo smoke-perm:*"]')
        ?.click()
      permissionRemoved = await waitFor(
        () => document.querySelector('[data-testid="permission-remove"][data-rule="shell:echo smoke-perm:*"]') === null,
        4000,
      )
    }
    checks.permissionRules = {
      ok: permissionTabMounted && permissionAdded && permissionRemoved,
      detail: `tab=${permissionTabMounted} add=${permissionAdded} remove=${permissionRemoved}`,
    }
    document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') === null, 2000)

    const modelChip = document.querySelector<HTMLButtonElement>('.model-chip')
    modelChip?.click()
    const customModelMenu = await waitFor(() => document.querySelector('.model-custom') !== null, 2000)
    const modelSearch = document.querySelector<HTMLInputElement>('[data-testid="model-search"]')
    let modelSearchFiltered = false
    let modelSearchEmpty = false
    let modelGroups = false
    if (modelSearch) {
      const setModelSearch = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setModelSearch?.call(modelSearch, 'zzzz-no-model')
      modelSearch.dispatchEvent(new Event('input', { bubbles: true }))
      modelSearchEmpty = await waitFor(
        () => (document.querySelector('.model-list')?.textContent ?? '').includes('没有匹配的模型'),
        2_000,
      )
      setModelSearch?.call(modelSearch, '')
      modelSearch.dispatchEvent(new Event('input', { bubbles: true }))
      modelSearchFiltered = await waitFor(() => document.querySelectorAll('.model-list .model-item').length > 0, 2_000)
      modelGroups = document.querySelectorAll('.model-list .model-group').length > 0
    }
    checks.modelSearch = {
      ok: customModelMenu && Boolean(modelSearch) && modelSearchFiltered && modelSearchEmpty && modelGroups,
      detail: `search=${Boolean(modelSearch)} filtered=${modelSearchFiltered} empty=${modelSearchEmpty} groups=${modelGroups}`,
    }
    checks.customModelMenu = {
      ok: customModelMenu,
      detail: customModelMenu ? 'custom model menu mounted' : 'custom model menu missing',
    }
    const modelContextBadge = document.querySelector('.model-list .model-item-context')?.textContent?.trim() ?? ''
    checks.modelContext = {
      ok: /\d/.test(modelContextBadge),
      detail: modelContextBadge || 'context badge missing',
    }
    const contextBeforeSwitch = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
    document.querySelector<HTMLButtonElement>('.model-list .model-item.active')?.click()
    const switchMenuClosed = await waitFor(() => document.querySelector('.model-menu') === null, 2_000)
    const contextAfterSwitch = document.querySelector('.context-meter .context-numbers')?.textContent?.trim() ?? ''
    checks.modelSwitchUsage = {
      ok:
        switchMenuClosed &&
        Boolean(contextBeforeSwitch) &&
        contextBeforeSwitch === contextAfterSwitch &&
        !contextAfterSwitch.startsWith('0 /'),
      detail: `${contextBeforeSwitch || 'none'} -> ${contextAfterSwitch || 'none'}`,
    }
    document.querySelector<HTMLButtonElement>('.menu-scrim')?.click()

    const toolName = 'webFetch'
    const beforeTool = snapshot?.tools.find((tool) => tool.name === toolName)?.enabled
    if (typeof beforeTool === 'boolean') {
      const toggled = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-enabled',
        params: { name: toolName, enabled: !beforeTool },
      })
      const toggledState = toggled.ok
        ? (toggled.result as SettingsActionResult).settings.tools.find((tool) => tool.name === toolName)?.enabled
        : undefined
      const restored = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-enabled',
        params: { name: toolName, enabled: beforeTool },
      })
      const restoredState = restored.ok
        ? (restored.result as SettingsActionResult).settings.tools.find((tool) => tool.name === toolName)?.enabled
        : undefined
      checks.toolSettings = {
        ok: toggledState === !beforeTool && restoredState === beforeTool,
        detail: `before=${beforeTool} toggled=${toggledState} restored=${restoredState}`,
      }
    } else {
      checks.toolSettings = { ok: false, detail: 'webFetch tool missing' }
    }

    const writeTool = snapshot?.tools.find((tool) => tool.name === 'writeFile')
    if (writeTool) {
      const on = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-always-allow',
        params: { name: 'writeFile', enabled: !writeTool.alwaysAllow },
      })
      const onValue = on.ok
        ? (on.result as SettingsActionResult).settings.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow
        : undefined
      const off = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-always-allow',
        params: { name: 'writeFile', enabled: writeTool.alwaysAllow },
      })
      const offValue = off.ok
        ? (off.result as SettingsActionResult).settings.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow
        : undefined
      checks.toolAlwaysAllow = {
        ok: onValue === !writeTool.alwaysAllow && offValue === writeTool.alwaysAllow,
        detail: `before=${writeTool.alwaysAllow} toggled=${onValue} restored=${offValue}`,
      }
    } else {
      checks.toolAlwaysAllow = { ok: false, detail: 'writeFile tool missing' }
    }

    const beforeAll = snapshot?.alwaysAllowAll ?? false
    const enableAll = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-always-allow-all',
      params: { enabled: !beforeAll },
    })
    const enableValue = enableAll.ok ? (enableAll.result as SettingsActionResult).settings.alwaysAllowAll : undefined
    const restoreAll = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-always-allow-all',
      params: { enabled: beforeAll },
    })
    const restoreValue = restoreAll.ok ? (restoreAll.result as SettingsActionResult).settings.alwaysAllowAll : undefined
    checks.allowAll = {
      ok: enableValue === !beforeAll && restoreValue === beforeAll,
      detail: `before=${beforeAll} enabled=${enableValue} restored=${restoreValue}`,
    }

    const browserBefore = snapshot?.browser.enabled ?? false
    const browserOn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-browser-enabled',
      params: { enabled: !browserBefore },
    })
    const browserOnValue = browserOn.ok
      ? (browserOn.result as SettingsActionResult).settings.browser.enabled
      : undefined
    const browserRestore = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-browser-enabled',
      params: { enabled: browserBefore },
    })
    const browserRestoreValue = browserRestore.ok
      ? (browserRestore.result as SettingsActionResult).settings.browser.enabled
      : undefined
    checks.browserAgent = {
      ok: browserOnValue === !browserBefore && browserRestoreValue === browserBefore,
      detail: `before=${browserBefore} enabled=${browserOnValue} restored=${browserRestoreValue}`,
    }

    const visualBefore = snapshot?.browser.visualCheck ?? true
    const visualOff = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-browser-visual-check',
      params: { enabled: !visualBefore },
    })
    const visualOffValue = visualOff.ok
      ? (visualOff.result as SettingsActionResult).settings.browser.visualCheck
      : undefined
    const visualRestore = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-browser-visual-check',
      params: { enabled: visualBefore },
    })
    const visualRestoreValue = visualRestore.ok
      ? (visualRestore.result as SettingsActionResult).settings.browser.visualCheck
      : undefined
    checks.browserVisualCheck = {
      ok: visualOffValue === !visualBefore && visualRestoreValue === visualBefore,
      detail: `before=${visualBefore} toggled=${visualOffValue} restored=${visualRestoreValue}`,
    }

    // 上面的标签页检查之后抽屉已关闭；在 Tools 标签页重新打开，
    // 以在 DOM 中检查沙箱行。
    document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') !== null, 3_000)
    Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tab'))
      .find((tab) => tab.textContent?.trim() === '工具')
      ?.click()
    const sandboxRow = await waitFor(() => document.querySelector('[data-testid="shell-sandbox"]') !== null, 3_000)
    let sandboxOk = sandboxRow
    let sandboxDetail = sandboxRow ? '' : 'sandbox row missing'
    if (sandboxRow && window.xcode.platform === 'darwin') {
      const readSandboxEnabled = async (): Promise<boolean> => {
        const response = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'settings:get',
          params: {},
        })
        return response.ok ? (response.result as SettingsSnapshot).shellSandbox.enabled : false
      }
      const waitForSandbox = async (expected: boolean): Promise<boolean> => {
        for (let attempt = 0; attempt < 40; attempt++) {
          if ((await readSandboxEnabled()) === expected) return true
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return false
      }
      // 上一次保存进行中时按钮被禁用；等它变得可点击后再切换。
      const toggleSandbox = async (): Promise<void> => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const button = document
            .querySelector('[data-testid="shell-sandbox"]')
            ?.querySelector<HTMLButtonElement>('.settings-toggle')
          if (button && !button.disabled) {
            button.click()
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      const sandboxBefore = await readSandboxEnabled()
      await toggleSandbox()
      const sandboxDisabled = await waitForSandbox(!sandboxBefore)
      await toggleSandbox()
      const sandboxRestored = await waitForSandbox(sandboxBefore)
      sandboxOk = sandboxDisabled && sandboxRestored
      sandboxDetail = `before=${sandboxBefore} disabled=${sandboxDisabled} restored=${sandboxRestored}`
    } else if (sandboxRow) {
      sandboxDetail = 'unsupported platform row shown'
    }
    checks.shellSandbox = { ok: sandboxOk, detail: sandboxDetail }

    const searchSection = await waitFor(
      () => document.querySelector('[data-testid="search-providers"]') !== null,
      2_000,
    )
    const tavilyRow = document.querySelector('[data-testid="search-provider-tavily"]')
    const tavilyInput = tavilyRow?.querySelector<HTMLInputElement>('input[type="password"]')
    const preferredSelect = document.querySelector<HTMLSelectElement>('[data-testid="search-preferred"] select')
    const tavilyStatus = snapshot?.searchProviders.find((provider) => provider.id === 'tavily')
    const searchTestButton = tavilyRow
      ? Array.from(tavilyRow.querySelectorAll('button')).find((button) => button.textContent?.includes('测试'))
      : undefined
    let searchSettingsOk = Boolean(searchSection && tavilyRow && tavilyInput && preferredSelect && searchTestButton)
    let searchSettingsDetail = searchSettingsOk
      ? 'search providers, preferred picker and test button rendered'
      : 'search settings controls missing'
    if (searchSettingsOk && tavilyStatus && tavilyStatus.source === 'none') {
      const saveSearch = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-search-key',
        params: { provider: 'tavily', key: 'tvly-smoke-1234' },
      })
      const savedView = saveSearch.ok
        ? (saveSearch.result as SettingsActionResult).settings.searchProviders.find(
            (provider) => provider.id === 'tavily',
          )
        : undefined
      const prefer = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-search-provider',
        params: { provider: 'tavily' },
      })
      const preferredId = prefer.ok ? (prefer.result as SettingsActionResult).settings.searchProvider : undefined
      const clearSearch = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:clear-search-key',
        params: { provider: 'tavily' },
      })
      const cleared = clearSearch.ok ? (clearSearch.result as SettingsActionResult).settings : undefined
      const clearedView = cleared?.searchProviders.find((provider) => provider.id === 'tavily')
      searchSettingsOk =
        savedView?.source === 'stored' &&
        savedView.hint === '••••1234' &&
        preferredId === 'tavily' &&
        cleared?.searchProvider === '' &&
        clearedView?.source === 'none'
      searchSettingsDetail = `saved=${savedView?.source ?? 'failed'} preferred=${preferredId ?? 'failed'} cleared=${clearedView?.source ?? 'failed'}`
    }
    checks.searchProviders = { ok: searchSettingsOk, detail: searchSettingsDetail }

    const settingsBeforeExt = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:get',
      params: {},
    })
    const extBefore = settingsBeforeExt.ok
      ? (settingsBeforeExt.result as SettingsSnapshot).shellSandbox.extensions
      : false
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-shell-sandbox',
      params: { extensions: !extBefore },
    })
    const settingsExtOn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:get',
      params: {},
    })
    const extToggled = settingsExtOn.ok
      ? (settingsExtOn.result as SettingsSnapshot).shellSandbox.extensions === !extBefore
      : false
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:set-shell-sandbox',
      params: { extensions: extBefore },
    })
    checks.sandboxExtensions = {
      ok: extToggled,
      detail: `before=${extBefore} toggled=${extToggled}`,
    }
    document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)

    const writeAlways = snapshot?.tools.find((tool) => tool.name === 'writeFile')?.alwaysAllow ?? false
    if (!writeAlways) {
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-always-allow',
        params: { name: 'writeFile', enabled: true },
      })
    }
    let autoApproval = false
    let autoDiff = false
    const offAutoAllow = window.xcode.onEvent((event) => {
      if (event.type === 'approval:request' && event.kind === 'permission') autoApproval = true
      if (event.type === 'agent:file-edit') autoDiff = true
    })
    const autoTurn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[tool-demo]' },
    })
    offAutoAllow()
    checks.alwaysAllowEffect = {
      ok: autoTurn.ok && !autoApproval && autoDiff,
      detail: `approval=${autoApproval} diff=${autoDiff}`,
    }

    const composerTextarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    if (composerTextarea) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(composerTextarea, '/')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
      const paletteMounted = await waitFor(() => document.querySelector('.slash-palette') !== null, 2000)
      const slashCommandCount = document.querySelectorAll('[data-testid="slash-palette"] .slash-item').length
      checks.slashPalette = {
        ok: paletteMounted && slashCommandCount > 8,
        detail: paletteMounted ? `${slashCommandCount} command(s) listed` : 'command palette missing',
      }

      setter?.call(composerTextarea, '/usage')
      composerTextarea.dispatchEvent(new Event('input', { bubbles: true }))
      const usageSelected = await waitFor(
        () => [...document.querySelectorAll('.slash-name')].some((el) => el.textContent === '/usage'),
        2000,
      )
      if (usageSelected) {
        composerTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      const usageReport = await waitFor(
        () => (document.querySelector('.report')?.textContent ?? '').includes('用量'),
        3000,
      )
      checks.slashCommand = {
        ok: usageSelected && usageReport,
        detail: `selected=${usageSelected} report=${usageReport}`,
      }
      const reportCloseMounted = document.querySelector('[data-testid="report-close"]') !== null
      document.querySelector<HTMLButtonElement>('[data-testid="report-close"]')?.click()
      const reportClosed = await waitFor(() => document.querySelector('.report') === null, 2000)
      checks.reportClose = {
        ok: reportCloseMounted && reportClosed,
        detail: `button=${reportCloseMounted} closed=${reportClosed}`,
      }
    } else {
      checks.slashPalette = { ok: false, detail: 'composer missing' }
      checks.slashCommand = { ok: false, detail: 'composer missing' }
    }

    const reportMethods = [
      'context:stats',
      'doctor:run',
      'agents:list',
      'goal:get',
      'shell:list',
      'usage:history',
      'memory:get',
    ]
    const reportDetails: string[] = []
    let reportsOk = true
    for (const method of reportMethods) {
      const response = await window.xcode.request({
        id: crypto.randomUUID(),
        method,
        params: {},
      } as unknown as RuntimeRequest)
      const text = response.ok ? (response.result as TextReport).text : ''
      if (!response.ok || text.length === 0) reportsOk = false
      reportDetails.push(`${method}=${response.ok ? text.length : 'fail'}`)
    }
    checks.commandReports = { ok: reportsOk, detail: reportDetails.join(' ') }

    const stateBefore = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:state',
      params: {},
    })
    const beforeThinking = stateBefore.ok ? (stateBefore.result as AppState).thinking : false
    const beforeMode = stateBefore.ok ? (stateBefore.result as AppState).permissionMode : 'default'
    const thinkingOn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-thinking',
      params: { enabled: !beforeThinking },
    })
    const thinkingRestored = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-thinking',
      params: { enabled: beforeThinking },
    })
    const planOn = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-permission-mode',
      params: { mode: 'plan' },
    })
    const planRestored = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:set-permission-mode',
      params: { mode: beforeMode === 'plan' ? 'plan' : 'default' },
    })
    checks.modeToggles = {
      ok: thinkingOn.ok && thinkingRestored.ok && planOn.ok && planRestored.ok,
      detail: `thinking=${beforeThinking} mode=${beforeMode}`,
    }

    const sidebarMounted = Boolean(
      document.querySelector('[data-testid="sidebar"]') && document.querySelectorAll('.sidebar-project').length > 0,
    )
    checks.sidebar = {
      ok: sidebarMounted,
      detail: sidebarMounted ? 'sidebar mounted with projects' : 'sidebar missing',
    }
    const usageChecklist = document.querySelector('[data-testid="usage-checklist"]') !== null
    const usageItems = document.querySelectorAll('[data-testid^="usage-item-"]').length
    checks.usageChecklist = {
      ok: usageChecklist && usageItems === 5,
      detail: `card=${usageChecklist} items=${usageItems}`,
    }
    const sidebarToggle = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]')
    sidebarToggle?.click()
    const sidebarClosed = await waitFor(() => document.querySelector('[data-testid="sidebar"]') === null, 2000)
    sidebarToggle?.click()
    const sidebarReopened = await waitFor(() => document.querySelector('[data-testid="sidebar"]') !== null, 2000)
    checks.sidebarToggle = {
      ok: sidebarClosed && sidebarReopened,
      detail: `closed=${sidebarClosed} reopened=${sidebarReopened}`,
    }

    const searchInput = document.querySelector('.sidebar-search input') as HTMLInputElement | null
    let searchFiltered = false
    if (searchInput) {
      const setSearch = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setSearch?.call(searchInput, 'zzzz-no-match')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchFiltered = await waitFor(() => document.querySelectorAll('.sidebar-session-row').length === 0, 2_000)
      setSearch?.call(searchInput, '')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      await waitFor(() => document.querySelectorAll('.sidebar-session-row').length > 0, 2_000)
    }

    let renamed = false
    let deleted = false
    const firstRow = document.querySelector('.sidebar-session-row') as HTMLElement | null
    const renameButton = firstRow?.querySelector<HTMLButtonElement>('[data-testid="session-menu-toggle"]')
    renameButton?.click()
    await waitFor(() => document.querySelector('[data-testid="session-menu"]') !== null, 2_000)
    document.querySelector<HTMLButtonElement>('[data-testid="session-menu-rename"]')?.click()
    await waitFor(() => document.querySelector('.sidebar-rename') !== null, 2_000)
    const renameInput = document.querySelector('.sidebar-rename') as HTMLInputElement | null
    if (renameInput) {
      const setRename = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setRename?.call(renameInput, 'smoke-renamed')
      renameInput.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      renamed = await waitFor(() => document.body.textContent?.includes('smoke-renamed') ?? false, 2_000)
    }
    const renamedRow = Array.from(document.querySelectorAll('.sidebar-session-row')).find((row) =>
      row.textContent?.includes('smoke-renamed'),
    )
    if (renamedRow) {
      renamedRow.querySelector<HTMLButtonElement>('[data-testid="session-menu-toggle"]')?.click()
      await waitFor(() => document.querySelector('[data-testid="session-menu"]') !== null, 2_000)
      document.querySelector<HTMLButtonElement>('[data-testid="session-menu-delete"]')?.click()
      await waitFor(() => document.querySelector('.session-action.danger') !== null, 1_500)
      document.querySelector<HTMLButtonElement>('.session-action.danger')?.click()
      deleted = await waitFor(() => !(document.body.textContent ?? '').includes('smoke-renamed'), 2_000)
    }
    checks.sessionManagement = {
      ok: searchFiltered && renamed && deleted,
      detail: `search=${searchFiltered} row=${Boolean(firstRow)} menu=${Boolean(renameButton)} input=${Boolean(renameInput)} rename=${renamed} delete=${deleted}`,
    }
    document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
    const placeholderReady = await waitFor(() => document.querySelector('.sidebar-session-placeholder') !== null, 2_000)
    checks.newSessionPlaceholder = {
      ok: placeholderReady,
      detail: placeholderReady ? '新会话 placeholder shown' : 'placeholder missing',
    }

    document.querySelector<HTMLButtonElement>('[data-testid="task-mode-chip"]')?.click()
    const modeMenu = await waitFor(() => document.querySelector('[data-testid="task-mode-menu"]') !== null, 2_000)
    Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-item'))
      .find((button) => button.querySelector('.mode-item-label')?.textContent?.trim() === '写作')
      ?.click()
    const writingHint = await waitFor(
      () => (document.querySelector('[data-testid="starter-hint"]')?.textContent ?? '').trim().length > 0,
      3_000,
    )
    const suggestionChips = document.querySelectorAll('.mode-suggestion').length > 0
    const workspaceStarters = await waitFor(() => {
      const text = document.querySelector('[data-testid="workspace-starters"]')?.textContent ?? ''
      return text.includes('项目检查') || text.includes('README') || text.includes('未提交')
    }, 3_000)
    checks.workspaceStarters = {
      ok: workspaceStarters,
      detail: `hint=${writingHint} suggestions=${suggestionChips}`,
    }
    const modeState = await window.xcode.request({ id: crypto.randomUUID(), method: 'app:state', params: {} })
    const modePersisted = modeState.ok && (modeState.result as AppState).taskMode === 'writing'
    document.querySelector<HTMLButtonElement>('[data-testid="task-mode-chip"]')?.click()
    await waitFor(() => document.querySelector('[data-testid="task-mode-menu"]') !== null, 2_000)
    Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-item'))
      .find((button) => button.querySelector('.mode-item-label')?.textContent?.trim() === '编程')
      ?.click()
    const backToCoding = await waitFor(
      () => (document.querySelector('[data-testid="task-mode-chip"]')?.textContent ?? '').includes('编程'),
      3_000,
    )
    checks.taskMode = {
      ok: modeMenu && writingHint && suggestionChips && modePersisted && backToCoding,
      detail: `menu=${modeMenu} hint=${writingHint} suggestions=${suggestionChips} persisted=${modePersisted} back=${backToCoding}`,
    }

    await openDocument(`${workspace}/README.md`)
    const markdownPreview = await waitFor(
      () => document.querySelector('[data-testid="document-drawer"] .markdown') !== null,
      3_000,
    )
    await openDocument(`${workspace}/data.csv`)
    const csvPreview = await waitFor(
      () => document.querySelectorAll('[data-testid="document-drawer"] .document-table tr').length >= 2,
      3_000,
    )
    await openDocument(`${workspace}/sample.pdf`)
    const pdfPageText = await waitFor(
      () =>
        (document.querySelector('[data-testid="document-drawer"] .document-page-text')?.textContent ?? '').includes(
          'Page 1',
        ),
      5_000,
    )
    checks.documentPanel = {
      ok: markdownPreview && csvPreview && pdfPageText,
      detail: `markdown=${markdownPreview} csv=${csvPreview} pdfPageText=${pdfPageText}`,
    }
    closeInspector()

    let reviewApproved = false
    const offReview = window.xcode.onEvent((event) => {
      if (event.type === 'approval:request' && event.kind === 'permission') {
        reviewApproved = true
        void window.xcode.request({
          id: crypto.randomUUID(),
          method: 'approval:respond',
          params: { requestId: event.requestId, kind: 'permission', decision: 'yes' },
        })
      }
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: '[review-demo]' },
    })
    offReview()
    await openDocument(`${workspace}/README.md`)
    const reviewBar = await waitFor(() => document.querySelector('.document-review-bar') !== null, 4_000)
    const reviewButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.document-review-bar .settings-btn'),
    ).find((button) => button.textContent?.includes('查看改动'))
    reviewButton?.click()
    const hunksReady = await waitFor(() => document.querySelectorAll('.document-hunk').length > 0, 4_000)
    const applyButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.document-diff-head .settings-btn'),
    ).find((button) => button.textContent?.includes('应用所选'))
    applyButton?.click()
    const reviewCleared = await waitFor(
      () =>
        document.querySelector('.document-review-bar') === null && document.querySelector('.document-diff') === null,
      5_000,
    )
    checks.documentReview = {
      ok: reviewApproved && reviewBar && hunksReady && reviewCleared,
      detail: `approved=${reviewApproved} bar=${reviewBar} hunks=${hunksReady} applied=${reviewCleared}`,
    }
    closeInspector()

    let rememberedDocument = ''
    try {
      const map = JSON.parse(localStorage.getItem('xcode.lastDocuments') ?? '{}') as Record<string, string>
      rememberedDocument = map[workspace] ?? ''
    } catch {
      rememberedDocument = ''
    }
    await openDocument(`${workspace}/missing-document.pdf`)
    const missingReported = await waitFor(
      () => document.querySelector('[data-testid="document-drawer"] .settings-warn') !== null,
      2_000,
    )
    document.querySelector<HTMLButtonElement>('[data-testid="document-drawer"] .drawer-head .btn:last-child')?.click()
    await waitFor(() => document.querySelector('[data-testid="document-drawer"]') === null, 2_000)
    localStorage.removeItem('xcode.lastDocuments')
    const reopenMenu = await openToolsMenu()
    document.querySelector<HTMLButtonElement>('[data-testid="document-toggle"]')?.click()
    const reopenDrawer = await waitFor(() => document.querySelector('[data-testid="document-drawer"]') !== null, 3_000)
    const recentSwitcher = await waitFor(
      () => document.querySelector('[data-testid="document-drawer"] .document-switcher') !== null,
      2_000,
    )
    document.querySelector<HTMLButtonElement>('[data-testid="document-drawer"] .drawer-head .btn:last-child')?.click()
    await waitFor(() => document.querySelector('[data-testid="document-drawer"]') === null, 2_000)
    checks.documentRemember = {
      ok: rememberedDocument.endsWith('README.md') && missingReported,
      detail: `remembered=${rememberedDocument} missingReported=${missingReported}`,
    }
    checks.documentReopen = {
      ok: reopenMenu && reopenDrawer && recentSwitcher,
      detail: `menu=${reopenMenu} drawer=${reopenDrawer} recents=${recentSwitcher}`,
    }

    const gitMenu = await openToolsMenu()
    document.querySelector<HTMLButtonElement>('[data-testid="git-toggle"]')?.click()
    const gitDrawer = await waitFor(() => document.querySelector('[data-testid="git-drawer"]') !== null, 3_000)
    const gitChanges = await waitFor(
      () => document.querySelectorAll('[data-testid="git-drawer"] .git-file').length > 0,
      4_000,
    )
    const readmeGitFile = Array.from(document.querySelectorAll<HTMLButtonElement>('.git-file')).find((button) =>
      button.textContent?.includes('README.md'),
    )
    readmeGitFile?.click()
    const gitDiffReady = await waitFor(
      () => (document.querySelector('.git-diff-body')?.textContent ?? '').includes('Reviewed change'),
      4_000,
    )
    const undoButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.git-drawer .drawer-head .btn')).find(
      (button) => button.textContent?.includes('撤销本轮'),
    )
    undoButton?.click()
    // 撤销会恢复该轮次的修改；预先存在的未跟踪路径（如工作区的
    // `.x-code` 目录）按设计保留。
    const gitUndone = await waitFor(
      () =>
        !Array.from(document.querySelectorAll('[data-testid="git-drawer"] .git-file')).some((button) =>
          button.textContent?.includes('README.md'),
        ),
      6_000,
    )
    const gitWarning = document.querySelector('[data-testid="git-drawer"] .settings-warn')?.textContent ?? ''
    const gitSummary = document.querySelector('[data-testid="git-drawer"] .git-summary')?.textContent ?? ''
    checks.git = {
      ok: gitMenu && gitDrawer && gitChanges && gitDiffReady && gitUndone,
      detail: `menu=${gitMenu} drawer=${gitDrawer} changes=${gitChanges} diff=${gitDiffReady} undone=${gitUndone} files=${
        document.querySelectorAll('[data-testid="git-drawer"] .git-file').length
      } summary=${gitSummary.slice(0, 60)} warning=${gitWarning.slice(0, 80)}`,
    }
    document.querySelector<HTMLButtonElement>('[data-testid="git-drawer"] .drawer-head .btn:last-child')?.click()

    const checksMenu = await openToolsMenu()
    document.querySelector<HTMLButtonElement>('[data-testid="checks-toggle"]')?.click()
    const checksDrawer = await waitFor(() => document.querySelector('[data-testid="checks-drawer"]') !== null, 3_000)
    const checksDetected = await waitFor(
      () => document.querySelectorAll('[data-testid="checks-drawer"] .check-item').length >= 2,
      5_000,
    )
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="checks-drawer"] .drawer-head .btn'))
      .find((button) => button.textContent?.includes('运行全部'))
      ?.click()
    const checksRan = await waitFor(
      () => document.querySelector('[data-testid="checks-drawer"] .check-status.failed') !== null,
      30_000,
    )
    const checksFixAction = document.querySelector('[data-testid="checks-drawer"] .checks-actions') !== null
    checks.checkPanel = {
      ok: checksMenu && checksDrawer && checksDetected && checksRan && checksFixAction,
      detail: `menu=${checksMenu} drawer=${checksDrawer} detected=${checksDetected} failed=${checksRan} fix=${checksFixAction}`,
    }
    document.querySelector<HTMLButtonElement>('[data-testid="checks-drawer"] .drawer-head .btn:last-child')?.click()

    const pluginPath = `${workspace}/.smoke-plugin`
    const pluginPreviewResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'plugins:preview',
      params: { target: { kind: 'path', path: pluginPath } },
    })
    const pluginPreviewOk =
      pluginPreviewResponse.ok &&
      ((pluginPreviewResponse.result as { userConfig?: unknown[] }).userConfig?.length ?? 0) === 2
    const pluginInstallResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'plugins:install',
      params: {
        target: { kind: 'path', path: pluginPath },
        userConfig: { SMOKE_TOKEN: 's3cret', SMOKE_REGION: 'us' },
      },
    })
    const pluginConfigResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'plugins:user-config',
      params: { id: 'smoke-plugin@local' },
    })
    const pluginConfig = pluginConfigResponse.ok
      ? (pluginConfigResponse.result as {
          fields: unknown[]
          values: Record<string, unknown>
          setKeys: string[]
        })
      : null
    const pluginConfigOk =
      Boolean(pluginConfig) &&
      pluginConfig!.setKeys.includes('SMOKE_TOKEN') &&
      pluginConfig!.setKeys.includes('SMOKE_REGION') &&
      pluginConfig!.values.SMOKE_REGION === 'us' &&
      pluginConfig!.values.SMOKE_TOKEN === undefined
    const pluginSaveResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'plugins:save-user-config',
      params: { id: 'smoke-plugin@local', values: { SMOKE_REGION: 'cn' } },
    })
    const pluginAfterResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'plugins:user-config',
      params: { id: 'smoke-plugin@local' },
    })
    const pluginUpdatedOk =
      pluginSaveResponse.ok &&
      (pluginAfterResponse.ok
        ? (pluginAfterResponse.result as { values: Record<string, unknown> }).values.SMOKE_REGION === 'cn'
        : false)
    const pluginSettingsResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'settings:get',
      params: {},
    })
    const pluginListed =
      pluginSettingsResponse.ok &&
      (pluginSettingsResponse.result as SettingsSnapshot).plugins.some(
        (plugin) => plugin.id === 'smoke-plugin@local' && (plugin.userConfig?.length ?? 0) === 2,
      )
    checks.pluginConfig = {
      ok: pluginPreviewOk && pluginInstallResponse.ok && pluginConfigOk && pluginUpdatedOk && pluginListed,
      detail: `preview=${pluginPreviewOk} install=${pluginInstallResponse.ok} config=${pluginConfigOk} updated=${pluginUpdatedOk} listed=${pluginListed}`,
    }
    checks.attachButton = {
      ok: Boolean(document.querySelector('.composer .attach')),
      detail: document.querySelector('.composer .attach') ? 'document picker mounted' : 'document picker missing',
    }
    const attachButtonElement = document.querySelector<HTMLButtonElement>('.composer .btn.attach')
    const attachIcon = attachButtonElement?.querySelector('svg')
    let attachCentered = false
    let attachCenterDetail = 'button or icon missing'
    if (attachButtonElement && attachIcon) {
      const buttonRect = attachButtonElement.getBoundingClientRect()
      const iconRect = attachIcon.getBoundingClientRect()
      const dx = iconRect.left + iconRect.width / 2 - (buttonRect.left + buttonRect.width / 2)
      const dy = iconRect.top + iconRect.height / 2 - (buttonRect.top + buttonRect.height / 2)
      attachCentered = Math.abs(dx) < 1 && Math.abs(dy) < 1
      attachCenterDetail = `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`
    }
    checks.attachCentered = { ok: attachCentered, detail: attachCenterDetail }
    const documentButton = document.querySelector('[data-testid="document-button"]') !== null
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, shiftKey: true, bubbles: true }))
    const documentOpened = await waitFor(() => document.querySelector('[data-testid="document-drawer"]') !== null, 3000)
    document.querySelector<HTMLButtonElement>('[data-testid="document-drawer"] .drawer-head .btn:last-child')?.click()
    const documentClosed = await waitFor(() => document.querySelector('[data-testid="document-drawer"]') === null, 2000)
    checks.documentQuickAccess = {
      ok: documentButton && documentOpened && documentClosed,
      detail: `button=${documentButton} shortcut=${documentOpened} closed=${documentClosed}`,
    }
    document.querySelector<HTMLButtonElement>('[data-testid="document-button"]')?.click()
    const inspectorMounted = await waitFor(() => document.querySelector('[data-testid="inspector"]') !== null, 3000)
    const documentTabActive = document.querySelector('[data-testid="inspector-tab-document"].active') !== null
    const documentTabButton = document.querySelector<HTMLButtonElement>('[data-testid="inspector-tab-document"]')
    documentTabButton?.focus()
    documentTabButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const gitInsideInspector = await waitFor(
      () => document.querySelector('[data-testid="inspector"] [data-testid="git-drawer"]') !== null,
      4000,
    )
    const documentTabGone = document.querySelector('[data-testid="inspector"] [data-testid="document-drawer"]') === null
    const terminalTabPresent = document.querySelector('[data-testid="inspector-tab-terminal"]') !== null
    const inspectorResizer = document.querySelector('.inspector-resizer') !== null
    document.querySelector<HTMLButtonElement>('[data-testid="inspector-close"]')?.click()
    const inspectorClosed = await waitFor(() => document.querySelector('[data-testid="inspector"]') === null, 2000)
    checks.inspector = {
      ok:
        inspectorMounted &&
        documentTabActive &&
        gitInsideInspector &&
        documentTabGone &&
        terminalTabPresent &&
        inspectorResizer &&
        inspectorClosed,
      detail: `mounted=${inspectorMounted} docTab=${documentTabActive} git=${gitInsideInspector} exclusive=${documentTabGone} terminalTab=${terminalTabPresent} resizer=${inspectorResizer} closed=${inspectorClosed}`,
    }
    document.querySelector<HTMLButtonElement>('[data-testid="outline-toggle"]')?.click()
    const outlineMounted = await waitFor(() => document.querySelector('[data-testid="outline-panel"]') !== null, 3_000)
    const outlineItems = document.querySelectorAll('[data-testid="outline-item"]').length
    document.querySelector<HTMLButtonElement>('[data-testid="outline-item"]')?.click()
    document.querySelector<HTMLButtonElement>('[data-testid="inspector-close"]')?.click()
    const outlineClosed = await waitFor(() => document.querySelector('[data-testid="inspector"]') === null, 2_000)
    document.querySelector<HTMLButtonElement>('.scroll-bottom')?.click()
    checks.outline = {
      ok: outlineMounted && outlineItems > 0 && outlineClosed,
      detail: `mounted=${outlineMounted} items=${outlineItems} closed=${outlineClosed}`,
    }
    if (!writeAlways) {
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'settings:set-tool-always-allow',
        params: { name: 'writeFile', enabled: false },
      })
    }

    let output = ''
    const offShell = window.xcode.onEvent((event) => {
      if (event.type === 'shell:output') output += event.data
    })
    const created = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'shell:create',
      params: { cols: 80, rows: 24 },
    })
    let shellOk = false
    let shellDetail = ''
    if (!created.ok) {
      shellDetail = created.error.message
    } else {
      const id = (created.result as { id: string }).id
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'shell:write',
        params: { id, data: 'echo ui-shell-ok\r' },
      })
      shellOk = await waitFor(() => output.includes('ui-shell-ok'), 8000)
      shellDetail = shellOk ? 'pty echoed marker' : `marker missing; output=${JSON.stringify(output.slice(0, 160))}`
      await window.xcode.request({ id: crypto.randomUUID(), method: 'shell:kill', params: { id } })
    }
    offShell()
    checks.shell = { ok: shellOk, detail: shellDetail }

    let diagnostics = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'smoke:run',
      params: {},
    })
    if (!diagnostics.ok) {
      // 嵌套的运行时 smoke 可能丢失第一个进程；重试一次，
      // 以免 UI smoke 因这种瞬时问题失败。
      await new Promise((resolve) => setTimeout(resolve, 500))
      diagnostics = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'smoke:run',
        params: {},
      })
    }
    checks.diagnostics = {
      ok: diagnostics.ok && (diagnostics.result as SmokeReport).ok === true,
      detail: diagnostics.ok ? 'diagnostics completed without exiting' : diagnostics.error.message,
    }
    const exported = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'diagnostics:export',
      params: {},
    })
    const exportResult = exported.ok ? (exported.result as DiagnosticsExportResult) : null
    checks.diagnosticsExport = {
      ok: Boolean(
        exportResult &&
        exportResult.bytes > 100 &&
        exportResult.path.includes('diagnostics') &&
        exportResult.path.includes('x-code-diagnostics-'),
      ),
      detail: exported.ok ? `${exportResult?.bytes ?? 0} bytes · ${exportResult?.path ?? ''}` : exported.error.message,
    }
    const rendererError = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'renderer:error',
      params: { message: 'ui smoke renderer error', stack: 'smoke' },
    })
    checks.rendererError = {
      ok: rendererError.ok,
      detail: rendererError.ok ? 'renderer error accepted' : rendererError.error.message,
    }

    checks.terminalDefault = {
      ok: document.querySelector('[data-testid="terminal-shell"]') === null,
      detail: 'terminal closed by default',
    }
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="terminal-toggle"]')
    toggle?.click()
    const mounted = await waitFor(() => document.querySelector('[data-testid="terminal-shell"]') !== null, 3000)
    checks.terminalToggle = {
      ok: mounted,
      detail: mounted ? 'terminal mounted on demand' : 'terminal did not mount',
    }
    toggle?.click()
    await waitFor(() => document.querySelector('[data-testid="terminal-shell"]') === null, 2000)

    checks.renderer = {
      ok: Boolean(document.getElementById('root')?.childElementCount),
      detail: `title=${document.title} platform=${window.xcode.platform}`,
    }

    const themeMenu = await openToolsMenu()
    const themes: string[] = []
    for (let index = 0; index < 3; index++) {
      document.querySelector<HTMLButtonElement>('[data-testid="theme-toggle"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 30))
      themes.push(document.documentElement.dataset.theme ?? '')
    }
    const themeOk = new Set(themes).size >= 2
    document.querySelector<HTMLButtonElement>('[data-testid="language-toggle"]')?.click()
    const switchedToEnglish = await waitFor(
      () => (document.querySelector('.sidebar-title')?.textContent ?? '') === 'Projects',
      2_000,
    )
    document.querySelector<HTMLButtonElement>('[data-testid="language-toggle"]')?.click()
    const switchedBack = await waitFor(
      () => (document.querySelector('.sidebar-title')?.textContent ?? '') === '项目',
      2_000,
    )
    document.querySelector<HTMLButtonElement>('[data-testid="tools-menu-toggle"]')?.click()
    checks.themeLanguage = {
      ok: themeMenu && themeOk && switchedToEnglish && switchedBack,
      detail: `menu=${themeMenu} themes=${themes.join('>')} en=${switchedToEnglish} zh=${switchedBack}`,
    }

    document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
    await waitFor(() => document.querySelector('.sidebar-session-placeholder') !== null, 2_000)

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const pasted = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:save-pasted-image',
      params: {
        data: pngBase64,
        mime: 'image/png',
      },
    })
    const pastedPath = pasted.ok ? (pasted.result as { path: string }).path : ''
    checks.pasteImage = {
      ok: pasted.ok && pastedPath.endsWith('.png'),
      detail: pasted.ok ? pastedPath : pasted.error.message,
    }
    const imagePreview = pastedPath
      ? await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:image-preview',
          params: { path: pastedPath },
        })
      : null
    checks.imagePreview = {
      ok:
        imagePreview?.ok === true &&
        (imagePreview.result as { dataUrl: string }).dataUrl.startsWith('data:image/png;base64,'),
      detail:
        imagePreview === null ? 'no pasted image' : imagePreview.ok ? 'data:image/png' : imagePreview.error.message,
    }
    const pasteComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    if (pasteComposer) {
      const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'smoke-paste.png', { type: 'image/png' }))
      pasteComposer.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
      const thumbReady = await waitFor(
        () => document.querySelector('.attachment-chip .attachment-thumb') !== null,
        4_000,
      )
      document.querySelector<HTMLButtonElement>('.attachment-chip .attachment-thumb-button')?.click()
      const lightbox = await waitFor(() => document.querySelector('[data-testid="image-lightbox"] img') !== null, 2_000)
      document.querySelector<HTMLButtonElement>('.image-lightbox-card .btn-quiet')?.click()
      const lightboxClosed = await waitFor(
        () => document.querySelector('[data-testid="image-lightbox"]') === null,
        2_000,
      )
      const userCountBeforeImage = document.querySelectorAll('.message.user').length
      const pasteValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      pasteValue?.call(pasteComposer, 'image attachment smoke')
      pasteComposer.dispatchEvent(new Event('input', { bubbles: true }))
      pasteComposer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const imageUserSent = await waitFor(
        () => document.querySelectorAll('.message.user').length > userCountBeforeImage,
        4_000,
      )
      const messageImage = await waitFor(
        () =>
          document
            .querySelector<HTMLImageElement>('.message.user .message-attachments img')
            ?.src.startsWith('data:image/png') ?? false,
        4_000,
      )
      await waitFor(() => document.querySelector('.send.stop') === null, 15_000)
      checks.imageAttachmentUi = {
        ok: thumbReady && lightbox && lightboxClosed,
        detail: `thumb=${thumbReady} lightbox=${lightbox}/${lightboxClosed}`,
      }
      checks.imageMessage = {
        ok: imageUserSent && messageImage,
        detail: `sent=${imageUserSent} image=${messageImage}`,
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      const activeImageId = document.querySelector('.tab-item.active')?.getAttribute('data-session-id') ?? ''
      const imageSessionList = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:list',
        params: {},
      })
      const imageItems = imageSessionList.ok ? (imageSessionList.result as SessionListItem[]) : []
      const imageItem = imageItems.find((item) => item.sessionId === activeImageId)
      let restoredImage = false
      let cleanRestoredText = false
      let restoreDetail = imageItem ? 'session missing' : 'active session missing'
      if (imageItem) {
        const loaded = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:load',
          params: { filePath: imageItem.filePath },
        })
        if (loaded.ok) {
          const view = loaded.result as LoadedSessionView
          const restoredUser = view.messages.find(
            (message) => message.role === 'user' && (message.attachmentViews?.length ?? 0) > 0,
          )
          restoredImage =
            restoredUser?.attachmentViews?.some(
              (attachment) =>
                attachment.dataUrl?.startsWith('data:image/') === true ||
                (attachment.path ? isImageAttachment(attachment.path) : false),
            ) ?? false
          cleanRestoredText =
            Boolean(restoredUser) &&
            !(restoredUser?.text.includes('@"/') ?? false) &&
            !(restoredUser?.text.includes('[Image ') ?? false)
          restoreDetail = `views=${restoredUser?.attachmentViews?.length ?? 0} image=${restoredImage} clean=${cleanRestoredText}`
        } else {
          restoreDetail = loaded.error.message
        }
      }
      checks.imageSessionRestore = {
        ok: restoredImage && cleanRestoredText,
        detail: restoreDetail,
      }
    } else {
      checks.imageAttachmentUi = { ok: false, detail: 'composer missing' }
      checks.imageMessage = { ok: false, detail: 'composer missing' }
      checks.imageSessionRestore = { ok: false, detail: 'composer missing' }
    }

    const background = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'background:list',
      params: {},
    })
    checks.backgroundList = {
      ok:
        background.ok &&
        Array.isArray((background.result as { sessions: unknown[] }).sessions) &&
        Array.isArray((background.result as { tasks?: unknown[] }).tasks),
      detail: background.ok
        ? `${(background.result as { sessions: unknown[] }).sessions.length} background session(s), ${
            (background.result as { tasks?: unknown[] }).tasks?.length ?? 0
          } task(s)`
        : background.error.message,
    }

    // 一个全新的轮次能保证活动会话有回退检查点。
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'agent:submit',
      params: { prompt: 'rewind smoke' },
    })
    const checkpointResponse = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:checkpoints',
      params: {},
    })
    const checkpoints = checkpointResponse.ok
      ? (checkpointResponse.result as { checkpoints: Array<{ ckptId: string; messageCount: number }> }).checkpoints
      : []
    const latestCheckpoint = checkpoints[checkpoints.length - 1]
    let rewindOk = false
    let rewindDetail = 'no checkpoint recorded'
    if (latestCheckpoint) {
      const rewound = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:rewind',
        params: { ckptId: latestCheckpoint.ckptId, mode: 'both' },
      })
      const rewoundView = rewound.ok
        ? (rewound.result as { messageCount: number; view: { messages: unknown[] } })
        : null
      rewindOk = rewound.ok && rewoundView !== null && rewoundView.messageCount === latestCheckpoint.messageCount - 1
      rewindDetail = rewound.ok
        ? `checkpoint at ${latestCheckpoint.messageCount} → ${rewoundView?.messageCount}`
        : rewound.error.message
    }
    checks.rewind = { ok: rewindOk, detail: rewindDetail }

    const forked = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:fork',
      params: { name: 'smoke fork' },
    })
    const forkView = forked.ok ? (forked.result as { sessionId: string; view: { messages: unknown[] } }).view : null
    checks.fork = {
      ok: forked.ok && forkView !== null && forkView.messages.length > 0,
      detail: forked.ok
        ? `${(forked.result as { sessionId: string }).sessionId} (${forkView?.messages.length ?? 0} messages)`
        : forked.error.message,
    }

    const commandList = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:list',
      params: {},
    })
    const savedCommand = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:save',
      params: {
        name: 'smoke-command',
        description: 'Smoke command',
        body: 'echo $ARGUMENTS',
        scope: 'user',
      },
    })
    const ranCommand = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:run',
      params: { name: 'smoke-command', args: 'hello' },
    })
    const deletedCommand = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'commands:delete',
      params: { name: 'smoke-command', scope: 'user' },
    })
    checks.commands = {
      ok:
        commandList.ok &&
        savedCommand.ok &&
        ranCommand.ok &&
        deletedCommand.ok &&
        (ranCommand.result as { prompt: string }).prompt === 'echo hello',
      detail: ranCommand.ok
        ? `prompt=${JSON.stringify((ranCommand.result as { prompt: string }).prompt)}`
        : ranCommand.error.message,
    }

    const savedHooks = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:save',
      params: { scope: 'user', config: { TurnComplete: [{ command: 'true' }] } },
    })
    const hookView = savedHooks.ok ? (savedHooks.result as HooksView) : null
    const hookActive = hookView?.active.some((hook) => hook.event === 'TurnComplete' && hook.source === 'user')
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:save',
      params: { scope: 'user', config: {} },
    })
    const projectSaved = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:save',
      params: { scope: 'project', config: { TurnComplete: [{ command: 'true' }] } },
    })
    const projectSavedView = projectSaved.ok ? (projectSaved.result as HooksView) : null
    const projectInactiveBeforeTrust =
      projectSavedView?.projectHooksPresent === true &&
      projectSavedView.projectTrusted === false &&
      !projectSavedView.active.some((hook) => hook.source === 'project')
    const trustedProject = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:trust-project',
      params: { trusted: true },
    })
    const trustedProjectView = trustedProject.ok ? (trustedProject.result as HooksView) : null
    const projectActiveAfterTrust =
      trustedProjectView?.projectTrusted === true && trustedProjectView.active.some((hook) => hook.source === 'project')
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:trust-project',
      params: { trusted: false },
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'hooks:save',
      params: { scope: 'project', config: {} },
    })
    checks.projectHooksTrust = {
      ok: projectInactiveBeforeTrust && projectActiveAfterTrust,
      detail: `beforeTrust=${projectInactiveBeforeTrust} afterTrust=${projectActiveAfterTrust}`,
    }
    checks.hooks = {
      ok: savedHooks.ok && hookActive === true,
      detail: savedHooks.ok ? `active=${hookActive} hooks=${hookView?.active.length}` : savedHooks.error.message,
    }

    const memoryPanel = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'memory:panel',
      params: {},
    })
    checks.memory = {
      ok:
        memoryPanel.ok &&
        Array.isArray((memoryPanel.result as { topics: unknown[] }).topics) &&
        typeof (memoryPanel.result as { root: string }).root === 'string',
      detail: memoryPanel.ok
        ? `topics=${(memoryPanel.result as { topics: unknown[] }).topics.length}`
        : memoryPanel.error.message,
    }

    document.querySelector<HTMLButtonElement>('[data-testid="settings-toggle"]')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') !== null, 3_000)
    const clickTab = (label: string): void => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tab'))
        .find((tab) => tab.textContent?.trim() === label)
        ?.click()
    }
    clickTab('命令')
    const commandTab = await waitFor(() => document.querySelector('.command-list') !== null, 3_000)
    clickTab('Hooks')
    const hooksTab = await waitFor(
      () => document.querySelector('.hook-list') !== null || document.querySelector('.settings-warn') !== null,
      3_000,
    )
    clickTab('记忆')
    const memoryTab = await waitFor(() => document.querySelector('.memory-stats') !== null, 5_000)
    clickTab('项目')
    const projectTab = await waitFor(() => document.querySelector('[data-testid="project-workspace"]') !== null, 3_000)
    clickTab('存储')
    const storageTab = await waitFor(() => document.querySelector('.storage-list') !== null, 3_000)
    const backupUi =
      document.querySelector('[data-testid="backup-export"]') !== null &&
      document.querySelector('[data-testid="backup-import"]') !== null
    checks.backupUi = {
      ok: backupUi,
      detail: backupUi ? 'backup buttons mounted' : 'backup buttons missing',
    }
    document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)
    checks.iteration2Tabs = {
      ok: commandTab && hooksTab && memoryTab && projectTab && storageTab,
      detail: `commands=${commandTab} hooks=${hooksTab} memory=${memoryTab} project=${projectTab} storage=${storageTab}`,
    }

    const discoveredModels = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'models:discover',
      params: {},
    })
    const localModelCount = discoveredModels.ok
      ? (discoveredModels.result as AppState).models.filter(
          (model) => model.id.startsWith('ollama:') || model.id.startsWith('lmstudio:'),
        ).length
      : -1
    checks.localModels = {
      ok: discoveredModels.ok && localModelCount >= 0,
      detail: discoveredModels.ok ? `${localModelCount} local model(s)` : discoveredModels.error.message,
    }

    const updateCheck = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:check-update',
      params: { feed: '' },
    })
    const updateResult = updateCheck.ok ? (updateCheck.result as UpdateCheckResult) : null
    checks.updateCheck = {
      ok:
        updateCheck.ok &&
        updateResult?.configured === false &&
        Boolean(updateResult.currentVersion) &&
        (snapshot?.updateFeed ?? '').includes('qweijiaq/x-code'),
      detail: updateCheck.ok
        ? `current=${updateResult?.currentVersion} configured=${updateResult?.configured} defaultFeed=${snapshot?.updateFeed ? 'yes' : 'missing'}`
        : updateCheck.error.message,
    }

    const zoomUp = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:set-zoom',
      params: { factor: 1.2 },
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:set-zoom',
      params: { factor: 1 },
    })
    checks.zoom = {
      ok: zoomUp.ok && (zoomUp.result as { factor: number }).factor === 1.2,
      detail: zoomUp.ok ? `applied ${(zoomUp.result as { factor: number }).factor}` : zoomUp.error.message,
    }

    const silentWav = encodeWav([new Float32Array(8_000)], 16_000)
    const transcription = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'audio:transcribe',
      params: { data: base64FromBuffer(silentWav), mime: 'audio/wav', language: 'en' },
    })
    checks.transcription = {
      ok: transcription.ok && typeof (transcription.result as { text: string }).text === 'string',
      detail: transcription.ok
        ? `text=${JSON.stringify((transcription.result as { text: string }).text.slice(0, 40))}`
        : transcription.error.message,
    }

    const fileList = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:list',
      params: { path: '.' },
    })
    const readmeRead = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:read',
      params: { path: 'README.md' },
    })
    const createdFile = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:create',
      params: { path: 'smoke-editor.txt', content: 'line-one\n' },
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:write',
      params: { path: 'smoke-editor.txt', content: 'line-two\n' },
    })
    const rereadFile = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:read',
      params: { path: 'smoke-editor.txt' },
    })
    checks.filesApi = {
      ok:
        fileList.ok &&
        readmeRead.ok &&
        createdFile.ok &&
        rereadFile.ok &&
        (readmeRead.result as { content: string }).content.includes('Smoke workspace') &&
        (rereadFile.result as { content: string }).content === 'line-two\n',
      detail: `list=${fileList.ok} read=${readmeRead.ok} create=${createdFile.ok} write=${rereadFile.ok}`,
    }

    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:create',
      params: {
        path: 'smoke-preview.html',
        content: '<!doctype html><html><body><h1>Preview OK</h1></body></html>',
      },
    })
    await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:create',
      params: {
        path: 'smoke-highlight.ts',
        content: 'const answer: number = 42\n',
      },
    })
    const filesMenu = await openToolsMenu()
    document.querySelector<HTMLButtonElement>('[data-testid="files-toggle"]')?.click()
    const fileDrawer = await waitFor(() => document.querySelector('[data-testid="file-drawer"]') !== null, 3_000)
    const fileRows = await waitFor(
      () => (document.querySelectorAll('[data-testid="file-drawer"] .file-row').length ?? 0) > 2,
      3_000,
    )
    const editorRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
    ).find((row) => row.textContent?.includes('smoke-editor.txt'))
    editorRow?.click()
    const editorMounted = await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea') !== null,
      3_000,
    )
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea')
    let editorSaved = false
    if (editor) {
      const setEditorValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setEditorValue?.call(editor, 'line-three\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
        .find((button) => button.textContent?.trim() === '保存')
        ?.click()
      editorSaved = false
      const saveStarted = Date.now()
      while (Date.now() - saveStarted < 3_000 && !editorSaved) {
        const response = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:read',
          params: { path: 'smoke-editor.txt' },
        })
        editorSaved = response.ok && (response.result as { content: string }).content === 'line-three\n'
        if (!editorSaved) await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const previewRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
    ).find((row) => row.textContent?.includes('smoke-preview.html'))
    previewRow?.click()
    await waitFor(
      () => document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea') !== null,
      2_000,
    )
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
      .find((button) => button.textContent?.trim() === '预览')
      ?.click()
    const previewButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'),
    ).map((button) => button.textContent?.trim())
    const filePreview = await waitFor(() => document.querySelector('[data-testid="file-preview"]') !== null, 1_500)
    const highlightRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .file-row'),
    ).find((row) => row.textContent?.includes('smoke-highlight.ts'))
    highlightRow?.click()
    const syntaxHighlighted = await waitFor(
      () =>
        document.querySelector(
          '[data-testid="file-drawer"] .file-highlight .hljs-keyword, [data-testid="file-drawer"] .file-highlight .hljs-number',
        ) !== null,
      3_000,
    )
    const highlightEditor = document.querySelector<HTMLTextAreaElement>('[data-testid="file-drawer"] .file-textarea')
    const editorGutter = document.querySelectorAll('[data-testid="file-drawer"] .file-gutter span').length >= 1
    let editorCursor = false
    if (highlightEditor) {
      highlightEditor.selectionStart = highlightEditor.value.length
      highlightEditor.selectionEnd = highlightEditor.value.length
      highlightEditor.dispatchEvent(new Event('select', { bubbles: true }))
      highlightEditor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      const statusText = document.querySelector('[data-testid="editor-status"]')?.textContent ?? ''
      editorCursor = statusText.includes('第 2 行') && statusText.includes('第 1 列')
    }
    let highlightSaved = false
    if (highlightEditor) {
      const setHighlightValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setHighlightValue?.call(highlightEditor, 'const answer: number = 43\n')
      highlightEditor.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-drawer"] .btn'))
        .find((button) => button.textContent?.trim() === '保存')
        ?.click()
      const started = Date.now()
      while (Date.now() - started < 3_000 && !highlightSaved) {
        const response = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'files:read',
          params: { path: 'smoke-highlight.ts' },
        })
        highlightSaved =
          response.ok && (response.result as { content: string }).content === 'const answer: number = 43\n'
        if (!highlightSaved) await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    document.querySelector<HTMLButtonElement>('[data-testid="file-drawer"] .drawer-head .btn:last-child')?.click()
    await waitFor(() => document.querySelector('[data-testid="file-drawer"]') === null, 2_000)
    checks.fileEditor = {
      ok:
        filesMenu &&
        fileDrawer &&
        fileRows &&
        editorMounted &&
        editorSaved &&
        filePreview &&
        syntaxHighlighted &&
        highlightSaved &&
        editorGutter &&
        editorCursor,
      detail: `menu=${filesMenu} drawer=${fileDrawer} rows=${fileRows} editor=${editorMounted} saved=${editorSaved} preview=${filePreview} highlight=${syntaxHighlighted} editSaved=${highlightSaved} gutter=${editorGutter} cursor=${editorCursor} row=${Boolean(previewRow)} buttons=${previewButtons.join('|')}`,
    }

    const setInputValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    const paletteMounted = await waitFor(
      () => document.querySelector('[data-testid="command-palette"]') !== null,
      2_000,
    )
    const paletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
    let paletteRows = 0
    let paletteFileFound = false
    if (paletteInput) {
      setInputValue(paletteInput, '设置')
      await waitFor(() => document.querySelectorAll('.palette-row').length > 0, 2_000)
      paletteRows = document.querySelectorAll('.palette-row').length
      setInputValue(paletteInput, 'README')
      paletteFileFound = await waitFor(
        () => Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('README')),
        3_000,
      )
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const paletteClosed = await waitFor(() => document.querySelector('[data-testid="command-palette"]') === null, 2_000)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }))
    const shortcutMounted = await waitFor(
      () => document.querySelector('[data-testid="shortcut-sheet"]') !== null,
      2_000,
    )
    document.querySelector<HTMLButtonElement>('[data-testid="shortcut-sheet"] .btn-quiet')?.click()
    const shortcutClosed = await waitFor(() => document.querySelector('[data-testid="shortcut-sheet"]') === null, 2_000)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    const findMounted = await waitFor(
      () => document.querySelector<HTMLInputElement>('[data-testid="find-bar"] input') !== null,
      2_000,
    )
    const findInput = document.querySelector<HTMLInputElement>('[data-testid="find-bar"] input')
    let findCount = ''
    if (findInput) {
      setInputValue(findInput, '演示')
      await new Promise((resolve) => setTimeout(resolve, 100))
      findCount = document.querySelector('[data-testid="find-bar"] .find-count')?.textContent ?? ''
      findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => document.querySelector('[data-testid="find-bar"]') === null, 2_000)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    await waitFor(() => document.querySelector('[data-testid="command-palette"]') !== null, 2_000)
    const deepPaletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
    if (deepPaletteInput) setInputValue(deepPaletteInput, '项目设置')
    await waitFor(
      () => Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('项目设置')),
      2_000,
    )
    deepPaletteInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const deepLink = await waitFor(
      () =>
        document.querySelector('.settings-drawer') !== null &&
        document.querySelector('[data-testid="project-workspace"]') !== null,
      3_000,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    await waitFor(() => document.querySelector('[data-testid="command-palette"]') !== null, 2_000)
    const switchPaletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
    if (switchPaletteInput) setInputValue(switchPaletteInput, '存储与清理')
    await waitFor(
      () =>
        Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('存储与清理')),
      2_000,
    )
    switchPaletteInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const tabSwitchWhileOpen = await waitFor(() => document.querySelector('.storage-list') !== null, 3_000)
    document.querySelector<HTMLButtonElement>('.settings-drawer .btn-quiet')?.click()
    await waitFor(() => document.querySelector('.settings-drawer') === null, 2_000)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    await waitFor(() => document.querySelector('[data-testid="command-palette"]') !== null, 2_000)
    const aliasPaletteInput = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')
    if (aliasPaletteInput) setInputValue(aliasPaletteInput, '截图')
    const aliasCapture = await waitFor(
      () => Array.from(document.querySelectorAll('.palette-row')).some((row) => row.textContent?.includes('截图')),
      2_000,
    )
    if (aliasPaletteInput) setInputValue(aliasPaletteInput, 'worktree')
    const aliasWorktree = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.palette-row')).some((row) =>
          row.textContent?.includes('在新窗口打开分支'),
        ),
      2_000,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => document.querySelector('[data-testid="command-palette"]') === null, 2_000)
    checks.paletteAliases = {
      ok: aliasCapture && aliasWorktree,
      detail: `capture=${aliasCapture} worktree=${aliasWorktree}`,
    }
    checks.paletteShortcuts = {
      ok:
        paletteMounted &&
        paletteRows > 0 &&
        paletteFileFound &&
        paletteClosed &&
        shortcutMounted &&
        shortcutClosed &&
        findMounted &&
        findCount.includes('/') &&
        deepLink &&
        tabSwitchWhileOpen,
      detail: `palette=${paletteMounted} rows=${paletteRows} file=${paletteFileFound} closed=${paletteClosed} sheet=${shortcutMounted}/${shortcutClosed} find=${findMounted} count=${findCount} deepLink=${deepLink} switchOpen=${tabSwitchWhileOpen}`,
    }

    document.querySelector<HTMLButtonElement>('[data-testid="manual-toggle"]')?.click()
    const manualMounted = await waitFor(() => document.querySelector('[data-testid="manual-panel"]') !== null, 4000)
    const manualChapters = document.querySelectorAll('[data-testid="manual-toc-item"]').length
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="manual-toc-item"]'))
      .find((item) => item.textContent?.trim() === '界面总览')
      ?.click()
    const manualImages = await waitFor(
      () =>
        Array.from(document.querySelectorAll<HTMLImageElement>('.manual-content img')).some(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      3000,
    )
    const manualSearch = document.querySelector<HTMLInputElement>('[data-testid="manual-search"]')
    if (manualSearch) setInputValue(manualSearch, '备份')
    const manualFiltered = await waitFor(
      () => document.querySelectorAll('[data-testid="manual-toc-item"]').length < manualChapters,
      2000,
    )
    const manualContent = (document.querySelector('.manual-content')?.textContent ?? '').length > 100
    document.querySelector<HTMLButtonElement>('.manual-head .btn-quiet')?.click()
    const manualClosed = await waitFor(() => document.querySelector('[data-testid="manual-panel"]') === null, 2000)
    checks.manual = {
      ok: manualMounted && manualChapters > 5 && manualImages && manualFiltered && manualContent && manualClosed,
      detail: `mounted=${manualMounted} chapters=${manualChapters} images=${manualImages} filtered=${manualFiltered} content=${manualContent} closed=${manualClosed}`,
    }

    const continuityComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    const userCountBefore = document.querySelectorAll('.message.user').length
    let continuityDetail = 'composer missing'
    let continuityOk = false
    if (continuityComposer) {
      const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setTextareaValue?.call(continuityComposer, 'ui continuity smoke')
      continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
      continuityComposer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const userAdded = await waitFor(() => document.querySelectorAll('.message.user').length > userCountBefore, 4_000)
      await waitFor(() => document.querySelector('.send.stop') !== null, 2_000)
      const turnSettled = await waitFor(() => document.querySelector('.send.stop') === null, 15_000)
      const lastUser = Array.from(document.querySelectorAll('.message.user')).pop()
      const editButton = Array.from(lastUser?.querySelectorAll<HTMLButtonElement>('.copy-btn') ?? []).find((button) =>
        button.textContent?.includes('编辑并重发'),
      )
      editButton?.click()
      const editBadge = await waitFor(() => document.querySelector('[data-testid="edit-badge"]') !== null, 2_000)
      const editPrefill = await waitFor(() => continuityComposer.value === 'ui continuity smoke', 2_000)
      const lastAssistant = Array.from(document.querySelectorAll('.message.assistant')).pop()
      const regenerateButton = Array.from(lastAssistant?.querySelectorAll<HTMLButtonElement>('.copy-btn') ?? []).some(
        (button) => button.textContent?.includes('重新生成'),
      )
      document.querySelector<HTMLButtonElement>('[data-testid="edit-badge"] .attachment-remove')?.click()
      setTextareaValue?.call(continuityComposer, 'draft-check')
      continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const draftSaved = Object.keys(localStorage).some((key) => {
        if (!key.startsWith('xcode.draft.')) return false
        try {
          return (JSON.parse(localStorage.getItem(key) ?? '{}') as { text?: string }).text === 'draft-check'
        } catch {
          return false
        }
      })
      setTextareaValue?.call(continuityComposer, '')
      continuityComposer.dispatchEvent(new Event('input', { bubbles: true }))
      continuityOk = userAdded && turnSettled && editBadge && editPrefill && regenerateButton && draftSaved
      continuityDetail = `user=${userAdded} settled=${turnSettled} edit=${editBadge}/${editPrefill} regen=${regenerateButton} draft=${draftSaved}`
    }
    checks.continuity = { ok: continuityOk, detail: continuityDetail }

    const markdownComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    let markdownComposerOk = false
    let markdownComposerDetail = 'composer missing'
    if (markdownComposer) {
      const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setTextareaValue?.call(markdownComposer, 'bold text')
      markdownComposer.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      markdownComposer.focus()
      markdownComposer.setSelectionRange(0, 4)
      document.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click()
      const toolbar = await waitFor(() => document.querySelector('[data-testid="markdown-toolbar"]') !== null, 2_000)
      document.querySelector<HTMLButtonElement>('[data-testid="markdown-bold"]')?.click()
      const wrapped = await waitFor(() => markdownComposer.value === '**bold** text', 2_000)
      document.querySelector<HTMLButtonElement>('[data-testid="markdown-preview-toggle"]')?.click()
      const preview = await waitFor(
        () => document.querySelector('[data-testid="markdown-preview"] strong')?.textContent === 'bold',
        2_000,
      )
      markdownComposerOk = toolbar && wrapped && preview
      markdownComposerDetail = `toolbar=${toolbar} wrapped=${wrapped} preview=${preview}`
      setTextareaValue?.call(markdownComposer, '')
      markdownComposer.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click()
      await waitFor(() => document.querySelector('[data-testid="markdown-toolbar"]') === null, 2_000)
    }
    checks.markdownComposer = { ok: markdownComposerOk, detail: markdownComposerDetail }

    const imeComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    let imeOk = false
    let imeDetail = 'composer missing'
    if (imeComposer) {
      const setImeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setImeValue?.call(imeComposer, 'ime composing test')
      imeComposer.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      imeComposer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      imeOk = imeComposer.value === 'ime composing test'
      imeDetail = imeOk ? 'composing Enter kept the draft' : 'composing Enter submitted the draft'
      setImeValue?.call(imeComposer, '')
      imeComposer.dispatchEvent(new Event('input', { bubbles: true }))
    }
    checks.imeEnter = { ok: imeOk, detail: imeDetail }

    const userCopyButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.message.user .message-actions .copy-btn'),
    )
      .filter((button) => button.textContent?.trim() === '复制')
      .pop()
    userCopyButton?.click()
    const userCopied = await waitFor(() => userCopyButton?.textContent === '已复制', 2_000)
    checks.userCopy = {
      ok: Boolean(userCopyButton) && userCopied,
      detail: `button=${Boolean(userCopyButton)} copied=${userCopied}`,
    }

    const captureButton = document.querySelector<HTMLButtonElement>('[data-testid="capture-button"]')
    captureButton?.click()
    const captureMenu = await waitFor(() => document.querySelector('[data-testid="capture-menu"]') !== null, 2_000)
    const captureMenuText = document.querySelector('[data-testid="capture-menu"]')?.textContent ?? ''
    const captureOptions = captureMenuText.includes('框选区域') && captureMenuText.includes('整个屏幕')
    document.querySelector<HTMLDivElement>('.capture-scrim')?.click()
    const captureMenuClosed = await waitFor(
      () => document.querySelector('[data-testid="capture-menu"]') === null,
      2_000,
    )
    checks.captureMenu = {
      ok: captureMenu && captureOptions && captureMenuClosed,
      detail: `menu=${captureMenu} options=${captureOptions} closed=${captureMenuClosed}`,
    }

    const organizedList = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'session:list',
      params: {},
    })
    const organizedItems = organizedList.ok ? (organizedList.result as SessionListItem[]) : []
    const targetSession = organizedItems.find((item) => item.sessionId === activeSessionId) ?? organizedItems[0]
    let pinnedOk = false
    let archivedOk = false
    let searchOk = false
    let markdownOk = false
    let pdfOk = false
    let organizeDetail = 'no sessions'
    if (targetSession) {
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:set-pinned',
        params: { filePath: targetSession.filePath, pinned: true },
      })
      const pinnedList = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:list',
        params: {},
      })
      pinnedOk =
        pinnedList.ok &&
        (pinnedList.result as SessionListItem[]).some(
          (item) => item.filePath === targetSession.filePath && item.pinned === true,
        )
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:set-pinned',
        params: { filePath: targetSession.filePath, pinned: false },
      })

      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:set-archived',
        params: { filePath: targetSession.filePath, archived: true },
      })
      const archivedList = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:list',
        params: {},
      })
      archivedOk =
        archivedList.ok &&
        (archivedList.result as SessionListItem[]).some(
          (item) => item.filePath === targetSession.filePath && item.archived === true,
        )
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:set-archived',
        params: { filePath: targetSession.filePath, archived: false },
      })

      const searchResponse = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:search',
        params: { query: 'continuity smoke', limit: 10 },
      })
      const searchResults = searchResponse.ok
        ? (searchResponse.result as { results: SessionSearchResult[] }).results
        : []
      searchOk = searchResults.some((result) => result.snippet.length > 0)

      const mdExport = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:export',
        params: { filePath: targetSession.filePath, format: 'markdown' },
      })
      markdownOk = mdExport.ok && (mdExport.result as { size: number }).size > 0
      const pdfExport = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'session:export',
        params: { filePath: targetSession.filePath, format: 'pdf' },
      })
      pdfOk = pdfExport.ok && (pdfExport.result as { size: number }).size > 1000
      organizeDetail = `pinned=${pinnedOk} archived=${archivedOk} search=${searchOk} md=${markdownOk} pdf=${pdfOk}`
    }
    checks.sessionOrganize = {
      ok: pinnedOk && archivedOk && searchOk && markdownOk && pdfOk,
      detail: organizeDetail,
    }

    const projectBefore = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'project:settings',
      params: {},
    })
    let projectOk = false
    let projectDetail = 'missing'
    if (projectBefore.ok) {
      const before = projectBefore.result as ProjectSettingsView
      const savedProject = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'project:save',
        params: { modelId: before.effective.modelId, taskMode: 'writing', autoChecks: true },
      })
      const afterSave = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'project:settings',
        params: {},
      })
      const savedView = afterSave.ok ? (afterSave.result as ProjectSettingsView) : null
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'project:save',
        params: { modelId: null, taskMode: null, autoChecks: null },
      })
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'agent:set-task-mode',
        params: { mode: before.effective.taskMode as 'coding' | 'writing' | 'research' | 'office' },
      })
      projectOk =
        savedProject.ok && savedView?.overrides.taskMode === 'writing' && savedView?.overrides.autoChecks === true
      projectDetail = `save=${savedProject.ok} overrides=${JSON.stringify(savedView?.overrides ?? {})}`
    } else {
      projectDetail = projectBefore.error.message
    }
    checks.projectSettings = { ok: projectOk, detail: projectDetail }

    const storageUsage = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'storage:usage',
      params: {},
    })
    const storageCleanup = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'storage:cleanup',
      params: { sessionsOlderThanDays: 3650, attachmentsOlderThanDays: 3650 },
    })
    checks.storage = {
      ok:
        storageUsage.ok &&
        Array.isArray((storageUsage.result as StorageUsageView).categories) &&
        (storageUsage.result as StorageUsageView).categories.length >= 5 &&
        storageCleanup.ok,
      detail: storageUsage.ok
        ? `${(storageUsage.result as StorageUsageView).categories.length} categories, ${(storageUsage.result as StorageUsageView).totalBytes} bytes`
        : storageUsage.error.message,
    }

    const tabCount = (): number => document.querySelectorAll('[data-testid="session-tab"]').length
    const activeTabId = (): string | null =>
      document.querySelector('.tab-item.active')?.getAttribute('data-session-id') ?? null
    const tabById = (sessionId: string): Element | null =>
      Array.from(document.querySelectorAll('[data-testid="session-tab"]')).find(
        (tab) => tab.getAttribute('data-session-id') === sessionId,
      ) ?? null
    const previousActiveId = activeTabId()
    const tabsBefore = tabCount()
    document.querySelector<HTMLButtonElement>('.tab-add')?.click()
    const tabOpened = await waitFor(() => tabCount() > tabsBefore, 4000)
    const tabsAfterAdd = tabCount()
    if (previousActiveId) tabById(previousActiveId)?.querySelector<HTMLButtonElement>('.tab-label')?.click()
    const tabSwitched = previousActiveId ? await waitFor(() => activeTabId() === previousActiveId, 5000) : false
    document.querySelector<HTMLButtonElement>('.tab-item.active .tab-close')?.click()
    const tabClosed = previousActiveId ? await waitFor(() => tabById(previousActiveId) === null, 5000) : false
    checks.workspaceTabs = {
      ok: tabsBefore > 0 && tabOpened && tabSwitched && tabClosed,
      detail: `before=${tabsBefore} activeBefore=${previousActiveId ?? 'none'} afterAdd=${tabsAfterAdd} switched=${tabSwitched} closed=${tabClosed}`,
    }

    const windowsBefore = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:window-info',
      params: {},
    })
    const beforeCount = windowsBefore.ok ? (windowsBefore.result as { count: number }).count : 0
    const createWindowResult = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:new-window',
      params: {},
    })
    let windowOpened = false
    if (createWindowResult.ok) {
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        const info = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'app:window-info',
          params: {},
        })
        if (info.ok && (info.result as { count: number }).count > beforeCount) {
          windowOpened = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    checks.multiWindow = {
      ok: beforeCount > 0 && createWindowResult.ok && windowOpened,
      detail: createWindowResult.ok ? `before=${beforeCount} opened=${windowOpened}` : createWindowResult.error.message,
    }

    const windowCount = async (): Promise<number> => {
      const info = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'app:window-info',
        params: {},
      })
      return info.ok ? (info.result as { count: number }).count : 0
    }
    const waitForWindowCount = async (baseline: number, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if ((await windowCount()) > baseline) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    }

    const branchList = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'git:branches',
      params: {},
    })
    const branchView = branchList.ok ? (branchList.result as BranchListView) : null
    let branchPickerOpened = false
    let branchRowFound = false
    let branchWindowOpened = false
    let branchReused = false
    let branchWorkspaceReady = false
    let branchWorkspacePath = ''
    let branchDetail = branchView
      ? `${branchView.branches.length} branch(es)`
      : branchList.ok
        ? 'no data'
        : branchList.error.message
    if (branchView?.isRepo) {
      document.querySelector<HTMLButtonElement>('[data-testid="branch-window-button"]')?.click()
      branchPickerOpened = await waitFor(() => document.querySelector('[data-testid="branch-picker"]') !== null, 4000)
      await waitFor(() => document.querySelectorAll('[data-testid="branch-row"]').length >= 2, 4000)
      const branchRow = Array.from(document.querySelectorAll('[data-testid="branch-row"]')).find(
        (row) => row.getAttribute('data-branch') === 'smoke-branch',
      ) as HTMLButtonElement | undefined
      if (branchRow && !branchRow.disabled) {
        branchRowFound = true
        const beforeBranchWindow = await windowCount()
        branchRow.click()
        branchWindowOpened = await waitForWindowCount(beforeBranchWindow, 8000)
        const reused = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'worktree:open',
          params: { branch: 'smoke-branch' },
        })
        branchReused = reused.ok && (reused.result as { created: boolean }).created === false
        if (reused.ok) {
          const clean = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
          const expected = clean((reused.result as { workspacePath: string }).workspacePath)
          branchWorkspacePath = expected
          const deadline = Date.now() + 8000
          while (Date.now() < deadline) {
            const info = await window.xcode.request({
              id: crypto.randomUUID(),
              method: 'app:window-info',
              params: {},
            })
            const windows = info.ok ? ((info.result as { windows?: Array<{ workspace?: string }> }).windows ?? []) : []
            if (windows.some((entry) => entry.workspace && clean(entry.workspace) === expected)) {
              branchWorkspaceReady = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 150))
          }
        }
      }
      document.querySelector<HTMLButtonElement>('.branch-card .btn-quiet')?.click()
      branchDetail = `picker=${branchPickerOpened} row=${branchRowFound} window=${branchWindowOpened} reused=${branchReused} workspace=${branchWorkspaceReady}`
    }
    checks.branchWorktree = {
      ok: branchPickerOpened && branchRowFound && branchWindowOpened && branchReused && branchWorkspaceReady,
      detail: branchDetail,
    }

    let worktreeUiOk = false
    let worktreeUiDetail = 'picker missing'
    document.querySelector<HTMLButtonElement>('[data-testid="branch-window-button"]')?.click()
    const uiPickerOpen = await waitFor(() => document.querySelector('[data-testid="branch-picker"]') !== null, 4000)
    if (uiPickerOpen) {
      const removeReady = await waitFor(
        () => document.querySelector('[data-testid="branch-remove"][data-branch="smoke-branch"]') !== null,
        4000,
      )
      const removeButton = document.querySelector<HTMLButtonElement>(
        '[data-testid="branch-remove"][data-branch="smoke-branch"]',
      )
      if (removeReady) removeButton?.click()
      const confirmReady = await waitFor(
        () => document.querySelector('[data-testid="worktree-remove-confirm"]') !== null,
        2000,
      )
      document.querySelector<HTMLButtonElement>('[data-testid="worktree-remove-confirm"] .btn-quiet')?.click()
      const cancelled = await waitFor(
        () => document.querySelector('[data-testid="worktree-remove-confirm"]') === null,
        2000,
      )
      const prunePresent = document.querySelector('[data-testid="worktree-prune-button"]') !== null
      const remoteRow = document.querySelector('[data-testid="branch-row"][data-branch="origin/smoke-remote"]') !== null
      const createForm = document.querySelector('[data-testid="branch-create"]') !== null
      const parentPicker = document.querySelector('[data-testid="branch-parent-button"]') !== null
      const newBranchInput = document.querySelector<HTMLInputElement>('[data-testid="branch-new-input"]')
      const setNewBranchValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setNewBranchValue?.call(newBranchInput, 'smoke-ui-new')
      newBranchInput?.dispatchEvent(new Event('input', { bubbles: true }))
      const createEnabled = await waitFor(
        () => document.querySelector<HTMLButtonElement>('[data-testid="branch-create-button"]')?.disabled === false,
        2_000,
      )
      const beforeBranchCreateWindow = await windowCount()
      document.querySelector<HTMLButtonElement>('[data-testid="branch-create-button"]')?.click()
      const branchModalClosed = await waitFor(
        () => document.querySelector('[data-testid="branch-picker"]') === null,
        8_000,
      )
      const branchCreateWindow = await waitForWindowCount(beforeBranchCreateWindow, 8_000)
      checks.branchCreateUi = {
        ok: createEnabled && branchModalClosed && branchCreateWindow,
        detail: `input=${createEnabled} closed=${branchModalClosed} window=${branchCreateWindow}`,
      }
      document.querySelector<HTMLButtonElement>('.branch-card .shortcut-head .btn-quiet')?.click()
      worktreeUiOk = removeReady && confirmReady && cancelled && prunePresent && remoteRow && createForm && parentPicker
      worktreeUiDetail = `remove=${removeReady} confirm=${confirmReady} cancel=${cancelled} prune=${prunePresent} remote=${remoteRow} create=${createForm} parent=${parentPicker}`
    } else {
      checks.branchCreateUi = { ok: false, detail: 'picker missing' }
    }
    checks.worktreeUi = { ok: worktreeUiOk, detail: worktreeUiDetail }

    const guardedRemoval = branchWorkspacePath
      ? await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'worktree:remove',
          params: { path: branchWorkspacePath },
        })
      : null
    checks.worktreeGuard = {
      ok: guardedRemoval !== null && !guardedRemoval.ok && guardedRemoval.error.code === 'worktree-in-use',
      detail:
        guardedRemoval === null
          ? 'no worktree path'
          : guardedRemoval.ok
            ? 'removal was allowed while the window is open'
            : guardedRemoval.error.code,
    }

    const openRemoveWorktree = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'worktree:open',
      params: { branch: 'smoke-remove' },
    })
    let worktreeManageOk = false
    let worktreeManageDetail = openRemoveWorktree.ok ? 'open failed' : openRemoveWorktree.error.message
    if (openRemoveWorktree.ok) {
      const removePath = (openRemoveWorktree.result as { workspacePath: string }).workspacePath
      const removed = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:remove',
        params: { path: removePath },
      })
      const pruned = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:prune',
        params: {},
      })
      const after = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'git:branches',
        params: {},
      })
      const afterView = after.ok ? (after.result as BranchListView) : null
      const smokeRemoveBranch = afterView?.branches.find((branch) => branch.name === 'smoke-remove')
      worktreeManageOk =
        removed.ok &&
        (removed.result as { removed: boolean }).removed === true &&
        pruned.ok &&
        (Boolean(smokeRemoveBranch) ? smokeRemoveBranch?.worktreePath === undefined : false)
      worktreeManageDetail = `removed=${removed.ok} pruned=${pruned.ok} branch=${Boolean(smokeRemoveBranch)} worktree=${smokeRemoveBranch?.worktreePath ?? 'none'}`
    }
    checks.worktreeManage = { ok: worktreeManageOk, detail: worktreeManageDetail }

    const remoteOpen = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'worktree:open',
      params: { branch: 'smoke-remote', remoteRef: 'origin/smoke-remote' },
    })
    let remoteDetail = remoteOpen.ok ? 'created' : remoteOpen.error.message
    let remoteOk = false
    if (remoteOpen.ok) {
      const remotePath = (remoteOpen.result as { workspacePath: string }).workspacePath
      remoteOk = (remoteOpen.result as { created: boolean }).created
      const removed = await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'worktree:remove',
        params: { path: remotePath },
      })
      remoteOk = remoteOk && removed.ok
      remoteDetail = `created=${remoteOk} removed=${removed.ok}`
    }
    checks.worktreeRemote = { ok: remoteOk, detail: remoteDetail }

    let sessionMoveOk = false
    let sessionMoveDetail = 'no session row'
    let movedFilePath = ''
    const sessionRow = document.querySelector<HTMLElement>('.sidebar-session-row')
    if (sessionRow) {
      sessionRow.querySelector<HTMLButtonElement>('.sidebar-session')?.click()
      let activeSaved = false
      const loadedDeadline = Date.now() + 5000
      while (Date.now() < loadedDeadline) {
        const list = await window.xcode.request({
          id: crypto.randomUUID(),
          method: 'session:list',
          params: {},
        })
        const items = list.ok ? (list.result as SessionListItem[]) : []
        const active = items.find((item) => item.sessionId === activeTabId())
        if (active) {
          activeSaved = true
          movedFilePath = active.filePath
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const moveId = activeTabId()
      const beforeMoveWindow = await windowCount()
      document.querySelectorAll<HTMLButtonElement>('.tab-add')[1]?.click()
      const movedWindow = await waitForWindowCount(beforeMoveWindow, 8000)
      const tabGone = moveId ? await waitFor(() => tabById(moveId) === null, 6000) : false
      sessionMoveOk = activeSaved && Boolean(moveId) && movedWindow && tabGone
      sessionMoveDetail = `saved=${activeSaved} tab=${moveId ?? 'none'} window=${movedWindow} closed=${tabGone}`

      if (sessionMoveOk && movedFilePath && moveId) {
        const clean = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
        const fileName = (value: string): string => clean(value).split('/').filter(Boolean).pop() ?? ''
        const expectedName = fileName(movedFilePath)
        let ownedByOther = false
        const ownerDeadline = Date.now() + 8000
        while (Date.now() < ownerDeadline) {
          const info = await window.xcode.request({
            id: crypto.randomUUID(),
            method: 'app:window-info',
            params: {},
          })
          if (info.ok) {
            const payload = info.result as {
              senderId: number | null
              windows: Array<{ id: number; sessionFiles: string[] }>
            }
            if (
              payload.windows.some(
                (window) =>
                  window.id !== payload.senderId &&
                  window.sessionFiles.some((filePath) => fileName(filePath) === expectedName),
              )
            ) {
              ownedByOther = true
              break
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        const movedRow = document.querySelector<HTMLButtonElement>(
          `.sidebar-session-row[data-session-id="${moveId}"] .sidebar-session`,
        )
        movedRow?.click()
        const blocked = await waitFor(
          () => document.body.textContent?.includes('该会话已在另一个窗口打开') ?? false,
          5000,
        )
        checks.sessionOwnership = {
          ok: ownedByOther && Boolean(movedRow) && blocked,
          detail: `owner=${ownedByOther} row=${Boolean(movedRow)} blocked=${blocked}`,
        }
      }
    }
    checks.sessionMove = { ok: sessionMoveOk, detail: sessionMoveDetail }

    const corruptSessionId = '20260101-000000-999'
    const corruptTs = new Date().toISOString()
    const corruptLines = [
      {
        t: 'meta',
        kind: 'header',
        cwd: workspace,
        modelId: 'demo:mock',
        startedAt: corruptTs,
        firstPrompt: 'corrupt smoke',
        taskSlug: 'corrupt-smoke',
        sessionId: corruptSessionId,
      },
      {
        t: 'meta',
        kind: 'transcript-epoch-start',
        epochId: 'lost-epoch',
        parentEpochId: 'missing-parent',
        mode: 'delta',
        ts: corruptTs,
      },
      {
        t: 'msg',
        epochId: 'lost-epoch',
        entryId: 'corrupt-1',
        message: { role: 'user', content: 'salvaged question' },
        ts: corruptTs,
      },
      {
        t: 'msg',
        epochId: 'lost-epoch',
        entryId: 'corrupt-2',
        message: { role: 'assistant', content: 'salvaged answer' },
        ts: corruptTs,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')
    const corruptWrite = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'files:write',
      params: { path: '.x-code/sessions/smoke-corrupt.jsonl', content: `${corruptLines}\n` },
    })
    document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
    const corruptRowReady = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.sidebar-session-row')).some((row) =>
          row.textContent?.includes('corrupt smoke'),
        ),
      4_000,
    )
    const corruptRow = Array.from(document.querySelectorAll('.sidebar-session-row')).find((row) =>
      row.textContent?.includes('corrupt smoke'),
    )
    corruptRow?.querySelector<HTMLButtonElement>('.sidebar-session')?.click()
    const salvageDialog = await waitFor(() => document.querySelector('[data-testid="salvage-dialog"]') !== null, 4_000)
    document.querySelector<HTMLButtonElement>('[data-testid="salvage-confirm"]')?.click()
    const salvageRestored = await waitFor(
      () =>
        document.querySelector('[data-testid="salvage-dialog"]') === null &&
        (document.body.textContent?.includes('salvaged question') ?? false),
      6_000,
    )
    checks.sessionSalvage = {
      ok: corruptWrite.ok && corruptRowReady && salvageDialog && salvageRestored,
      detail: `write=${corruptWrite.ok} row=${corruptRowReady} dialog=${salvageDialog} restored=${salvageRestored}`,
    }

    document.querySelector<HTMLButtonElement>('.sidebar-sessions-section .sidebar-add')?.click()
    await waitFor(() => document.querySelector('.sidebar-session-placeholder') !== null, 2_000)
    const newSessionId = document.querySelector('.tab-item.active')?.getAttribute('data-session-id') ?? ''
    const saveComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    let newSessionTitle = false
    let newSessionRow = false
    if (saveComposer && newSessionId) {
      const setSaveValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setSaveValue?.call(saveComposer, 'smoke autosave title')
      saveComposer.dispatchEvent(new Event('input', { bubbles: true }))
      saveComposer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: false }),
      )
      newSessionTitle = await waitFor(
        () =>
          document
            .querySelector(`.tab-item[data-session-id="${newSessionId}"] .tab-title`)
            ?.textContent?.includes('smoke autosave') ?? false,
        4_000,
      )
      newSessionRow = await waitFor(
        () =>
          Array.from(document.querySelectorAll('.sidebar-session-row')).some((row) =>
            row.textContent?.includes('smoke autosave'),
          ),
        20_000,
      )
    }
    checks.newSessionSave = {
      ok: Boolean(newSessionId) && newSessionTitle && newSessionRow,
      detail: `id=${Boolean(newSessionId)} tab=${newSessionTitle} sidebar=${newSessionRow}`,
    }

    await waitFor(() => document.querySelector('.tab-busy') === null, 5_000)
    const guardComposer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    let workspaceGuardShown = false
    let workspaceGuardClosed = false
    if (guardComposer) {
      const setGuardValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setGuardValue?.call(guardComposer, '看看 /Users/example/other-project/file.ts')
      guardComposer.dispatchEvent(new Event('input', { bubbles: true }))
      guardComposer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: false }),
      )
      workspaceGuardShown = await waitFor(
        () => document.querySelector('[data-testid="workspace-guard"]') !== null,
        3_000,
      )
      document
        .querySelector<HTMLButtonElement>('[data-testid="workspace-guard"] .branch-confirm-actions .btn-quiet')
        ?.click()
      workspaceGuardClosed = await waitFor(
        () => document.querySelector('[data-testid="workspace-guard"]') === null,
        2_000,
      )
      setGuardValue?.call(guardComposer, '')
      guardComposer.dispatchEvent(new Event('input', { bubbles: true }))
    }
    checks.workspaceGuard = {
      ok: workspaceGuardShown && workspaceGuardClosed,
      detail: `shown=${workspaceGuardShown} closed=${workspaceGuardClosed}`,
    }

    const editorProbe = await window.xcode.request({
      id: crypto.randomUUID(),
      method: 'app:open-in-editor',
      params: { filePath: '/nonexistent/x-code-editor-probe.txt' },
    })
    const editorProbeResult = editorProbe.ok ? (editorProbe.result as { opened: boolean }) : null
    checks.openInEditor = {
      ok: editorProbe.ok && editorProbeResult?.opened === false,
      detail: editorProbe.ok ? `opened=${editorProbeResult?.opened}` : editorProbe.error.message,
    }
  } catch (error) {
    checks.exception = { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (originalModelId) {
      await window.xcode.request({
        id: crypto.randomUUID(),
        method: 'models:set',
        params: { modelId: originalModelId },
      })
    }
    applyTheme(originalTheme)
    if (originalLanguage !== 'zh') await i18n.changeLanguage(originalLanguage)
  }

  const ok = Object.values(checks).every((check) => check.ok)
  reportProgress('finishing')
  // `checks` 是用于进度追踪的 Proxy；结构化克隆无法序列化它，
  // 因此发送一个普通快照。
  window.xcode.reportUiSmoke({ ok, checks: { ...checks } })
}
