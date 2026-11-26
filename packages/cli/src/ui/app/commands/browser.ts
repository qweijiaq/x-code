// @x-code-cli/cli — /browser 斜杠命令：切换交互式浏览器 agent。
//
// 交互式浏览器自动化是 opt-in 的，就像每一个同类 CLI（claude-code 的 --chrome /
// CLAUDE_CODE_ENABLE_CFC、gemini 的设置覆盖、codex 的插件安装）。`/browser on|off`
// 控制浏览器 agent；`/browser check-on` 和 `/browser check-off` 控制独立的
// 一次性本地视觉检查。共享浏览器只有在两个消费者都关闭时才关闭。
import { debugLog, errorMessage, loadUserConfig, saveUserConfig, shutdownBrowserMcp } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

export interface BrowserCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  invalidateSystemPromptCache: () => void
}

/** 关闭共享浏览器没有内部超时：子进程 / MCP 客户端卡住时整条命令会一直挂在这里，
 *  而运行时开关与系统提示缓存早已改完——用户看到的就是「命令没反应」。超时按
 *  「关闭失败」处理（进程可能仍存活），让命令总能给出可读结果。 */
const SHUTDOWN_TIMEOUT_MS = 5_000

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createBrowserCommandHandler(deps: BrowserCommandDeps) {
  const { options, addCommandMessage, addCommandResult, invalidateSystemPromptCache } = deps

  const isOn = (): boolean => options.subAgentRegistry?.names().includes('browser') ?? false
  const isVisualCheckOn = (): boolean => options.browserVisualCheckEnabled !== false

  /** 共享浏览器只有在两个消费者都关闭时才关闭；两个开关的执行顺序一致，逻辑共用
   *  一份，避免将来只改一处导致语义漂移。返回 true = 关闭失败（可能仍在运行）。 */
  async function shutdownSharedBrowserIfIdle(): Promise<boolean> {
    try {
      await withTimeout(shutdownBrowserMcp(), SHUTDOWN_TIMEOUT_MS)
      return false
    } catch (error) {
      // 旧实现用 `.then(f, f)` 吞掉异常，日志里连原因都没有。
      debugLog('browser.shutdown', `shared browser shutdown failed: ${errorMessage(error)}`)
      return true
    }
  }

  /** `task` 工具的 agent 列表在字节稳定的系统提示里，切换后必须失效缓存。缓存失效
   *  抛错不能影响已经生效的运行时切换（也不能让用户以为切换失败），所以单独兜住。
   *  返回 true = 缓存没能刷新，下一条消息可能仍列出旧的 agent 集合。 */
  function refreshSystemPromptCache(): boolean {
    try {
      invalidateSystemPromptCache()
      return true
    } catch (error) {
      debugLog('browser.prompt-cache', `system prompt cache invalidation failed: ${errorMessage(error)}`)
      return false
    }
  }

  const stalePromptCacheNote = (stale: boolean): string =>
    stale
      ? 'The system prompt cache could not be refreshed, so the next message may still describe the old agent set.'
      : 'The next message rebuilds the system prompt, so prompt-cache will miss once.'

  async function handleBrowser(text: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase()

    if (sub === '' || sub === 'status') {
      addCommandMessage(
        text,
        `Interactive Browser Use is ${isOn() ? 'ON' : 'OFF'}; automatic local visual checks are ${isVisualCheckOn() ? 'ON' : 'OFF'}.`,
      )
      return
    }

    if (sub !== 'on' && sub !== 'off' && sub !== 'check-on' && sub !== 'check-off') {
      addCommandMessage(text, 'Usage: /browser [on|off|check-on|check-off]')
      return
    }

    if (sub === 'check-on' || sub === 'check-off') {
      const enable = sub === 'check-on'
      if (enable === isVisualCheckOn()) {
        addCommandMessage(text, `Automatic local visual checks are already ${enable ? 'ON' : 'OFF'}.`)
        return
      }

      // `saveUserConfig` 在只读目录/磁盘错误时返回 false 而不是抛错：直接忽略
      // 返回值会让用户误以为重启后仍然生效。而 `loadUserConfig` / `saveUserConfig`
      // 也可能真的抛错（磁盘 I/O）——那既不能挡住运行时切换，也不能冒到 dispatch
      // 链上让 UI 得不到任何反馈。
      let persisted = false
      try {
        persisted = saveUserConfig({ browser: { ...loadUserConfig().browser, visualCheck: enable } })
      } catch (error) {
        debugLog('browser.config', `saving the visual-check setting failed: ${errorMessage(error)}`)
      }
      options.browserVisualCheckEnabled = enable
      // 运行时开关已经生效，缓存刷新单独兜住：否则「切换成功但提示缓存没失效」会
      // 被报成失败，运行时与提示不一致。
      const promptCacheStale = !refreshSystemPromptCache()

      // 关闭失败（共享 Chrome 子进程可能仍存活）也要如实反映，不能一律宣称已关闭。
      const shutdownFailed = !enable && !isOn() ? await shutdownSharedBrowserIfIdle() : false
      addCommandMessage(
        text,
        `Automatic local visual checks ${enable ? 'ON' : 'OFF'}${
          persisted ? ' — saved.' : ' (this session only — config could not be saved).'
        }`,
      )
      addCommandResult(
        `${
          enable
            ? 'The root agent can now capture one temporary-tab screenshot of localhost after significant visual changes. Browser Use remains independently controlled by /browser on.'
            : `The root visual-check tool is disabled.${
                isOn()
                  ? ' The managed browser remains open for interactive Browser Use.'
                  : shutdownFailed
                    ? ' The managed browser could not be closed and may still be running.'
                    : ' Closed the managed browser (if running).'
              }`
        }${promptCacheStale ? ` ${stalePromptCacheNote(true)}` : ''}`,
      )
      return
    }

    if (!options.subAgentRegistry) {
      addCommandMessage(text, "Sub-agent system isn't available, so the browser agent can't be toggled.")
      return
    }

    const enable = sub === 'on'
    if (enable === isOn()) {
      addCommandMessage(text, `Interactive browser agent is already ${enable ? 'ON' : 'OFF'}.`)
      return
    }

    // 持久化（合并进任何已有的 browser 配置，让 headless/channel 覆盖得以保留），
    // 这样选择在重启后依然生效。`saveUserConfig` 失败时只返回 false，磁盘 I/O 也
    // 可能直接抛错——两者都只影响「是否持久化」，不该挡住运行时切换。
    let persisted = false
    try {
      persisted = saveUserConfig({ browser: { ...loadUserConfig().browser, enabled: enable } })
    } catch (error) {
      debugLog('browser.config', `saving the browser agent setting failed: ${errorMessage(error)}`)
    }
    // 就地添加 / 移除 browser agent——保持 registry 的对象身份（捕获的
    // options.subAgentRegistry 引用仍有效），并跳过一次完整的 custom/plugin 重扫。
    try {
      options.subAgentRegistry.setBrowserEnabled(enable)
    } catch (err) {
      // 运行时切换失败时不能静默：异常会一路冒到 dispatch 链，UI 看不到任何
      // 可读反馈，而配置可能已经落盘。
      addCommandMessage(
        text,
        `Failed to ${enable ? 'enable' : 'disable'} the browser agent: ${
          err instanceof Error ? err.message : String(err)
        }${persisted ? ' (the setting was saved and will apply on restart).' : ''}`,
      )
      return
    }
    // task 工具的 agent 列表（在字节稳定的系统提示里）变了。缓存失效刻意放在
    // 上面的 try 之外：此时 agent 已经切换成功，缓存失效抛错不能再被报成「切换
    // 失败」，也不能阻止下面的成功消息。
    const promptCacheStale = !refreshSystemPromptCache()

    if (enable) {
      addCommandMessage(text, `Interactive browser agent ON${persisted ? ' — saved.' : ' (this session only).'}`)
      addCommandResult(
        'The model can now delegate clicking, typing, login, and other multi-step browser tasks. It reuses the managed Chrome used by visual checks; no extension is required. First browser use launches it via `npx @playwright/mcp` (needs Node + Chrome; ~tens of seconds the first time).\n' +
          stalePromptCacheNote(promptCacheStale),
      )
    } else {
      const shutdownFailed = !isVisualCheckOn() ? await shutdownSharedBrowserIfIdle() : false
      addCommandMessage(text, `Interactive browser agent OFF${persisted ? ' — saved.' : ' (this session only).'}`)
      addCommandResult(
        `${
          isVisualCheckOn()
            ? 'The managed browser stays available for automatic local visual checks.'
            : shutdownFailed
              ? 'The managed browser could not be closed and may still be running.'
              : 'Closed the managed browser (if running).'
        } ${stalePromptCacheNote(promptCacheStale)}`,
      )
    }
  }

  return { handleBrowser }
}
