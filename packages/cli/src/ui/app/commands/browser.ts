// @x-code-cli/cli — /browser 斜杠命令：切换交互式浏览器 agent。
//
// 交互式浏览器自动化是 opt-in 的，就像每一个同类 CLI（claude-code 的 --chrome /
// CLAUDE_CODE_ENABLE_CFC、gemini 的设置覆盖、codex 的插件安装）。`/browser on|off`
// 控制浏览器 agent；`/browser check-on` 和 `/browser check-off` 控制独立的
// 一次性本地视觉检查。共享浏览器只有在两个消费者都关闭时才关闭。
import { loadUserConfig, saveUserConfig, shutdownBrowserMcp } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

export interface BrowserCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  invalidateSystemPromptCache: () => void
}

export function createBrowserCommandHandler(deps: BrowserCommandDeps) {
  const { options, addCommandMessage, addCommandResult, invalidateSystemPromptCache } = deps

  const isOn = (): boolean => options.subAgentRegistry?.names().includes('browser') ?? false
  const isVisualCheckOn = (): boolean => options.browserVisualCheckEnabled !== false

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
      // 返回值会让用户误以为重启后仍然生效。
      const persisted = saveUserConfig({ browser: { ...loadUserConfig().browser, visualCheck: enable } })
      options.browserVisualCheckEnabled = enable
      invalidateSystemPromptCache()

      // 关闭失败（共享 Chrome 子进程可能仍存活）也要如实反映，不能一律宣称已关闭。
      let shutdownFailed = false
      if (!enable && !isOn()) {
        shutdownFailed = await shutdownBrowserMcp().then(
          () => false,
          () => true,
        )
      }
      addCommandMessage(
        text,
        `Automatic local visual checks ${enable ? 'ON' : 'OFF'}${
          persisted ? ' — saved.' : ' (this session only — config could not be saved).'
        }`,
      )
      addCommandResult(
        enable
          ? 'The root agent can now capture one temporary-tab screenshot of localhost after significant visual changes. Browser Use remains independently controlled by /browser on.'
          : `The root visual-check tool is disabled.${
              isOn()
                ? ' The managed browser remains open for interactive Browser Use.'
                : shutdownFailed
                  ? ' The managed browser could not be closed and may still be running.'
                  : ' Closed the managed browser (if running).'
            }`,
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
    // 这样选择在重启后依然生效。`saveUserConfig` 失败时只返回 false。
    const persisted = saveUserConfig({ browser: { ...loadUserConfig().browser, enabled: enable } })
    // 就地添加 / 移除 browser agent——保持 registry 的对象身份（捕获的
    // options.subAgentRegistry 引用仍有效），并跳过一次完整的 custom/plugin 重扫。
    try {
      options.subAgentRegistry.setBrowserEnabled(enable)
      // task 工具的 agent 列表（在字节稳定的系统提示里）变了。
      invalidateSystemPromptCache()
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

    if (enable) {
      addCommandMessage(text, `Interactive browser agent ON${persisted ? ' — saved.' : ' (this session only).'}`)
      addCommandResult(
        'The model can now delegate clicking, typing, login, and other multi-step browser tasks. It reuses the managed Chrome used by visual checks; no extension is required. First browser use launches it via `npx @playwright/mcp` (needs Node + Chrome; ~tens of seconds the first time).\n' +
          'The next message rebuilds the system prompt, so prompt-cache will miss once.',
      )
    } else {
      let shutdownFailed = false
      if (!isVisualCheckOn()) {
        shutdownFailed = await shutdownBrowserMcp().then(
          () => false,
          () => true,
        )
      }
      addCommandMessage(text, `Interactive browser agent OFF${persisted ? ' — saved.' : ' (this session only).'}`)
      addCommandResult(
        `${
          isVisualCheckOn()
            ? 'The managed browser stays available for automatic local visual checks.'
            : shutdownFailed
              ? 'The managed browser could not be closed and may still be running.'
              : 'Closed the managed browser (if running).'
        } The next message rebuilds the system prompt, so prompt-cache will miss once.`,
      )
    }
  }

  return { handleBrowser }
}
