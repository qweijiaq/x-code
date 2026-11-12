import {
  type PeerMessagingConfig,
  type PeerService,
  type PeerServiceOptions,
  createPeerService,
  debugLog,
  errorMessage,
  resolvePeerMessagingConfig,
} from '@x-code-cli/core'

export interface CliPeerStartupOptions {
  userConfig?: unknown
  printMode: boolean
  name?: string
  cwd: string
  getPermissionClass: () => 'prompted' | 'bypass'
}

type PeerServiceFactory = (options: PeerServiceOptions) => PeerService

let lastStartupError: string | null = null

/** 最近一次 `--name` 启动失败的原因。`/list-agents` 用它区分"没启用"与
 *  "启用了但初始化失败"，而不是把两者都报成"不是命名 agent"。 */
export function getLastPeerStartupError(): string | null {
  return lastStartupError
}

export function resolveCliPeerMessagingConfig(userConfig: unknown): PeerMessagingConfig {
  return resolvePeerMessagingConfig(userConfig)
}

export async function startCliPeerService(
  options: CliPeerStartupOptions,
  factory: PeerServiceFactory = createPeerService,
): Promise<PeerService | null> {
  lastStartupError = null
  if (options.printMode || !options.name?.trim()) return null
  const config = resolveCliPeerMessagingConfig(options.userConfig)

  let service: PeerService
  try {
    service = factory({
      enabled: true,
      config,
      name: options.name,
      cwd: options.cwd,
      getPermissionClass: options.getPermissionClass,
    })
  } catch (error) {
    lastStartupError = errorMessage(error)
    debugLog('peer.start-failed', errorMessage(error))
    return null
  }
  try {
    await service.start()
  } catch (error) {
    lastStartupError = errorMessage(error)
    debugLog('peer.start-failed', errorMessage(error))
  }
  return service
}
