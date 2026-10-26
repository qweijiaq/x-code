// @x-code-cli/core — 工具执行与分发
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { aggregatePostToolUse, aggregatePreToolUse } from '../hooks/bus.js'
import type { ToolHookSnapshot } from '../hooks/bus.js'
import { classifyDecision } from '../mcp/permissions.js'
import {
  evaluateToolAuthority,
  isPathWithinProject,
  resolvePhysicalPath,
  verifyAuthorityApproval,
} from '../permissions/index.js'
import { checkPermissionDetailed } from '../permissions/index.js'
import { BROWSER_VISUAL_CHECK_TOOL_NAME } from '../tools/browser-visual-check.js'
import { applyBatchEdits, normalizeEditInput, normalizedEditRecord } from '../tools/edit-apply.js'
import { MAX_TOOL_RESULT_BYTES, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { applySedSubstitution, parseSedEditCommand } from '../tools/sed-edit-parser.js'
import { formatShellExecutionResult } from '../tools/shell-session/format.js'
import {
  normalizeHardTimeout,
  normalizeInitialWait,
  normalizeInteractWait,
  normalizeMaxOutputTokens,
  normalizeTerminalResize,
  resolveShellCwd,
} from '../tools/shell-session/request.js'
import type {
  FinalObservationLease,
  PreparedShellRequest,
  ShellHookOrigin,
  ShellObservation,
} from '../tools/shell-session/types.js'
import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { AgentCallbacks, AgentOptions, LanguageModel, PermissionDecision } from '../types/index.js'
import { XCODE_DIR, debugLog, isAbortError } from '../utils.js'
import { noteForRecentTempFiles, workspaceOutputNote } from '../utils/output-location.js'
import { runBrowserVisualCheck } from './browser/visual-check.js'
import { createBuiltInToolHandlers } from './built-in-tool-handlers.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isManagedMemoryAccess, isManagedMemoryMutation } from './managed-memory-boundary.js'
import {
  isToolErrorString,
  structuredToolResultMessage,
  toolErrorFromUnknown,
  toolErrorString,
  toolResultMessage,
} from './messages.js'
import type { ToolImage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { effectiveExecutionAuthority } from './provenance.js'
import { captureFileBeforeMutation } from './snapshot.js'
import type { SubAgentLoopRunner } from './sub-agents/runner.js'
import type { ToolExecutionControl, ToolHandler, ToolHandlerContext } from './tool-handler-context.js'
import { VISUAL_CHECK_CAPTION_PROMPT, deliverToolImages } from './tool-image-delivery.js'
import { appendTrackedMessage } from './tracked-messages.js'

export { isManagedMemoryAccess, isManagedMemoryMutation }
export { deliverToolImages }

/** 统计子串出现次数，不创建中间数组。 */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** 执行一个写入工具（writeFile / edit）。
 *
 *  除了返回面向模型的结果字符串，还会（在已定义时）用结构化补丁触发
 *  `callbacks.onFileEdit`，让 UI 能在工具条目下方渲染彩色 diff。diff 负载
 *  是仅 UI 的旁路——它绝不进入 `state.messages`，模型只看到简短的结果字符串。 */
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
  beforeWrite: (filePath: string) => Promise<void>,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 在写入之前读取旧内容，以便做 diff。把任何读取失败都视为“文件不存在”——
    // 覆盖常见的 ENOENT 路径，以及权限 / EISDIR 等边界情况（写入时反正也会报错）。
    let oldContent: string | null = null
    try {
      oldContent = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    } catch {
      oldContent = null
    }
    await beforeWrite(filePath)
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })
    const isNew = oldContent === null
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)${workspaceOutputNote(filePath)}`
    }
    return `File written: ${filePath} (${lineCount} lines)${workspaceOutputNote(filePath)}`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const edits = input.edits

    // 共享的 edit 收尾：持久化 newContent，然后发出 UI diff 旁路。
    const applyEdit = async (oldContent: string, newContent: string): Promise<void> => {
      if (signal?.aborted) throw signal.reason ?? new Error('Edit interrupted by user')
      await beforeWrite(filePath)
      await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })

      const payload = computeEditDiff(filePath, oldContent, newContent)
      if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)
    }

    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (Array.isArray(edits)) {
      const newContent = applyBatchEdits(content, edits)
      await applyEdit(content, newContent)

      return `File edited: ${filePath} (${edits.length} replacements)${workspaceOutputNote(filePath)}`
    }

    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    if (!oldString) return toolErrorString('oldString must not be empty.')
    if (oldString === newString) return toolErrorString('oldString and newString must be different.')

    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await applyEdit(content, newContent)

    return `File edited: ${filePath}${workspaceOutputNote(filePath)}`
  }

  return toolErrorString('unknown write tool')
}

/** 把工具结果推入状态并通知 UI。`images`（base64 + 媒体类型）只对返回图片内容的
 *  MCP 工具携带——它们成为 tool_result 中的 media 片段，让视觉模型能看到；
 *  UI 回调始终拿到文本形式。 */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
  images?: readonly ToolImage[],
  notifyUi = true,
): void {
  appendTrackedMessage(state, toolResultMessage(toolCallId, toolName, output, images, isError))
  // 为手动分发的工具（shell、writeFile、edit、askUser）清除进度上报器。
  // 自动执行的工具走 SDK 流的 `tool-result` 事件并在那里清除——那种情况下
  // 此调用是 no-op，因为上报器已经没了。
  clearProgressReporter(toolCallId)
  if (notifyUi) callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

type HandlerCtx = ToolHandlerContext

const SHELL_OUTPUT_MAX_BYTES = 1024 * 1024

function shellResultMaxBytes(maxOutputTokens: number | undefined): number {
  const normalized = normalizeMaxOutputTokens(maxOutputTokens)
  if (normalized === undefined) return MAX_TOOL_RESULT_BYTES
  return Math.max(1, Math.min(SHELL_OUTPUT_MAX_BYTES, normalized * 4))
}

function emptyToolHookSnapshot(toolName: string): ToolHookSnapshot {
  return Object.freeze({
    generation: 0,
    toolName,
    preHooks: Object.freeze([]),
    postHooks: Object.freeze([]),
  })
}

function canonicalCwdEquals(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function validateShellInput(input: Record<string, unknown>): {
  command: string
  requestedCwd?: string
  initialWait: PreparedShellRequest['initialWait']
  hardTimeoutMs?: number
  maxOutputTokens?: number
  tty: boolean
} {
  if (typeof input.command !== 'string') throw new TypeError('shell.command must be a string')
  if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new TypeError('shell.cwd must be a string')
  if (input.runInBackground !== undefined && typeof input.runInBackground !== 'boolean') {
    throw new TypeError('shell.runInBackground must be a boolean')
  }
  if (input.tty !== undefined && typeof input.tty !== 'boolean') throw new TypeError('shell.tty must be a boolean')
  return {
    command: input.command,
    requestedCwd: input.cwd as string | undefined,
    initialWait: normalizeInitialWait({
      yieldTimeMs: input.yieldTimeMs as number | undefined,
      runInBackground: input.runInBackground as boolean | undefined,
    }),
    hardTimeoutMs: normalizeHardTimeout(input.timeout as number | undefined),
    maxOutputTokens: normalizeMaxOutputTokens(input.maxOutputTokens as number | undefined),
    tty: input.tty === true,
  }
}

async function prepareShellRequest(ctx: HandlerCtx): Promise<boolean> {
  const raw = validateShellInput(ctx.input)
  const preliminaryCwd = await resolveShellCwd(ctx.state.projectCwd, raw.requestedCwd)
  const authority = effectiveExecutionAuthority(ctx.state.executionAuthority, ctx.state.contextSecurity)
  ctx.state.executionAuthority = authority
  const snapshot = ctx.options.hookBus?.captureToolSnapshot('shell') ?? emptyToolHookSnapshot('shell')
  ctx.shellHookSnapshot = snapshot
  ctx.shellPreToolUse = authority.peerTainted
    ? 'skipped-peer-tainted'
    : snapshot.preHooks.length
      ? 'executed'
      : 'not-configured'
  ctx.input = {
    ...ctx.input,
    cwd: preliminaryCwd,
    ...(raw.requestedCwd !== undefined ? { requestedCwd: raw.requestedCwd } : {}),
  }

  if (!authority.peerTainted && snapshot.preHooks.length > 0 && ctx.options.hookBus) {
    try {
      const decisions = await ctx.options.hookBus.emitToolSnapshot(
        snapshot,
        'pre',
        {
          name: 'PreToolUse',
          session: { cwd: preliminaryCwd, modelId: ctx.options.modelId },
          tool: { name: 'shell', args: ctx.input, callId: ctx.toolCallId },
          authority,
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePreToolUse(decisions)
      if (effect.decision === 'deny') {
        pushToolResult(
          ctx.state,
          ctx.callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString(`Tool denied by plugin hook: ${effect.reason ?? 'blocked by plugin hook'}`),
          true,
        )
        return false
      }
      if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
        ctx.input = effect.args as Record<string, unknown>
      }
    } catch (error) {
      if (ctx.options.abortSignal?.aborted) {
        pushToolResult(
          ctx.state,
          ctx.callbacks,
          ctx.toolCallId,
          ctx.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
        return false
      }
      debugLog('agent.hook-pre-tool-error', String(error))
    }
  }

  const effective = validateShellInput(ctx.input)
  const finalCwd = await resolveShellCwd(ctx.state.projectCwd, effective.requestedCwd)
  if (!canonicalCwdEquals(preliminaryCwd, finalCwd)) {
    throw new Error('A PreToolUse hook attempted to change shell.cwd; the command was not started')
  }
  ctx.effectiveCwd = finalCwd
  ctx.input = {
    ...ctx.input,
    command: effective.command,
    cwd: finalCwd,
    ...(raw.requestedCwd !== undefined ? { requestedCwd: raw.requestedCwd } : {}),
  }
  ctx.preparedShell = {
    command: effective.command,
    requestedCwd: raw.requestedCwd,
    effectiveCwd: finalCwd,
    projectCwd: ctx.state.projectCwd,
    initialWait: effective.initialWait,
    hardTimeoutMs: effective.hardTimeoutMs,
    tty: effective.tty,
    maxOutputBytes: SHELL_OUTPUT_MAX_BYTES,
    spillMaxInlineBytes: Math.min(MAX_TOOL_RESULT_BYTES, shellResultMaxBytes(effective.maxOutputTokens)),
    hookInput: Object.freeze({ ...ctx.input }),
  }
  return true
}

function enrichShellTransportInput(ctx: HandlerCtx): void {
  if (ctx.toolName !== 'shellOutput' && ctx.toolName !== 'killShell') return
  const shellId = typeof ctx.input.shellId === 'string' ? ctx.input.shellId : ''
  const metadata = ctx.state.shellSessions.getSessionMetadata(shellId)
  if (!metadata) return
  ctx.effectiveCwd = metadata.effectiveCwd
  ctx.input = {
    ...ctx.input,
    _managerInstanceId: metadata.managerInstanceId,
    _command: metadata.command,
    _effectiveCwd: metadata.effectiveCwd,
  }
}

async function checkCentralAuthority(ctx: HandlerCtx): Promise<boolean> {
  const authority = effectiveExecutionAuthority(ctx.state.executionAuthority, ctx.state.contextSecurity)
  ctx.state.executionAuthority = authority
  const mcpEntry = ctx.options.mcpRegistry?.get(ctx.toolName)
  const decision = evaluateToolAuthority({
    toolName: ctx.toolName,
    input: ctx.input,
    authority,
    trustMode: ctx.options.trustMode,
    cwd: ctx.effectiveCwd ?? ctx.state.projectCwd,
    isMcpTool: Boolean(mcpEntry),
    mcpServerId: mcpEntry?.serverName,
  })
  if (decision.kind === 'allow') return true
  if (decision.kind === 'deny') {
    pushToolResult(ctx.state, ctx.callbacks, ctx.toolCallId, ctx.toolName, `Authority denied: ${decision.reason}`, true)
    return false
  }
  if (!ctx.callbacks.onAskAuthority) {
    pushToolResult(
      ctx.state,
      ctx.callbacks,
      ctx.toolCallId,
      ctx.toolName,
      'Authority denied: no local peer-influenced approval UI is available.',
      true,
    )
    return false
  }
  let approval
  try {
    approval = await ctx.callbacks.onAskAuthority({
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      input: ctx.input,
      preview: decision.preview,
    })
  } catch (error) {
    if (isAbortError(error, ctx.options.abortSignal)) {
      pushToolResult(
        ctx.state,
        ctx.callbacks,
        ctx.toolCallId,
        ctx.toolName,
        '[Tool execution interrupted by user]',
        true,
      )
      return false
    }
    throw error
  }
  const currentAuthority = effectiveExecutionAuthority(ctx.state.executionAuthority, ctx.state.contextSecurity)
  const currentDecision = evaluateToolAuthority({
    toolName: ctx.toolName,
    input: ctx.input,
    authority: currentAuthority,
    trustMode: ctx.options.trustMode,
    cwd: ctx.effectiveCwd ?? ctx.state.projectCwd,
    isMcpTool: Boolean(mcpEntry),
    mcpServerId: mcpEntry?.serverName,
  })
  if (
    currentDecision.kind !== 'ask' ||
    currentDecision.preview.authorityHash !== decision.preview.authorityHash ||
    currentDecision.preview.outboundPayload?.sha256 !== decision.preview.outboundPayload?.sha256 ||
    !verifyAuthorityApproval(approval, currentDecision.preview, currentAuthority)
  ) {
    pushToolResult(
      ctx.state,
      ctx.callbacks,
      ctx.toolCallId,
      ctx.toolName,
      'Authority denied: approval did not match the complete canonical call payload.',
      true,
    )
    return false
  }
  ctx.authorityApprovedOnce = true
  return true
}

/** 用 PostToolUse 钩子发射包装 pushToolResult。只有两个“真正”的成功结果调用点
 *  使用它——error / 中断 / 权限拒绝路径仍直接调用 pushToolResult，因为在合成的
 *  deny 上发射 PostToolUse 会让钩子作者感到困惑。旁路处理器（askUser / task /
 *  MCP 资源）今天也直接推入；把它们提升到这个辅助函数是后续工作。 */
async function pushSuccessfulToolResult(
  ctx: HandlerCtx,
  output: string,
  isError: boolean,
  images?: readonly ToolImage[],
): Promise<void> {
  if (ctx.toolName === 'shell' && ctx.preparedShell && ctx.shellHookSnapshot && ctx.shellPreToolUse) {
    const origin = createShellHookOrigin(ctx)
    const baseOutput = truncateShellResult(ctx, output)
    let effectiveOutput = baseOutput
    try {
      effectiveOutput = await runOriginalShellPost(ctx, origin, baseOutput, isError)
    } catch (error) {
      if (!isAbortError(error, ctx.options.abortSignal)) throw error
      debugLog('agent.shell-post-aborted', ctx.toolCallId)
    }
    appendAndNotifyShellResult(ctx, effectiveOutput, isError)
    return
  }
  let effectiveOutput = output
  if (!ctx.state.executionAuthority.peerTainted && ctx.options.hookBus?.has('PostToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PostToolUse',
          session: { cwd: ctx.effectiveCwd ?? ctx.state.projectCwd, modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId, output, isError },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePostToolUse(decisions)
      if (effect.output !== undefined) effectiveOutput = effect.output
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-post-tool-error', String(err))
    }
  }
  pushToolResult(
    ctx.state,
    ctx.callbacks,
    ctx.toolCallId,
    ctx.toolName,
    effectiveOutput,
    isError,
    images,
    !isManagedMemoryAccess(ctx.toolName, ctx.input, ctx.options.memoryService?.memoryRoot),
  )
}

function createShellHookOrigin(ctx: HandlerCtx): ShellHookOrigin {
  if (!ctx.preparedShell || !ctx.shellHookSnapshot || !ctx.shellPreToolUse || !ctx.effectiveCwd) {
    throw new Error('Shell request was not safely prepared')
  }
  return Object.freeze({
    toolCallId: ctx.toolCallId,
    toolName: 'shell' as const,
    effectiveArgs: ctx.preparedShell.hookInput,
    effectiveCwd: ctx.effectiveCwd,
    modelId: ctx.options.modelId,
    authority: structuredClone(ctx.state.executionAuthority),
    authorityApprovedOnce: ctx.authorityApprovedOnce ?? false,
    preToolUse: ctx.shellPreToolUse,
    hookRegistryGeneration: ctx.shellHookSnapshot.generation,
    hookSnapshot: ctx.shellHookSnapshot,
  })
}

function truncateShellResult(ctx: HandlerCtx, output: string): string {
  const maxOutputTokens = ctx.input.maxOutputTokens as number | undefined
  if (maxOutputTokens === undefined) return truncateToolResult(output)
  return truncateToolResult(output, { maxBytes: shellResultMaxBytes(maxOutputTokens) })
}

async function runOriginalShellPost(
  ctx: HandlerCtx,
  origin: ShellHookOrigin,
  output: string,
  isError: boolean,
  fallbackOutput = output,
): Promise<string> {
  if (
    origin.preToolUse === 'skipped-peer-tainted' ||
    origin.hookSnapshot.postHooks.length === 0 ||
    !ctx.options.hookBus
  ) {
    return fallbackOutput
  }
  const decisions = await ctx.options.hookBus.emitToolSnapshot(
    origin.hookSnapshot,
    'post',
    {
      name: 'PostToolUse',
      session: { cwd: origin.effectiveCwd, modelId: origin.modelId },
      tool: {
        name: origin.toolName,
        args: origin.effectiveArgs,
        callId: origin.toolCallId,
        output,
        isError,
      },
      authority: origin.authority,
    },
    { signal: ctx.options.abortSignal },
  )
  return aggregatePostToolUse(decisions).output ?? fallbackOutput
}

function notifyShellResultNoThrow(ctx: HandlerCtx, output: string, isError: boolean): void {
  try {
    ctx.callbacks.onToolResult(ctx.toolCallId, output, isError)
  } catch (error) {
    debugLog('agent.shell-result-notify-error', `${ctx.toolCallId} ${String(error)}`)
  }
}

function appendAndNotifyShellResult(
  ctx: HandlerCtx,
  output: string,
  isError: boolean,
  lease?: FinalObservationLease,
): void {
  appendTrackedMessage(ctx.state, toolResultMessage(ctx.toolCallId, ctx.toolName, output, undefined, isError))
  clearProgressReporter(ctx.toolCallId)
  lease?.ack()
  if (!isManagedMemoryAccess(ctx.toolName, ctx.input, ctx.options.memoryService?.memoryRoot)) {
    notifyShellResultNoThrow(ctx, output, isError)
  }
}

async function commitShellObservation(ctx: HandlerCtx, observation: ShellObservation): Promise<void> {
  const canonicalOutput = formatShellExecutionResult(observation.result)
  const baseOutput = truncateShellResult(ctx, canonicalOutput)
  if (observation.kind === 'running') {
    appendAndNotifyShellResult(ctx, baseOutput, observation.result.isError)
    return
  }

  let settled = false
  try {
    let output = baseOutput
    try {
      output = await runOriginalShellPost(
        ctx,
        observation.lease.origin,
        truncateToolResult(canonicalOutput),
        observation.lease.post.isError,
        baseOutput,
      )
    } catch (error) {
      if (!isAbortError(error, ctx.options.abortSignal)) throw error
      debugLog('agent.shell-post-aborted', observation.lease.claimId)
    }
    if (!observation.result.isError && ctx.toolName === 'shell' && typeof ctx.input.command === 'string') {
      output += await noteForRecentTempFiles(ctx.input.command, observation.result.wallTimeMs, ctx.state.projectCwd)
    }
    appendAndNotifyShellResult(ctx, output, observation.result.isError, observation.lease)
    settled = true
  } finally {
    if (!settled) observation.lease.release()
  }
}

const MAX_VISUAL_CHECKS_WITHOUT_MUTATION = 3
const HARD_VISUAL_CHECK_ATTEMPT_LIMIT = 5

/** ── shellOutput ── */
async function handleShellOutput(ctx: HandlerCtx): Promise<void> {
  if (ctx.input.chars !== undefined && typeof ctx.input.chars !== 'string') {
    throw new TypeError('shellOutput.chars must be a string')
  }
  const chars = typeof ctx.input.chars === 'string' ? ctx.input.chars : ''
  const resize = normalizeTerminalResize(ctx.input.cols, ctx.input.rows)
  const hasInput = chars !== '' || resize !== undefined
  const observation = await ctx.state.shellSessions.interact({
    shellId: typeof ctx.input.shellId === 'string' ? ctx.input.shellId : '',
    toolCallId: ctx.toolCallId,
    chars,
    resize,
    wait: normalizeInteractWait(
      {
        yieldTimeMs: ctx.input.yieldTimeMs as number | undefined,
        block: ctx.input.block as boolean | undefined,
        timeout: ctx.input.timeout as number | undefined,
      },
      hasInput,
    ),
    maxOutputBytes: SHELL_OUTPUT_MAX_BYTES,
    spillMaxInlineBytes: Math.min(
      MAX_TOOL_RESULT_BYTES,
      shellResultMaxBytes(ctx.input.maxOutputTokens as number | undefined),
    ),
    turnAbortSignal: ctx.options.abortSignal,
  })
  await commitShellObservation(ctx, observation)
}

/** ── killShell ── */
async function handleKillShell(ctx: HandlerCtx): Promise<void> {
  const observation = await ctx.state.shellSessions.terminateAndObserve({
    shellId: typeof ctx.input.shellId === 'string' ? ctx.input.shellId : '',
    observerToolCallId: ctx.toolCallId,
    reason: 'kill-tool',
    turnAbortSignal: ctx.options.abortSignal,
  })
  await commitShellObservation(ctx, observation)
}

/** 绕过循环护栏以及 write/shell 执行流水线的手动工具。 */
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  ...createBuiltInToolHandlers(pushToolResult),
  todoWrite: ({ input, toolCallId, state, callbacks }) =>
    handleTodoWrite(input, toolCallId, state, callbacks, pushToolResult),
  enterPlanMode: ({ input, toolCallId, state, options, callbacks }) =>
    handleEnterPlanMode(input, toolCallId, state, options, callbacks, pushToolResult),
  exitPlanMode: ({ input, toolCallId, state, callbacks }) =>
    handleExitPlanMode(input, toolCallId, state, callbacks, pushToolResult),
  shellOutput: handleShellOutput,
  killShell: handleKillShell,
}

/** 为不绕过护栏的工具运行循环护栏机制。若工具被阻止则返回 true（调用方应停止
 *  分发）。
 *
 *  自动执行的工具从不会走到这条路径——`processToolCalls` 会更早地跳过它们，
 *  因为其结果已经通过 SDK 的 `response.messages` 在 `state.messages` 里了；在这里
 *  重跑循环护栏会把合成结果叠在其上，或注入一条迭代中途的 user 消息，打破严格
 *  提供方要求的 assistant→tool 顺序。
 *
 *  `deferred` 收集必须落在本迭代工具结果之后的消息——在循环中途推入它们会造出
 *  `assistant → tool A → user → tool B` 的模式，DeepSeek 会因此返回 400。 */
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`
  // 手动工具——通过合成结果短路。工具体永不运行；无副作用，无权限提示。
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  if (loopCheck.kind === 'hard-block') {
    const answer = await callbacks
      .onAskUser(`The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`, [
        { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
        { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
      ])
      .catch(() => 'Pause')
    if (answer.toLowerCase().startsWith('pause')) {
      // 清空最近调用窗口，这样如果模型在用户引导下用相同参数合理地再试一次，
      // 护栏不会在下一轮立即再次触发。
      state.recentToolCalls = []
      // 推迟到迭代之后，这样这条 user 角色消息落在本轮消息的末尾，而不是在
      // 工具结果之间。
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
      })
    }
  }
  return true
}

