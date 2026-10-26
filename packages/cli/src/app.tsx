// @x-code-cli/cli — Ink 渲染入口。
//
// 我们依赖 `@jrichman/ink`（在 package.json 中别名成 `ink`），而非上游 Ink。
// 这个 fork 提供了单元级终端缓冲、基于字符串宽度 / StyledLine 的测量器、
// DEC 2026 同步更新，以及 IME 感知的光标定位——这些共同消除了原版 Ink 在
// 长时间运行聊天 UI 上出现的 CJK/IME 抖动。我们代码库中无需任何改动：
// 该 fork 与 `ink` API 兼容。
import { render } from 'ink'

import type { AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

import { registerCleanupController } from './cleanup-controller.js'
import { App } from './ui/app/App.js'
import { printHeader } from './ui/app/AppHeader.js'
import { registerSessionInfoGetter } from './ui/app/session-exit.js'

/** 全局清理引用——由 App 组件通过 onCleanupReady prop 设置 */
export interface StartAppOptions {
  /** 来自 `--continue` 的预加载会话（在 Ink 挂载前于 index.ts 中同步加载）。首次渲染时水合到 agent。 */
  initialSession?: LoadedSession | null
  /** 设为 'pick' 时，App 在挂载时弹出会话选择器对话框——即 `--resume` 标志路径。选择器复用与 /resume 相同的 askQuestion UI，因此只需维护一条代码路径。 */
  resumeIntent?: 'pick' | null
}

export function startApp(
  model: LanguageModel,
  options: AgentOptions,
  initialPrompt?: string,
  startOpts: StartAppOptions = {},
) {
  // 在 Ink 启动前只打印一次页头——避免 Static 重复渲染
  printHeader(options.modelId)

  const { waitUntilExit } = render(
    <App
      model={model}
      options={options}
      initialPrompt={initialPrompt}
      initialSession={startOpts.initialSession ?? null}
      resumeIntent={startOpts.resumeIntent ?? null}
      onCleanupReady={(fn) => {
        registerCleanupController(fn)
      }}
      onSessionInfoReady={(getter) => {
        registerSessionInfoGetter(getter)
      }}
    />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}
