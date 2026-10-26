// @x-code-cli/cli — 斜杠命令输出的 Scrollback 追加辅助函数。
//
// 从 useAgent 提取：一个包装 `appendMessage`（会触发 setState 的原语）的
// 小子 hook，包装成 App 斜杠命令处理器使用的五种常见形状。用子 hook 而非
// 普通函数，是因为每个都是一个 useCallback，其 memo 身份对下游消费者很重要。
import { useCallback } from 'react'

import type { DisplayMessage } from '@x-code-cli/core'

export function useAgentDisplayHelpers(appendMessage: (msg: DisplayMessage) => void) {
  const addMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role,
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

  /** 添加一条系统/信息消息（用于斜杠命令输出） */
  const addInfoMessage = useCallback((content: string) => addMessage('assistant', content), [addMessage])

  /** 向历史添加一条用户消息（用于回显斜杠命令） */
  const addUserMessage = useCallback((content: string) => addMessage('user', content), [addMessage])

  /** 把一条斜杠命令回显成紧凑的 `› /cmd` 行（无尾随空行）。
   *  随后用 `addCommandResult` 输出紧凑的 `⎿  result` 行。 */
  const echoCommand = useCallback(
    (content: string) => {
      appendMessage({
        id: `cmd-${Date.now()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
        kind: 'command-echo',
      })
    },
    [appendMessage],
  )

  /** 把一条斜杠命令 + 其简短结果渲染成 Claude 风格的两行块：
   *    > /cmd
   *      ⎿  result
   *  用于单行命令响应。对于长的多行输出（/help、/usage、/init），直接调用
   *  addUserMessage + addInfoMessage。 */
  const addCommandMessage = useCallback(
    (commandText: string, resultText: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-${base}`,
        role: 'user',
        content: commandText,
        timestamp: base,
        kind: 'command-echo',
      })
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content: resultText,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  /** 在最近的命令回显下方追加一条额外的 `  ⎿  result` 行，而无需重新回显命令。
   *  用于像 /mcp refresh 和 /mcp auth 这样的多步斜杠命令，其中一次用户输入
   *  产生一个紧凑的结果块，随时间的推移逐步填充：
   *    > /mcp auth sentry
   *      ⎿  Authenticating "sentry" — opening browser...    (addCommandMessage)
   *      ⎿  Opened https://...                              (addCommandResult)
   *           Waiting for the authorization redirect...
   *      ⎿  ✓ Authenticated "sentry" — 14 tools             (addCommandResult)
   *  用 addInfoMessage 输出后续部分，会把每一段渲染成独立的 assistant 块，
   *  带前导和尾随空行，在下一次提示前用 3+ 个空行填充结果。 */
  const addCommandResult = useCallback(
    (content: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  return { addInfoMessage, addUserMessage, echoCommand, addCommandMessage, addCommandResult }
}