/** 一个模型可见的调用，背后是若干私有的 Playwright 调用。只有最终截图和
 *  受限的 console 诊断进入上下文。 */
async function applyVisualCheckGuard(ctx: HandlerCtx): Promise<boolean> {
  const { toolCallId, toolName, state, callbacks } = ctx
  state.visualCheckCallsSinceMutation++
  if (state.visualCheckCallsSinceMutation <= MAX_VISUAL_CHECKS_WITHOUT_MUTATION) return false

  pushToolResult(
    state,
    callbacks,
    toolCallId,
    toolName,
    `[visual-check-guard] ${MAX_VISUAL_CHECKS_WITHOUT_MUTATION} visual checks have already run without a ` +
      'successful file change. Modify the implementation before capturing again, or ask the user for direction.',
    true,
  )
  if (state.visualCheckCallsSinceMutation !== HARD_VISUAL_CHECK_ATTEMPT_LIMIT) return true

  const answer = await callbacks
    .onAskUser(
      'The model keeps requesting screenshots without changing the implementation. How do you want to proceed?',
      [
        { label: 'Pause', description: 'Pause visual checks until your next instruction.' },
        { label: 'Continue', description: 'Allow up to three more visual checks.' },
      ],
    )
    .catch(() => 'Pause')
  if (answer.toLowerCase().startsWith('continue')) {
    state.visualCheckCallsSinceMutation = 0
  } else {
    // 这是真正的控制流停止，不是面向模型的建议。外层 agent loop 在所有必需
    // 工具结果配对之后观察到它，并返回提示词，不再消耗另一轮模型。
    ctx.control.stopTurn = true
  }
  return true
}

