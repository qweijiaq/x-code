// @x-code-cli/core — 工具进度上报器（旁路通道）
//
// AI SDK 的工具 `execute` 函数是独立运行的 —— 我们不拥有调用点，因此
// 无法直接把进度回调作为参数传进去。取而代之的是维护一个以
// `toolCallId` 为键的模块级注册表：agent loop 在模型发出 tool-call 事件
// 时注册一个上报器，工具在 execute() 里通过
// `reportProgress(toolCallId, msg)` 查找到它，loop 在 tool-result 时清除。
//
// 为什么不通过 `tool()` 选项传入：AI SDK 确实把 `{ toolCallId }` 作为
// execute 的第二个参数暴露出来，但如果不包装每一个工具，就无法把每次
// 调用的 UI 回调经 `streamText({ tools })` 定义传进去。按 toolCallId 查表
// 既能保持工具定义干净，也能对 tool-execution.ts 里手动分发的工具
// （shell、writeFile、edit、askUser）一视同仁。
export type ProgressReporter = (message: string) => void

const reporters = new Map<string, ProgressReporter>()

export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}

export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}

/** 若没有注册上报器则不做任何事，从任意位置调用都安全。 */
export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return
  reporters.get(toolCallId)?.(message)
}
