/**
 * Runtime utility process.
 *
 * Owns everything that needs Node: the agent loop, native modules, PTY
 * sessions, sessions, and approvals. It talks to the Electron main process over
 * `process.parentPort`; main relays messages to the sandboxed renderer.
 */
import { setDocumentRenderers } from '@x-code-cli/core'

import type {
  RuntimeEvent,
  RuntimeInbound,
  RuntimeOutbound,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/protocol.js'
import { AgentHost } from './agent-host.js'
import { applyDocumentHunks, documentDiff, saveCurrentBaseline } from './document-review.js'
import {
  forgetDocumentOcr,
  loadDocumentPages,
  ocrDocumentPage,
  openDocumentView,
  recentDocuments,
} from './document-view.js'
import { handleMainResponse, initMainBridge, requestMain } from './main-bridge.js'
import { savePastedImage } from './pasted-images.js'
import { ShellManager } from './shell.js'
import { runSmoke } from './smoke.js'

interface ParentPortLike {
  postMessage(message: RuntimeOutbound): void
  on(event: 'message', listener: (event: { data: RuntimeInbound }) => void): void
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (!parentPort) {
  throw new Error('desktop runtime must be started as an Electron utilityProcess')
}
const port: ParentPortLike = parentPort

// Core's audio runner uses child_process.fork(), which would otherwise launch
// another Electron app instead of a Node worker. Child processes inherit this
// flag and run as Node.
process.env.ELECTRON_RUN_AS_NODE = '1'

function sendEvent(event: RuntimeEvent): void {
  port.postMessage({ kind: 'event', event })
}

function ok(id: string, result: unknown): RuntimeResponse {
  return { id, ok: true, result }
}

function fail(id: string, code: string, message: string): RuntimeResponse {
  return { id, ok: false, error: { code, message } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  const message = errorMessage(error)
  if (message === 'turn-busy') return 'turn-busy'
  if (message === 'runtime-not-initialized') return 'not-ready'
  if (message === 'no-model-configured') return 'no-model'
  if (message.startsWith('session-not-found')) return 'session-not-found'
  if (message.startsWith('no-shell')) return 'no-shell'
  return 'request-failed'
}

const host = new AgentHost(sendEvent, {
  workspace: process.env.X_CODE_WINDOW_WORKSPACE?.trim() || undefined,
})
const shells = new ShellManager(sendEvent)

let initialization: Promise<unknown> | null = null

function ensureInitialized(): Promise<unknown> {
  if (!initialization) {
    initialization = host.init().catch((error) => {
      initialization = null
      sendEvent({ type: 'runtime:log', level: 'error', message: `bootstrap failed: ${errorMessage(error)}` })
      throw error
    })
  }
  return initialization
}

async function handleRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    switch (request.method) {
      case 'agent:submit': {
        await ensureInitialized()
        return ok(request.id, await host.submit(request.params.prompt, request.params.attachments))
      }
      case 'agent:abort':
        return ok(request.id, host.abort())
      case 'agent:set-task-mode': {
        await ensureInitialized()
        return ok(request.id, host.setTaskMode(request.params.mode))
      }
      case 'agent:set-thinking': {
        await ensureInitialized()
        return ok(request.id, host.setThinking(request.params.enabled))
      }
      case 'agent:set-permission-mode': {
        await ensureInitialized()
        return ok(request.id, host.setPermissionMode(request.params.mode))
      }
      case 'agent:compact': {
        await ensureInitialized()
        return ok(request.id, await host.compactConversation())
      }
      case 'context:stats': {
        await ensureInitialized()
        return ok(request.id, host.contextStats())
      }
      case 'usage:summary': {
        await ensureInitialized()
        return ok(request.id, host.usageSummary())
      }
      case 'usage:history': {
        await ensureInitialized()
        return ok(request.id, await host.usageHistoryReport())
      }
      case 'memory:get': {
        await ensureInitialized()
        return ok(request.id, host.memoryReport())
      }
      case 'memory:panel': {
        await ensureInitialized()
        return ok(request.id, await host.memoryPanelView())
      }
      case 'memory:topic': {
        await ensureInitialized()
        return ok(request.id, await host.memoryTopic(request.params.id))
      }
      case 'memory:save-topic': {
        await ensureInitialized()
        return ok(request.id, await host.saveMemoryTopic(request.params.id, request.params.content))
      }
      case 'memory:delete-topic': {
        await ensureInitialized()
        return ok(request.id, await host.deleteMemoryTopic(request.params.id))
      }
      case 'memory:reload': {
        await ensureInitialized()
        return ok(request.id, await host.reloadMemory())
      }
      case 'commands:list': {
        await ensureInitialized()
        return ok(request.id, host.listCommands())
      }
      case 'commands:detail': {
        await ensureInitialized()
        return ok(request.id, host.commandDetail(request.params.name))
      }
      case 'commands:run': {
        await ensureInitialized()
        return ok(request.id, host.runCommand(request.params.name, request.params.args))
      }
      case 'commands:save': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.saveCommand({
            name: request.params.name,
            description: request.params.description,
            body: request.params.body,
            scope: request.params.scope,
          }),
        )
      }
      case 'commands:delete': {
        await ensureInitialized()
        return ok(request.id, await host.deleteCommand(request.params.name, request.params.scope))
      }
      case 'hooks:get': {
        await ensureInitialized()
        return ok(request.id, host.hooksView())
      }
      case 'hooks:save': {
        await ensureInitialized()
        return ok(request.id, await host.saveHooks(request.params.scope, request.params.config))
      }
      case 'hooks:trust-project': {
        await ensureInitialized()
        return ok(request.id, await host.setProjectHooksTrusted(request.params.trusted))
      }
      case 'files:list': {
        await ensureInitialized()
        return ok(request.id, await host.listFiles(request.params.path))
      }
      case 'files:read': {
        await ensureInitialized()
        return ok(request.id, await host.readWorkspaceFile(request.params.path))
      }
      case 'files:write': {
        await ensureInitialized()
        return ok(request.id, await host.writeWorkspaceFile(request.params.path, request.params.content))
      }
      case 'files:create': {
        await ensureInitialized()
        return ok(request.id, await host.createWorkspaceFile(request.params.path, request.params.content))
      }
      case 'doctor:run': {
        await ensureInitialized()
        return ok(request.id, await host.doctorReport())
      }
      case 'shell:list': {
        await ensureInitialized()
        return ok(request.id, host.shellListReport())
      }
      case 'agents:list': {
        await ensureInitialized()
        return ok(request.id, host.agentsReport())
      }
      case 'goal:get': {
        await ensureInitialized()
        return ok(request.id, host.goalReport())
      }
      case 'app:state': {
        await ensureInitialized()
        return ok(request.id, host.getState())
      }
      case 'app:save-pasted-image':
        return ok(request.id, savePastedImage(request.params.data, request.params.mime))
      case 'audio:transcribe': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.transcribeRecording(request.params.data, request.params.mime, request.params.language),
        )
      }
      case 'background:list': {
        await ensureInitialized()
        return ok(request.id, { sessions: host.backgroundSessions() })
      }
      case 'background:stop': {
        await ensureInitialized()
        return ok(request.id, await host.stopBackgroundShell(request.params.shellId))
      }
      case 'models:set': {
        await ensureInitialized()
        return ok(request.id, host.setModel(request.params.modelId))
      }
      case 'models:discover': {
        await ensureInitialized()
        return ok(request.id, await host.discoverLocal())
      }
      case 'session:list': {
        await ensureInitialized()
        return ok(request.id, await host.listSessions())
      }
      case 'session:load': {
        await ensureInitialized()
        return ok(request.id, await host.loadSession(request.params.filePath))
      }
      case 'session:salvage': {
        await ensureInitialized()
        return ok(request.id, await host.salvageSession(request.params.filePath))
      }
      case 'session:new': {
        await ensureInitialized()
        return ok(request.id, host.newSession())
      }
      case 'session:rename': {
        await ensureInitialized()
        return ok(request.id, await host.renameSession(request.params.filePath, request.params.name))
      }
      case 'session:delete': {
        await ensureInitialized()
        return ok(request.id, await host.deleteSession(request.params.filePath))
      }
      case 'session:set-pinned': {
        await ensureInitialized()
        return ok(request.id, host.setSessionPinned(request.params.filePath, request.params.pinned))
      }
      case 'session:set-archived': {
        await ensureInitialized()
        return ok(request.id, host.setSessionArchived(request.params.filePath, request.params.archived))
      }
      case 'session:search': {
        await ensureInitialized()
        return ok(request.id, await host.searchSessions(request.params.query, request.params.limit))
      }
      case 'session:export': {
        await ensureInitialized()
        return ok(request.id, await host.exportSession(request.params.filePath, request.params.format))
      }
      case 'session:checkpoints': {
        await ensureInitialized()
        return ok(request.id, { checkpoints: host.rewindCheckpoints() })
      }
      case 'session:checkpoint-diff': {
        await ensureInitialized()
        return ok(request.id, await host.checkpointDiff(request.params.ckptId))
      }
      case 'session:rewind': {
        await ensureInitialized()
        return ok(request.id, await host.rewind(request.params.ckptId, request.params.mode))
      }
      case 'session:fork': {
        await ensureInitialized()
        return ok(request.id, await host.forkCurrentSession(request.params.name))
      }
      case 'workspace:list': {
        await ensureInitialized()
        return ok(request.id, host.listWorkspaces())
      }
      case 'document:open': {
        await ensureInitialized()
        return ok(
          request.id,
          await openDocumentView(request.params.path, {
            start: request.params.start,
            count: request.params.count,
          }),
        )
      }
      case 'document:pages': {
        await ensureInitialized()
        return ok(request.id, await loadDocumentPages(request.params.path, request.params.start, request.params.count))
      }
      case 'document:ocr-page': {
        await ensureInitialized()
        return ok(request.id, { text: await ocrDocumentPage(request.params.path, request.params.page) })
      }
      case 'document:forget-ocr': {
        await ensureInitialized()
        return ok(request.id, { cleared: forgetDocumentOcr(request.params.path) })
      }
      case 'document:list': {
        await ensureInitialized()
        return ok(request.id, { documents: recentDocuments() })
      }
      case 'document:diff': {
        await ensureInitialized()
        return ok(request.id, { diff: await documentDiff(request.params.path) })
      }
      case 'document:apply-hunks': {
        await ensureInitialized()
        return ok(
          request.id,
          await applyDocumentHunks(request.params.path, request.params.accepted, request.params.hash),
        )
      }
      case 'checks:detect': {
        await ensureInitialized()
        return ok(request.id, { checks: await host.detectChecks() })
      }
      case 'checks:run': {
        await ensureInitialized()
        return ok(request.id, await host.runChecks(request.params.ids, request.params.stopOnFailure !== false))
      }
      case 'checks:status': {
        await ensureInitialized()
        return ok(request.id, host.checksStatus())
      }
      case 'checks:set-auto': {
        await ensureInitialized()
        return ok(request.id, host.setAutoChecks(request.params.enabled))
      }
      case 'git:status': {
        await ensureInitialized()
        return ok(request.id, await host.gitStatusView())
      }
      case 'git:diff': {
        await ensureInitialized()
        return ok(request.id, await host.gitDiff(request.params.path, request.params.staged))
      }
      case 'git:branches': {
        await ensureInitialized()
        return ok(request.id, await host.gitBranchList())
      }
      case 'worktree:open': {
        await ensureInitialized()
        return ok(request.id, await host.openWorktree(request.params.branch, request.params.remoteRef))
      }
      case 'worktree:create': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.createWorktree(request.params.branch, request.params.from, request.params.parentDir),
        )
      }
      case 'worktree:remove': {
        await ensureInitialized()
        return ok(request.id, await host.removeWorktree(request.params.path, request.params.force))
      }
      case 'worktree:prune': {
        await ensureInitialized()
        return ok(request.id, await host.pruneWorktrees())
      }
      case 'git:undo-turn': {
        await ensureInitialized()
        return ok(request.id, await host.undoGitTurn(request.params.turnId))
      }
      case 'edit:revert': {
        await ensureInitialized()
        return ok(request.id, await host.revertEdit(request.params.toolCallId))
      }
      case 'library:stats': {
        await ensureInitialized()
        return ok(request.id, await host.libraryStats())
      }
      case 'library:index': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.libraryIndex(request.params.path, {
            recursive: request.params.recursive,
            semantic: request.params.semantic,
          }),
        )
      }
      case 'library:search': {
        await ensureInitialized()
        return ok(request.id, await host.librarySearch(request.params.query, request.params.limit, request.params.path))
      }
      case 'library:set-semantic': {
        await ensureInitialized()
        return ok(request.id, host.librarySetSemantic(request.params.enabled))
      }
      case 'library:clear': {
        await ensureInitialized()
        return ok(request.id, await host.libraryClear())
      }
      case 'document:save-baseline': {
        await ensureInitialized()
        return ok(request.id, await saveCurrentBaseline(request.params.path))
      }
      case 'workspace:files': {
        await ensureInitialized()
        return ok(request.id, {
          files: await host.listWorkspaceFiles(request.params.query, request.params.limit),
        })
      }
      case 'workspace:switch': {
        await ensureInitialized()
        return ok(request.id, await host.switchWorkspace(request.params.path))
      }
      case 'approval:respond': {
        host.respondApproval(request.params.requestId, request.params.kind, {
          decision: request.params.decision,
          answer: request.params.answer,
          approved: request.params.approved,
        })
        return ok(request.id, null)
      }
      case 'approvals:cancel-all':
        host.cancelAllApprovals()
        return ok(request.id, null)
      case 'settings:get': {
        await ensureInitialized()
        return ok(request.id, await host.getSettings())
      }
      case 'settings:set-api-key': {
        await ensureInitialized()
        return ok(request.id, await host.setApiKey(request.params.provider, request.params.key, request.params.baseUrl))
      }
      case 'settings:clear-api-key': {
        await ensureInitialized()
        return ok(request.id, await host.clearApiKey(request.params.provider))
      }
      case 'settings:set-custom-model': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.setCustomModel(request.params.modelId, request.params.key, request.params.baseUrl),
        )
      }
      case 'settings:set-skill-enabled': {
        await ensureInitialized()
        return ok(request.id, await host.setSkillEnabled(request.params.name, request.params.enabled))
      }
      case 'settings:set-tool-enabled': {
        await ensureInitialized()
        return ok(request.id, await host.setToolEnabled(request.params.name, request.params.enabled))
      }
      case 'settings:set-tool-always-allow': {
        await ensureInitialized()
        return ok(request.id, await host.setToolAlwaysAllow(request.params.name, request.params.enabled))
      }
      case 'settings:set-shell-sandbox': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.setShellSandboxConfig({
            enabled: request.params.enabled,
            allowNetwork: request.params.allowNetwork,
            extensions: request.params.extensions,
          }),
        )
      }
      case 'settings:set-always-allow-all': {
        await ensureInitialized()
        return ok(request.id, await host.setAlwaysAllowAll(request.params.enabled))
      }
      case 'settings:set-context-window': {
        await ensureInitialized()
        return ok(request.id, await host.setContextWindow(request.params.modelId, request.params.tokens))
      }
      case 'permissions:rules': {
        await ensureInitialized()
        return ok(request.id, host.listPermissionRules())
      }
      case 'permissions:add-rule': {
        await ensureInitialized()
        return ok(request.id, host.addPermissionRule(request.params.tool, request.params.type, request.params.pattern))
      }
      case 'permissions:remove-rule': {
        await ensureInitialized()
        return ok(
          request.id,
          host.removePermissionRule(
            request.params.tool,
            request.params.type,
            request.params.pattern,
            request.params.cwd,
          ),
        )
      }
      case 'settings:set-notifications': {
        await ensureInitialized()
        return ok(request.id, await host.setNotifications(request.params.enabled))
      }
      case 'settings:set-onboarded': {
        await ensureInitialized()
        return ok(request.id, await host.setOnboarded(request.params.value))
      }
      case 'storage:usage': {
        await ensureInitialized()
        return ok(request.id, await host.storageUsageView())
      }
      case 'storage:cleanup': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.cleanupStorage({
            sessionsOlderThanDays: request.params.sessionsOlderThanDays,
            attachmentsOlderThanDays: request.params.attachmentsOlderThanDays,
            library: request.params.library,
            whisperModels: request.params.whisperModels,
          }),
        )
      }
      case 'project:settings': {
        await ensureInitialized()
        return ok(request.id, host.projectSettingsView())
      }
      case 'project:save': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.saveProjectSettings({
            modelId: request.params.modelId,
            taskMode: request.params.taskMode,
            autoChecks: request.params.autoChecks,
          }),
        )
      }
      case 'settings:set-update-feed': {
        await ensureInitialized()
        return ok(request.id, await host.setUpdateFeed(request.params.feed))
      }
      case 'settings:test-api-key': {
        await ensureInitialized()
        return ok(
          request.id,
          await host.testConnection(request.params.provider, request.params.key, request.params.baseUrl),
        )
      }
      case 'skills:import': {
        await ensureInitialized()
        return ok(request.id, await host.importSkill(request.params.path))
      }
      case 'skills:install-command': {
        await ensureInitialized()
        return ok(request.id, await host.installSkillCommand(request.params.command))
      }
      case 'plugins:import': {
        await ensureInitialized()
        return ok(request.id, await host.installPluginPath(request.params.path))
      }
      case 'plugins:install-command': {
        await ensureInitialized()
        return ok(request.id, await host.installPluginCommand(request.params.command, request.params.userConfig))
      }
      case 'plugins:preview': {
        await ensureInitialized()
        return ok(request.id, await host.previewPlugin(request.params.target))
      }
      case 'plugins:install': {
        await ensureInitialized()
        return ok(request.id, await host.installPluginConfirmed(request.params.target, request.params.userConfig))
      }
      case 'plugins:user-config': {
        await ensureInitialized()
        return ok(request.id, await host.pluginUserConfig(request.params.id))
      }
      case 'plugins:save-user-config': {
        await ensureInitialized()
        return ok(request.id, await host.savePluginUserConfig(request.params.id, request.params.values))
      }
      case 'plugins:uninstall': {
        await ensureInitialized()
        return ok(request.id, await host.uninstallPluginById(request.params.id))
      }
      case 'skills:remove': {
        await ensureInitialized()
        return ok(request.id, await host.removeSkill(request.params.name))
      }
      case 'settings:marketplace-list': {
        await ensureInitialized()
        return ok(request.id, await host.listMarketplace(request.params.query, request.params.refresh))
      }
      case 'settings:marketplace-install': {
        await ensureInitialized()
        return ok(request.id, await host.installMarketplace(request.params.id))
      }
      case 'settings:marketplace-add': {
        await ensureInitialized()
        return ok(request.id, await host.addMarketplaceEntry(request.params.name, request.params.source))
      }
      case 'settings:set-tool-profile': {
        await ensureInitialized()
        return ok(request.id, await host.setToolProfile(request.params.profile))
      }
      case 'settings:set-plugin-enabled': {
        await ensureInitialized()
        return ok(request.id, await host.setPluginEnabled(request.params.id, request.params.enabled))
      }
      case 'settings:mcp-save': {
        await ensureInitialized()
        return ok(request.id, await host.saveMcpServer(request.params.name, request.params.config))
      }
      case 'settings:mcp-remove': {
        await ensureInitialized()
        return ok(request.id, await host.removeMcpServer(request.params.name))
      }
      case 'settings:mcp-trust-project': {
        await ensureInitialized()
        return ok(request.id, await host.trustProjectMcp())
      }
      case 'settings:mcp-auth': {
        await ensureInitialized()
        return ok(request.id, await host.authenticateMcp(request.params.name))
      }
      case 'settings:mcp-reload': {
        await ensureInitialized()
        return ok(request.id, await host.reloadMcp())
      }
      case 'settings:reload': {
        await ensureInitialized()
        return ok(request.id, await host.reloadAll())
      }
      case 'app:open-external':
        return fail(request.id, 'main-only', 'app:open-external must be handled by the main process')
      case 'app:check-update':
        return fail(request.id, 'main-only', 'app:check-update must be handled by the main process')
      case 'app:pick-path':
        return fail(request.id, 'main-only', 'app:pick-path must be handled by the main process')
      case 'app:quit':
        return fail(request.id, 'main-only', 'app:quit must be handled by the main process')
      case 'app:new-window':
        return fail(request.id, 'main-only', 'app:new-window must be handled by the main process')
      case 'app:image-preview':
        return fail(request.id, 'main-only', 'app:image-preview must be handled by the main process')
      case 'app:set-window-sessions':
        return fail(request.id, 'main-only', 'app:set-window-sessions must be handled by the main process')
      case 'app:window-info':
        return fail(request.id, 'main-only', 'app:window-info must be handled by the main process')
      case 'shell:create':
        return ok(request.id, await shells.create(request.params))
      case 'shell:write':
        shells.write(request.params.id, request.params.data)
        return ok(request.id, null)
      case 'shell:resize':
        shells.resize(request.params.id, request.params.cols, request.params.rows)
        return ok(request.id, null)
      case 'shell:kill':
        shells.kill(request.params.id)
        return ok(request.id, null)
      case 'smoke:run': {
        const report = await runSmoke()
        sendEvent({ type: 'smoke:result', report })
        return ok(request.id, report)
      }
      default: {
        const unknown = request as { id: string; method: string }
        return fail(unknown.id, 'unknown-method', `Unknown method: ${unknown.method}`)
      }
    }
  } catch (error) {
    return fail(request.id, errorCode(error), errorMessage(error))
  }
}

initMainBridge(port)

setDocumentRenderers({
  pdf: async (html, title) => {
    const result = await requestMain<{ data: string }>('app:render-pdf', { html, title })
    return Buffer.from(result.data, 'base64')
  },
})

parentPort.on('message', (event) => {
  const message = event?.data
  if (!message || typeof message !== 'object') return

  if (handleMainResponse(message)) return

  if (message.kind === 'shutdown') {
    void host.shutdown().finally(() => shells.disposeAll())
    return
  }

  if (message.kind === 'request') {
    void handleRequest(message.request).then((response) => {
      port.postMessage({ kind: 'response', response })
    })
  }
})

port.postMessage({
  kind: 'ready',
  pid: process.pid,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch,
  },
})

void ensureInitialized().catch(() => undefined)