async function handleBrowserVisualCheck(ctx: HandlerCtx): Promise<void> {
  const { toolCallId, toolName, state, options, callbacks } = ctx
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'Browser visual checks are disabled in plan mode. Call exitPlanMode first if you need to verify the UI.',
      true,
    )
    return
  }
  if (options.browserVisualCheckEnabled === false) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Automatic local visual checks are disabled.', true)
    return
  }
  if (await applyVisualCheckGuard(ctx)) return

  reportProgress(toolCallId, 'Capturing local UI screenshot')
  try {
    const result = await runBrowserVisualCheck(ctx.input, {
      abortSignal: options.abortSignal,
    })
    const delivered = await deliverToolImages(ctx, result.text, result.images, {
      captionPrompt: VISUAL_CHECK_CAPTION_PROMPT,
      maxOutputTokens: 400,
      unavailableFallback:
        'No visual assessment was produced because browserVisualCheck does not return an accessibility snapshot. ' +
        'Configure a vision provider, or use the browser sub-agent for accessibility-tree inspection.',
    })
    await pushSuccessfulToolResult(ctx, truncateToolResult(delivered.text), false, delivered.images)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** writeFile/edit/shell 的权限门。若应继续执行则返回 true，若被阻止 / 拒绝 /
 *  中止则返回 false。 */
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  if (ctx.authorityApprovedOnce && state.executionAuthority.peerTainted) return true

  if (isManagedMemoryMutation(toolName, input, options.memoryService?.memoryRoot)) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'Managed memory is written by the private post-turn service. Do not use general file or shell tools for remember, update, or forget requests; finish the response normally.',
      true,
      undefined,
      false,
    )
    return false
  }

  // 分发器已证明此路径等于 currentPlanPath。计划文件编辑本身就是规划的一部分，
  // 无需第二次对话框。
  if (state.permissionMode === 'plan' && (toolName === 'writeFile' || toolName === 'edit')) return true

  if (toolName === 'shell') {
    const command = typeof input.command === 'string' ? input.command : ''
    const shellCommands = splitShellCommands(command)
    if (options.shellReadOnlyOnly && (shellCommands.length === 0 || !shellCommands.every(isReadOnly))) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        'Shell command denied by read-only sub-agent policy. Use a non-emitting read-only alternative (for example, tsc --noEmit instead of tsc -b).',
        true,
      )
      return false
    }
    const deniedKeyword = findDeniedShellKeyword(command, options.shellRestrictions)
    if (deniedKeyword) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        `Shell command denied by sub-agent restriction: ${deniedKeyword}`,
        true,
      )
      return false
    }
  }

  const { approved, feedback } = await checkPermissionDetailed(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    state.projectCwd,
    toolName === 'shell' ? ctx.preparedShell?.effectiveCwd : undefined,
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, permissionDeniedMessage(feedback))
    return false
  }
  return true
}

