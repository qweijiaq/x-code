import {
  readOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from './credential-store.js'
import { refreshOpenAIChatGPTAccessToken } from './oauth.js'
import { OpenAIChatGPTAuthError } from './types.js'
import type { OpenAIChatGPTCredentials } from './types.js'

const REFRESH_SKEW_MS = 5 * 60 * 1000
const SHARED_REFRESH_TIMEOUT_MS = 30 * 1000

export interface OpenAIChatGPTTokenManagerOptions {
  fetch?: typeof fetch
  userAgent?: string
}

export interface OpenAIChatGPTRequestAuth {
  accessToken: string
  accountId?: string
  isFedRamp?: boolean
}

function waitForSharedRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 一次共享刷新窗口内所有加入者的诉求。单槽 `refreshPromise` 只能记住
 *  “第一个”调用者的 `failedAccessToken`/`force`，后加入者会被静默忽略，
 *  于是 `recoverAfterUnauthorized(force=true)` 可能拿回刚失效的同一个 token
 *  并造成 401 死循环。这里把加入者的失败 token 与 force 一起累积起来，
 *  并在共享结果返回后逐个校验（见 {@link OpenAIChatGPTTokenManager.refreshOnce}）。 */
interface RefreshWindow {
  /** 本次刷新窗口内被判定为失效的全部 access token。 */
  failedTokens: Set<string>
  /** 是否有任何一个加入者要求强制刷新（跳过“还有效就别刷”的短路）。 */
  force: boolean
}

export class OpenAIChatGPTTokenManager {
  private refreshPromise: Promise<OpenAIChatGPTCredentials> | undefined
  private refreshWindow: RefreshWindow | undefined
  private readonly fetchImpl: typeof fetch
  private readonly userAgent?: string

  constructor(options: OpenAIChatGPTTokenManagerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent
  }

  async getCredentials(signal?: AbortSignal): Promise<OpenAIChatGPTCredentials> {
    const credentials = await readOpenAIChatGPTCredentials()
    if (Date.now() + REFRESH_SKEW_MS < credentials.expiresAt) return credentials
    return this.refresh(credentials.accessToken, false, signal)
  }

  async getRequestAuth(signal?: AbortSignal): Promise<OpenAIChatGPTRequestAuth> {
    const credentials = await this.getCredentials(signal)
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      isFedRamp: credentials.isFedRamp,
    }
  }

  async recoverAfterUnauthorized(failedAccessToken: string, signal?: AbortSignal): Promise<OpenAIChatGPTRequestAuth> {
    const credentials = await this.refresh(failedAccessToken, true, signal)
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      isFedRamp: credentials.isFedRamp,
    }
  }

  private refresh(failedAccessToken: string, force: boolean, signal?: AbortSignal): Promise<OpenAIChatGPTCredentials> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('ChatGPT token refresh wait was cancelled.'))
    return waitForSharedRefresh(this.refreshOnce(failedAccessToken, force, false), signal)
  }

  /** 发起或加入一次共享刷新，并对“加入者”校验共享结果。
   *
   *  - 发起者：走锁内的真实刷新，拿到什么返回什么。
   *  - 加入者：注册自己的 `failedAccessToken`/`force`，然后在共享结果返回后
   *    校验——若拿回的 token 仍等于自己判定失效的那个 token，说明锁内用的是
   *    别人的失败 token，于是再发起一次强制刷新；只允许重试一次（`isRetry`），
   *    否则 OAuth 返回同一 token 时会无限循环，改为抛 `login-required` 让调用
   *    方停止重试。 */
  private refreshOnce(failedAccessToken: string, force: boolean, isRetry: boolean): Promise<OpenAIChatGPTCredentials> {
    const joined = this.refreshPromise
    if (joined) {
      const window = this.refreshWindow
      window?.failedTokens.add(failedAccessToken)
      if (window && force) window.force = true
      return joined.then((credentials) => this.settleJoinedRefresh(credentials, failedAccessToken, force, isRetry))
    }

    const refreshSignal = AbortSignal.timeout(SHARED_REFRESH_TIMEOUT_MS)
    const window: RefreshWindow = { failedTokens: new Set([failedAccessToken]), force }
    this.refreshWindow = window
    this.refreshPromise = withOpenAIChatGPTCredentialLock(async () => {
      const current = await readOpenAIChatGPTCredentials()
      // 锁内回顾整个窗口：只要磁盘上的 token 不属于任何加入者的失败 token，
      // 说明别的进程已经刷新过，直接复用。
      const pending = this.refreshWindow ?? window
      if (!pending.failedTokens.has(current.accessToken)) return current
      if (!pending.force && Date.now() + REFRESH_SKEW_MS < current.expiresAt) return current

      const refreshed = await refreshOpenAIChatGPTAccessToken(current, {
        fetch: this.fetchImpl,
        userAgent: this.userAgent,
        signal: refreshSignal,
      })
      if (current.accountId && refreshed.accountId && current.accountId !== refreshed.accountId) {
        throw new OpenAIChatGPTAuthError(
          'credentials-invalid',
          'The refreshed ChatGPT account does not match the signed-in account. Run `xc logout`, then `xc login`.',
        )
      }
      await writeOpenAIChatGPTCredentials(refreshed)
      return refreshed
    }, refreshSignal).finally(() => {
      this.refreshPromise = undefined
      this.refreshWindow = undefined
    })
    return this.refreshPromise
  }

  /** 校验共享刷新的结果是否满足某个加入者。 */
  private settleJoinedRefresh(
    credentials: OpenAIChatGPTCredentials,
    failedAccessToken: string,
    force: boolean,
    isRetry: boolean,
  ): Promise<OpenAIChatGPTCredentials> | OpenAIChatGPTCredentials {
    if (credentials.accessToken !== failedAccessToken) return credentials
    // 非强制路径（`getCredentials`）不做二级重试：把结果交回去，上层拿到 401
    // 后会走 `recoverAfterUnauthorized`，那是 force 路径，下面会再刷新一次。
    if (!force) return credentials
    if (isRetry) {
      // 已经重试过一次，拿回的仍是同一个失效 token：不要再让上层用它重试，
      // 否则就是 401 死循环。
      throw new OpenAIChatGPTAuthError(
        'login-required',
        'ChatGPT did not issue a usable access token. Run `xc login` to sign in again.',
      )
    }
    return this.refreshOnce(failedAccessToken, true, true)
  }
}

let defaultManager: OpenAIChatGPTTokenManager | undefined

export function getOpenAIChatGPTTokenManager(): OpenAIChatGPTTokenManager {
  if (!defaultManager) defaultManager = new OpenAIChatGPTTokenManager({ userAgent: 'x-code-cli' })
  return defaultManager
}

export function setOpenAIChatGPTTokenManagerForTesting(manager: OpenAIChatGPTTokenManager | undefined): void {
  defaultManager = manager
}
