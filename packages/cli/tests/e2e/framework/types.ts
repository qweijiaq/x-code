// e2e 框架 — runner / harness / scenarios 之间共享的类型。

export interface ToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** 若在同一会话中找到配对的 tool-result，则为结果文本。 */
  resultText?: string
  /** 该工具结果是否被提供方/工具标记为错误。 */
  isError?: boolean
}

export interface RunResult {
  /** 本次运行所有 assistant 消息拼接后的最终 assistant 文本。 */
  assistantText: string
  /** 按调用顺序的所有工具调用，存在配对结果时已合并进来。 */
  toolCalls: ToolCall[]
  /** 来自 `xc -p` 的原始 stdout。调试时可能仍有参考价值。 */
  stdout: string
  /** 原始 stderr。 */
  stderr: string
  /** 进程退出码。 */
  exitCode: number
  /** 挂钟耗时（毫秒）。 */
  durationMs: number
  /** 本次运行生成的会话 jsonl 文件的绝对路径；无则为空。 */
  sessionJsonlPath: string
  /** 最近一条 usage 条目报告的 token 数（如有）。 */
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface RunCliOptions {
  /** 额外的 CLI 参数（例如 `['--trust', '--max-turns', '20']`）。 */
  args?: string[]
  /** 覆盖秒数预算。默认 120s。 */
  timeoutMs?: number
  /** 在基础 env（已设置 X_CODE_HOME / model）之上合并的额外环境变量。 */
  env?: Record<string, string>
  /** 工作目录；默认是场景的 tmpDir。 */
  cwd?: string
}

export interface ScenarioContext {
  /** 本场景临时目录的绝对路径；即 CLI 运行时的 CWD。 */
  tmpDir: string
  /** 选中的模型 id，已通过 MODEL_ALIASES 映射。 */
  modelId: string
  /** packages/cli/dist/cli.js 的路径（由 runner 解析一次）。 */
  cliBin: string
  /** 可用环境变量（过滤到 *_API_KEY 及少量其它）。 */
  env: Record<string, string>

  // ── 文件辅助函数（路径若非绝对路径则相对于 tmpDir） ──
  writeFile(relPath: string, content: string): Promise<void>
  readFile(relPath: string): Promise<string>
  fileExists(relPath: string): Promise<boolean>
  mkdir(relPath: string): Promise<void>

  // ── CLI 运行器 ──
  runCli(prompt: string, options?: RunCliOptions): Promise<RunResult>

  // ── 断言辅助函数（失败时抛出 ScenarioAssertionError） ──
  expect: ScenarioExpect
}

export interface ScenarioExpect {
  /** 断言某工具至少被调用一次。inputMatcher 接受部分对象，
   *  其值可以是相等值、RegExp 或谓词函数。 */
  toolCalled(
    result: RunResult,
    toolName: string,
    inputMatcher?: Record<string, unknown | RegExp | ((v: unknown) => boolean)>,
  ): ToolCall
  toolNotCalled(result: RunResult, toolName: string): void
  /** 断言拼接后的 assistant 文本匹配子串或正则。 */
  assistantMentions(result: RunResult, needle: string | RegExp): void
  /** 断言退出码。 */
  exitCode(result: RunResult, code: number): void
  /** 断言 tmpDir 相对路径下存在某文件。 */
  fileExists(relPath: string): Promise<void>
  /** 断言文件内容匹配子串或正则。 */
  fileContent(relPath: string, matcher: string | RegExp): Promise<void>
  /** 断言没有任何工具调用以 isError 结束。 */
  noToolErrors(result: RunResult): void
  /** 自定义断言：条件为假时以给定消息抛出。 */
  truthy(condition: unknown, message: string): void
}

export interface Scenario {
  /** 用于状态持久化与 CLI 过滤的稳定 id。使用 `01-` 前缀，
   *  以便文件自然排序。 */
  id: string
  /** 进度输出中展示的人类可读名称。 */
  name: string
  /** 若设置，当 env 谓词返回 false 时跳过该场景。
   *  用于需要可选 key 的场景（例如 TAVILY_API_KEY）。 */
  requires?: (env: Record<string, string>) => boolean
  /** 当 `requires` 返回 false 时展示的跳过原因。 */
  requiresReason?: string
  /** 实际测试主体。失败时应当抛出。 */
  run(ctx: ScenarioContext): Promise<void>
}

export interface ScenarioResult {
  id: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** 挂钟耗时（秒）。 */
  durationSec: number
  /** 简短的人类可读错误消息；仅在 status === 'failed' 时设置。 */
  error?: string
  /** 本场景最近一次 CLI 运行的会话 jsonl 路径。 */
  lastSessionJsonl?: string
  /** 场景 tmpDir 的路径（失败保留，通过删除）。 */
  tmpDir?: string
  /** 跳过原因（若 status === 'skipped'）。 */
  skipReason?: string
}

export interface RunState {
  /** 最近选中的模型 id。 */
  model: string
  /** 最近一次运行开始的 ISO 时间戳。 */
  startedAt: string
  /** 按场景 id 索引的各场景结果。 */
  results: Record<string, ScenarioResult>
}

export class ScenarioAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioAssertionError'
  }
}