/** 拒绝时的工具结果文本。当用户通过“否，并告诉 X-Code 该怎么做”拒绝时，他们
 *  输入的反馈会一并携带，这样模型能调整下一次尝试（kimi-cli 的 reject-with-feedback
 *  语义），而不是重试一个几乎相同的调用。 */
function permissionDeniedMessage(feedback?: string): string {
  const trimmed = feedback?.trim()
  return trimmed ? `Permission denied by user. User feedback: ${trimmed}` : 'Permission denied by user.'
}

function findDeniedShellKeyword(command: string, restrictions: readonly string[] | undefined): string | null {
  if (!restrictions?.length) return null
  const lowerCommand = command.toLowerCase()
  return restrictions.find((keyword) => keyword.trim() && lowerCommand.includes(keyword.toLowerCase())) ?? null
}

/** 运行 writeFile/edit/shell 底层带副作用的工具体。自动执行的工具会提前返回，
 *  因为 AI SDK 已经产生了其结果。返回执行后的 { output, isError } 对，或当没有
 *  可推入内容（自动执行）时返回 null。 */
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{
  output: string
  isError: boolean
  structuredOutput?: unknown
  shellObservation?: ShellObservation
} | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      let trackedPath: string | null = null
      const beforeWrite = async (filePath: string) => {
        const absPath = path.resolve(state.projectCwd, filePath)
        await captureFileBeforeMutation(state, absPath, state.projectCwd, options.abortSignal)
        state.filesModified.add(absPath)
        state.checkpointFileCache.delete(absPath)
        trackedPath = absPath
      }
      const output = await executeWriteTool(toolName, input, toolCallId, callbacks, options.abortSignal, beforeWrite)
      // executeWriteTool 对带内失败（未匹配、匹配不唯一）返回 "Error: ..." 字符串
      // 而不是抛错——把那些作为错误结果暴露出来，让滚动回显行变红。
      const isError = isToolErrorString(output)
      if (!isError && trackedPath) {
        state.turnFilesModified.add(trackedPath)
        state.visualCheckCallsSinceMutation = 0
      }
      return { output, isError }
    }
    if (toolName === 'shell') {
      if (!ctx.preparedShell) throw new Error('Shell request was not safely prepared')
      // 拦截 sed -i：在进程内模拟这次编辑，使被修改的文件进入 filesModified，
      // 并被 /rewind checkpoint 覆盖。解析失败或 IO 错误时回退到真正的 shell 执行。
      const command = ctx.preparedShell.command
      const sedInfo = parseSedEditCommand(command)
      if (sedInfo) {
        const absPath = path.isAbsolute(sedInfo.filePath)
          ? sedInfo.filePath
          : path.join(ctx.preparedShell.effectiveCwd, sedInfo.filePath)
        try {
          const original = await fs.readFile(absPath, { encoding: 'utf-8', signal: options.abortSignal })
          const newContent = applySedSubstitution(original, sedInfo)
          if (original !== newContent) {
            await captureFileBeforeMutation(state, absPath, state.projectCwd, options.abortSignal)
            state.filesModified.add(absPath)
            state.checkpointFileCache.delete(absPath)
            await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: options.abortSignal })
            state.turnFilesModified.add(absPath)
            state.visualCheckCallsSinceMutation = 0
          }
          return { output: 'Done', isError: false }
        } catch {
          // 文件不可读或不可写——回退到真正的 sed
        }
      }

      reportProgress(toolCallId, 'Running command...')
      const shellObservation = await state.shellSessions.start({
        prepared: ctx.preparedShell,
        originToolCallId: toolCallId,
        hookOrigin: createShellHookOrigin(ctx),
        turnAbortSignal: options.abortSignal,
      })
      return { output: '', isError: shellObservation.result.isError, shellObservation }
    }
    const manualExecutor = state.manualToolExecutors.get(toolName)
    if (manualExecutor) {
      const value = await manualExecutor(input, { toolCallId, abortSignal: options.abortSignal })
      if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'content') {
        const parts = (value as { value?: unknown[] }).value ?? []
        const output = parts
          .filter((part): part is { type: 'text'; text: string } =>
            Boolean(
              part &&
              typeof part === 'object' &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
            ),
          )
          .map((part) => part.text)
          .join('\n')
        return { output: output || '[Structured content returned]', isError: false, structuredOutput: value }
      }
      const output = typeof value === 'string' ? value : JSON.stringify(value)
      return { output: output ?? '', isError: false }
    }
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

/** 处理单个工具调用。当调用被完整分发后返回。`parentModel` 是当前循环的
 *  LanguageModel 实例——task 工具在子 agent 未覆盖时要用它作为回退传入。
 *  `deferred` 是传给 `applyLoopGuard` 的每轮延迟消息队列；这里收集的消息会在
 *  `processToolCalls` 里整个迭代之后被刷写。 */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  runSubAgentLoop: SubAgentLoopRunner | undefined,
  deferred: ModelMessage[],
  control: ToolExecutionControl,
): Promise<void> {
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    parentModel,
    runSubAgentLoop,
    control,
  }

  // 把相对写入目标锚定到 projectCwd，让权限检查、checkpoint 快照与实际的 fs
  // 写入都作用于同一文件。工具 schema 要求绝对路径，但没有任何东西强制它——
  // 相对路径以前写的是 process.cwd()，而 beforeWrite 追踪的是
  // path.resolve(projectCwd, filePath)，所以只要两者不同，/rewind 就捕获错文件。
  if (
    (ctx.toolName === 'writeFile' || ctx.toolName === 'edit') &&
    typeof ctx.input.filePath === 'string' &&
    ctx.input.filePath !== '' &&
    !path.isAbsolute(ctx.input.filePath)
  ) {
    ctx.input = { ...ctx.input, filePath: path.resolve(ctx.state.projectCwd, ctx.input.filePath) }
  }

  if (!enforcePlanModeBoundary(ctx)) return

  // ── 插件钩子：PreToolUse ──
  // 在旁路处理器路由之前、MCP 分发之前触发，这样钩子能看到模型尝试的每一个工具
  //（包括 askUser、task 和 MCP 工具）。deny 变成模型可见的合成 tool_result，
  // 保持 state.messages 有效。modify 可以重写输入记录（在 ctx.input 上就地修改，
  // 让下游处理器与循环护栏看到修改后的参数）。
  try {
    if (ctx.toolName === 'shell') {
      if (!(await prepareShellRequest(ctx))) return
    } else if (
      ctx.toolName !== 'shellOutput' &&
      ctx.toolName !== 'killShell' &&
      !ctx.state.executionAuthority.peerTainted &&
      ctx.options.hookBus?.has('PreToolUse')
    ) {
      try {
        const decisions = await ctx.options.hookBus.emit(
          {
            name: 'PreToolUse',
            session: { cwd: ctx.state.projectCwd, modelId: ctx.options.modelId },
            tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId },
            authority: ctx.state.executionAuthority,
          },
          { signal: ctx.options.abortSignal },
        )
        const effect = aggregatePreToolUse(decisions)
        if (effect.decision === 'deny') {
          const reason = effect.reason ?? 'blocked by plugin hook'
          pushToolResult(
            state,
            callbacks,
            ctx.toolCallId,
            ctx.toolName,
            toolErrorString(`Tool denied by plugin hook: ${reason}`),
            true,
          )
          return
        }
        if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
          ctx.input = effect.args as Record<string, unknown>
        }
      } catch (err) {
        if (ctx.options.abortSignal?.aborted) {
          pushToolResult(state, callbacks, ctx.toolCallId, ctx.toolName, '[Tool execution interrupted by user]', true)
          return
        }
        debugLog('agent.hook-pre-tool-error', String(err))
      }
    }

    enrichShellTransportInput(ctx)

    if (ctx.toolName === 'edit') {
      try {
        ctx.input = normalizedEditRecord(normalizeEditInput(ctx.input))
      } catch (err) {
        pushToolResult(state, callbacks, ctx.toolCallId, ctx.toolName, toolErrorFromUnknown(err), true)
        return
      }
    }

    normalizeMcpToolInput(ctx)
    if (ctx.toolName === 'sendMessage') {
      const service = ctx.options.peerService
      if (!service?.enabled) {
        pushToolResult(
          state,
          callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString('Peer messaging is disabled'),
          true,
        )
        return
      }
      try {
        ctx.preparedPeerSend = await service.prepareSend(
          String(ctx.input.to ?? ''),
          String(ctx.input.message ?? ''),
          typeof ctx.input.summary === 'string' ? ctx.input.summary : undefined,
          typeof ctx.input.messageId === 'string' ? ctx.input.messageId : undefined,
          options.abortSignal,
        )
        ctx.input = {
          ...ctx.input,
          _receiverInstanceId: ctx.preparedPeerSend.receiverInstanceId,
          _receiverAddress: ctx.preparedPeerSend.receiverAddress,
        }
      } catch (error) {
        pushToolResult(state, callbacks, ctx.toolCallId, ctx.toolName, toolErrorFromUnknown(error), true)
        return
      }
    }
    if (!(await checkCentralAuthority(ctx))) return

    if (ctx.toolName === BROWSER_VISUAL_CHECK_TOOL_NAME) {
      await handleBrowserVisualCheck(ctx)
      return
    }

    const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
    if (bypassHandler) {
      await bypassHandler(ctx)
      return
    }

    // MCP 工具走它们自己的权限路径（逐工具询问 + always-allow 文件），而不是
    // writeFile/edit/shell 规则。它们仍要经过循环护栏，让模型不能无限地对一个
    // 失败的 MCP 调用空转。
    //
    // 路由依据注册表查找，而不是名称模式：MCP 工具名是 `<server>__<tool>`
    //（没有特殊前缀），所以“这是不是 MCP？”的唯一权威答案是“它是否注册在
    // MCP 注册表里？”。
    if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
      await handleMcpToolCall(ctx, deferred)
      return
    }

    if (await applyLoopGuard(ctx, deferred)) return
    if (!(await checkWriteOrShellPermission(ctx))) return

    const result = await executeWriteOrShell(ctx)
    if (result == null) return

    if (result.shellObservation) {
      await commitShellObservation(ctx, result.shellObservation)
      return
    }

    if (result.structuredOutput !== undefined) {
      appendTrackedMessage(state, structuredToolResultMessage(ctx.toolCallId, ctx.toolName, result.structuredOutput))
      clearProgressReporter(ctx.toolCallId)
      callbacks.onToolResult(ctx.toolCallId, truncateToolResult(result.output), result.isError)
      return
    }

    await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
  } catch (error) {
    pushToolResult(
      state,
      callbacks,
      tc.toolCallId,
      tc.toolName,
      isAbortError(error, options.abortSignal) ? '[Tool execution interrupted by user]' : toolErrorFromUnknown(error),
      true,
    )
  }
}

const PLAN_MODE_EXECUTABLE_TOOLS = new Set([
  'readFile',
  'glob',
  'grep',
  'listDir',
  'webSearch',
  'webFetch',
  'askUser',
  'writeFile',
  'edit',
  'exitPlanMode',
])

function sameResolvedPath(left: string, right: string): boolean {
  const a = path.normalize(resolvePhysicalPath(left))
  const b = path.normalize(resolvePhysicalPath(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 针对过期历史、插件调用与直接分发器使用的纵深防御。工具可见性是 Plan 的
 *  主要边界；这一检查让它成为运行时不变式，即使某个隐藏调用到达分发器。 */
function enforcePlanModeBoundary(ctx: HandlerCtx): boolean {
  if (ctx.state.permissionMode !== 'plan') return true
  if (!PLAN_MODE_EXECUTABLE_TOOLS.has(ctx.toolName)) {
    pushToolResult(
      ctx.state,
      ctx.callbacks,
      ctx.toolCallId,
      ctx.toolName,
      toolErrorString(`tool ${ctx.toolName} is unavailable in plan mode`),
      true,
    )
    return false
  }
  if (ctx.toolName !== 'writeFile' && ctx.toolName !== 'edit') return true

  const target = typeof ctx.input.filePath === 'string' ? ctx.input.filePath : ''
  const planPath = ctx.state.currentPlanPath
  const planRoot = path.join(ctx.state.projectCwd, XCODE_DIR, 'plans')
  if (
    !target ||
    !planPath ||
    !isPathWithinProject(planRoot, ctx.state.projectCwd) ||
    !isPathWithinProject(planPath, planRoot) ||
    !sameResolvedPath(path.resolve(ctx.state.projectCwd, target), planPath)
  ) {
    pushToolResult(
      ctx.state,
      ctx.callbacks,
      ctx.toolCallId,
      ctx.toolName,
      toolErrorString('plan mode may only modify the current session plan file'),
      true,
    )
    return false
  }
  return true
}

/** 分发一个 MCP 工具调用。与上方的 writeFile/edit/shell 流水线并行——同样的
 *  循环护栏、同样的中止处理，但使用逐工具权限存储和 MCP 注册表的 callTool。 */
async function handleMcpToolCall(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<void> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  const permissions = options.mcpPermissionStore

  if (!registry) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`MCP not configured; tool ${toolName} unavailable`),
      true,
    )
    return
  }

  const entry = registry.get(toolName)
  if (!entry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString(`MCP tool not found: ${toolName}`), true)
    return
  }

  // 循环护栏优先：即使是被模式拒绝的调用，也算模型“尝试”了某事，我们也要
  // 抓住拒绝的循环。
  if (await applyLoopGuard(ctx, deferred)) return

  // Plan 模式：MCP 工具是不透明的（我们不知道它们是否会写入），所以唯一安全
  // 的立场是“否”。模型会把拒绝视为工具结果；如果它确实需要外部工具才能继续，
  // 应该调用 exitPlanMode。
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'MCP tools are disabled in plan mode. Call exitPlanMode first if you need this tool.',
      true,
    )
    return
  }

  // 一个受 peer 影响的 allow-once 决定，是唯一适用于此调用的批准。绝不查询
  // 或更新旧版 MCP 权限存储。
  if (ctx.authorityApprovedOnce && state.executionAuthority.peerTainted) {
    await executeApprovedMcpTool(ctx, entry)
    return
  }

  // 权限门。trustMode 绕过一切；否则查询存储（会话 + 持久化），并回退到询问用户。
  let approved = options.trustMode
  if (!approved && permissions) approved = await permissions.isApproved(toolName)

  if (!approved) {
    let decision: PermissionDecision
    try {
      decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    } catch (err) {
      if (isAbortError(err, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      throw err
    }
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    const choice = classifyDecision(decision)
    if (choice === 'deny') {
      const feedback = typeof decision === 'object' ? decision.feedback : undefined
      pushToolResult(state, callbacks, toolCallId, toolName, permissionDeniedMessage(feedback))
      return
    }
    if (permissions) {
      if (choice === 'allow-always') await permissions.approvePermanently(toolName)
      else permissions.approveForSession(toolName)
    }
  }

  await executeApprovedMcpTool(ctx, entry)
}

function normalizeMcpToolInput(ctx: HandlerCtx): void {
  const entry = ctx.options.mcpRegistry?.get(ctx.toolName)
  if (!entry || !ctx.input || typeof ctx.input !== 'object') return
  const args = ctx.input
  if (entry.rawName === 'browser_snapshot' || entry.rawName === 'browser_take_screenshot') delete args.filename
  if (entry.rawName === 'browser_take_screenshot') {
    args.type = 'jpeg'
    delete args.fullPage
  }
}

async function executeApprovedMcpTool(
  ctx: HandlerCtx,
  entry: NonNullable<ReturnType<NonNullable<AgentOptions['mcpRegistry']>['get']>>,
): Promise<void> {
  const { toolName, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
  try {
    const result = await registry.callTool(toolName, ctx.input, options.abortSignal)
    const delivered = await deliverToolImages(ctx, result.text, result.images)
    await pushSuccessfulToolResult(ctx, truncateToolResult(delivered.text), result.isError, delivered.images)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** 收集 AI SDK 在本轮真正提交到 assistant 消息里的每个 toolCallId。SDK 的
 *  `result.toolCalls` promise 独立于 `response.messages`——当 zod 校验在流中途
 *  拒绝一个格式错误的工具输入时，SDK 会发一个 `tool-error` 块，并把该 tool_call
 *  从 response.messages 排除，但它仍可能出现在 `toolCalls` 里。运行这样一个
 *  “幽灵”调用会有两个坏结果：
 *    1. write/edit/shell 会为模型从未正式提交的调用触发真实的副作用。
 *    2. 推入的 tool_result 会成为 state.messages 里的孤儿（没有带该 id 的前置
 *       assistant tool_call），下一次 API 请求会以 "tool must be a response to
 *       a preceding message with tool_calls" 报 400。
 *  返回这个集合让 `processToolCalls` 能在任何处理器运行之前过滤 SDK 的列表。
 *
 *  从 state.messages 末尾往前遍历，收集遇到的每一条 assistant 消息里的 tool-call
 *  id，直到碰到非 assistant/tool 的边界——覆盖某些提供方产生的多 assistant 轮次
 *  结构，同时在前一条 user 消息处切断，让旧轮次的 id 不渗入。 */
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 收集当前轮次 state.messages 窗口中已有 tool-result 消息的 tool_call_id。
 *  有两条不同的上游路径会在 `processToolCalls` 运行之前把结果放到这里：
 *    1. AI SDK 自动执行的工具（readFile / glob / grep / listDir / webFetch /
 *       webSearch）——其结果在 `response.messages` 里，在我们迭代之前由
 *       `collectTurnResponse` 推入。
 *    2. AI SDK 对不可用工具的自动拒绝——当子 agent 的 toolFilter 排除了某个工具，
 *       而模型仍为它发出 tool-call（例如 `general-purpose` agent 调用 `writeFile`）
 *       时，SDK 会合成一个 `error-text` tool-result，让 assistant 消息不会留下
 *       一个孤儿 tool-call。
 *  两种情况下在这里重跑工具都是错的：
 *    - 对 (1)，工具已经执行过了；再跑一次会重复副作用（重新抓取网页、重新触发
 *      saveKnowledge）。
 *    - 对 (2)，工具在该 agent 的过滤器中本就不该运行，但 `executeWriteTool`
 *      按名称分发，会欣然触发 writeFile，既产生真实副作用，又推入一个重复的
 *      tool-result，DeepSeek 下一轮会因此报 400。
 *  与 collectActiveAssistantToolCallIds 相同的轮次边界逻辑——从消息末尾往回走，
 *  在第一条 user 消息处停下。 */
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 把连续的 `task` 工具调用归为一批，使它们能并行分发；其他一切都各自成批、
 *  逐个分发。由 `task` 工具启动的子 agent，是我们在 `processToolCalls` 中手工
 *  执行、且真正隔离的唯一手动工具：
 *    - 每个 `runSubAgent` 构建全新的 `LoopState`（自己的消息、自己的
 *      `recentToolCalls`、自己的 todos、自己的权限模式）
 *    - `parentState.tokenUsage` 只在子 agent 完成后通过加法累加更新，因此并发
 *      更新不会被撕裂（单线程事件循环 + 普通的 `+=` 写）
 *    - 并发子 agent 的权限对话框自然地排在父 UI 的 `permissionResolversRef` 上
 *  其他每个手动工具都修改共享状态，必须保持串行：
 *    - `writeFile` / `edit` 修改文件系统和 `state.filesModified`
 *    - `shell` 把 stdout/stderr 边到边流式写到父 UI——并发 shell 交错的字节
 *      会弄乱实时指示器
 *    - `askUser` / 权限对话框占用 UI；同时跑两个会让对话框状态机竞态
 *    - `todoWrite` / `enterPlanMode` / `exitPlanMode` 修改下一轮要读取的
 *      `LoopState` 字段
 *  自动执行的工具（readFile / glob / grep / listDir / webFetch / webSearch）
 *  不会出现在这里——到 `processToolCalls` 运行时，SDK 已经执行了它们，跳过
 *  已满足的预过滤会把它们短路掉。 */
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

/** 处理单个模型轮次的所有工具调用。
 *
 *  连续的 `task` 工具调用通过 Promise.all 并行分发；其他每个工具一次跑一个。
 *  关于为什么只有子 agent 可以安全地扇出，完整理由见 `partitionToolCalls`。
 *
 *  `parentModel` 被一路传递，这样 task 工具能把它传给 `runSubAgent`。 */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  runSubAgentLoop?: SubAgentLoopRunner,
): Promise<{ stopTurn: boolean }> {
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)
  // 每轮队列，用于那些必须落在本循环推入的每个 tool-result 之后的消息。在两条
  // tool-result 之间推入一条 `role: 'user'` 消息，会造出 DeepSeek 严格顺序拒绝的
  // 形状——我们在这里收集它们，并在循环末尾刷写。
  const deferred: ModelMessage[] = []
  const control: ToolExecutionControl = { stopTurn: false }

  // 预过滤：丢弃幽灵调用，并统计已满足的调用。存活下来的进入 `liveCalls`，
  // 那才是我们真正分发的内容。在分区之前做这一步，让并行批次分发保持简单——
  // 批次里的每个条目都是我们需要运行的真实调用。
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // 跳过 SDK 在流中途拒绝的幽灵调用——完整理由见
    // collectActiveAssistantToolCallIds。也不要 pushToolResult：assistant 消息
    // 没有匹配的 tool_call，所以我们发出的任何结果都会成为孤儿，反正 sanitizer
    // 下一轮也会丢弃。双重保险：即使这个检查放过了某个，sanitizer 的反向孤儿
    // 分支也仍会清理。
    if (!activeIds.has(tc.toolCallId)) {
      debugLog(
        'tool-exec.skip-ghost',
        `${tc.toolName} ${tc.toolCallId} — not in assistant tool_calls, likely SDK tool-error reject`,
      )
      continue
    }

    // 跳过已满足的调用——见 collectFulfilledToolCallIds。仍在循环护栏窗口里记录
    // 这次调用，这样同一自动执行工具上的失控模式能在未来轮次被熔断；如果护栏
    // 触发，就把 user 角色的提醒推迟到迭代之后。
    if (fulfilledIds.has(tc.toolCallId)) {
      debugLog('tool-exec.skip-fulfilled', `${tc.toolName} ${tc.toolCallId} — tool-result already in state.messages`)
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId)
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash)
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // 按批次分发。大小为 1 的批次在功能上与普通 `await handleToolCall(...)` 相同
  // ——对单个 promise 做 Promise.all 的解析方式一样——因此并行路径统一处理两种
  // 情况。
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // 用户按了 Esc / Ctrl+C。一个已到达 ready 的受管 shell 仍作为后台会话可用；
    // 其他工具收到中止。对每个剩余 tool_call，我们仍要推入一个合成 tool_result——
    // 没有匹配结果的孤儿 tool_call 会在用户再输入一条提示词的瞬间，让下一次
    // API 请求以 "tool_use without tool_result" 失败。
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    await Promise.all(
      batch.map((tc) => handleToolCall(tc, state, options, callbacks, parentModel, runSubAgentLoop, deferred, control)),
    )
    dispatched += batch.length
    if (control.stopTurn) {
      // 即使用户在后续调用分发前暂停，也为严格提供方保留 assistant tool_call ->
      // tool_result 配对。
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution skipped because the user paused the current turn]',
          true,
        )
      }
      break
    }
  }

  // 在本轮所有 tool_result 之后刷写延迟消息——它们位于 state.messages 最末尾，
  // 下一次 runTurn 会把它们视为最新上下文，但它们不会破坏 SDK 将向提供方重放的
  // assistant→tool 顺序。
  if (!control.stopTurn && deferred.length > 0) state.messages.push(...deferred)
  return { stopTurn: control.stopTurn }
}
