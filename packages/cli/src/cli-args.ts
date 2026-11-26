// @x-code-cli/cli — `xc` CLI 的 yargs 参数定义。
//
// 与入口点分开，以便一长串选项（8-10 个标志 + 2 个别名 version/help）不会
// 挤占 index.ts 中的启动编排。`Argv` 的形状就是 yargs 从下面的选项链推断
// 出来的——刻意保持隐式，这样在一处添加 / 重命名标志会自动更新使用方的类型。
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { VERSION } from './version.js'

/** `--max-turns` / `--max-tokens` / `--max-cost` 的取值校验。
 *
 *  `type: 'number'` 只做 `Number()` 转换：`--max-turns abc` 得到 `NaN`，`0` 和
 *  负数也照收。这些值原样透传到 `AgentOptions.maxTurns` / budget，而 core 的
 *  循环条件是 `options.maxTurns === undefined || turn < options.maxTurns`——
 *  `turn < NaN` 恒为 false，于是 `--print --max-turns abc` 会让 agent 循环一次都
 *  不执行、静默产出空结果；NaN / 负数预算则恒不触发，用户以为已生效的上限形同
 *  虚设（无人值守的 print 模式下尤其危险）。
 *
 *  yargs 会把这里抛出的错误当作校验失败：打印消息并以非零码退出。 */
function positiveNumber(flag: string): (value: number | undefined) => number | undefined {
  return (value) => {
    if (value === undefined) return value
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${flag} requires a positive number (got ${String(value)})`)
    }
    return value
  }
}

export async function parseCliArgs(args: string[] = hideBin(process.argv)) {
  return (
    yargs(args)
      .scriptName('x-code')
      .usage('$0 [options] [prompt]')
      // `--fallback-model` 是唯一的数组选项，而位置参数就是提示词：
      // `xc -p --fallback-model sonnet "解释这个仓库"` 在贪婪收集下会把整句提示词
      // 当成第二个备用模型 id，同时 `argv._` 变空（print 模式静默按空提示运行）。
      // 关闭贪婪后仍然支持重复写法 `--fallback-model a --fallback-model b`。
      .parserConfiguration({ 'greedy-arrays': false })
      .option('model', {
        alias: 'm',
        type: 'string',
        describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-5.6-sol)',
      })
      .option('trust', {
        alias: 't',
        type: 'boolean',
        default: false,
        describe: 'Trust mode: run tool calls without ordinary confirmations, including peer-triggered work',
      })
      .option('print', {
        alias: 'p',
        type: 'boolean',
        default: false,
        describe: 'Non-interactive mode: output result and exit',
      })
      .option('output-format', {
        type: 'string',
        choices: ['text', 'json', 'jsonl'] as const,
        default: 'text',
        // 仅对 --print 有意义。json 在结束时给一个结果对象；jsonl 逐事件输出。
        describe: 'Print-mode output: text (stream), json (one result), or jsonl (one event per line)',
      })
      .option('name', {
        type: 'string',
        describe: 'Name this agent and enable cross-session discovery and messaging',
      })
      .option('max-turns', {
        type: 'number',
        // 无默认值——交互模式下运行时不设上限（用户按 Esc 停止）。
        // 传入值以强制上限；主要与 `--print` 配合使用，因为那没有人参与循环。
        describe: 'Cap on agent loop iterations per submission (default: unlimited)',
      })
      .option('max-tokens', {
        type: 'number',
        // 与 --max-turns 同为“每次提交”的增量；跨 submit 不累计。
        describe: 'Cap on tokens consumed per prompt (default: unlimited)',
      })
      .option('max-cost', {
        type: 'number',
        // 只对内置/用户定价表里的模型有效；未定价模型的成本不计入，预算可能提前或滞后触发。
        describe: 'Cap on estimated USD cost per prompt using list prices (default: unlimited)',
      })
      .option('external-content-policy', {
        type: 'string',
        choices: ['off', 'approve'] as const,
        describe: 'Re-approve write/shell tools after web/document/MCP content (default: off)',
      })
      .option('fallback-model', {
        type: 'array',
        string: true,
        // 仅在提供商侧故障（429/5xx/欠费/模型下线/网络）且该轮没有可见输出时切换。
        describe: 'Fallback model id if the provider fails (repeatable, tried in order)',
      })
      .option('plan', {
        type: 'boolean',
        default: false,
        // 无短别名——`-p` 已被 `--print` 占用。计划模式将模型限制为只读探索
        // + 计划文件，直到用户批准。
        describe: 'Start the session in plan mode (read-only exploration; user must approve before code edits)',
      })
      .option('plugins', {
        type: 'boolean',
        default: true,
        // 声明为正向 `--plugins`（默认开启），这样 yargs 会自动推导出
        // `--no-plugins` 取反形式。该标志是一个逃生舱，用于诊断行为异常的插件
        // （损坏的 skill、失控的 hook 等）是否是问题根源——`--no-plugins`
        // 会完全跳过 loadAllPlugins，只保留内置贡献生效。
        describe: 'Enable plugin discovery (default true). `--no-plugins` to disable for one session.',
      })
      .option('hooks', {
        type: 'boolean',
        default: true,
        // 与 `--plugins` 相同的 `--no-hooks` 取反模式。插件仍会加载
        // （skill / agent / mcp 贡献仍会注册），只是跳过 hook 子系统——
        // 改用 emptyHookBus() 而非集成构建的那个。当怀疑某个 hook 缓慢 /
        // 失控时使用，同时不会丢失插件的其余内容。
        describe: 'Enable plugin hooks (default true). `--no-hooks` to skip hook execution for one session.',
      })
      .option('plugin-debug', {
        type: 'boolean',
        default: false,
        // 针对插件 / hook / marketplace 活动的定向调试输出。将匹配的
        // debugLog() 行在写入日志文件的同时镜像到 stderr，这样无需 tail
        // ~/.x-code/logs/ 就能实时看到。等价于设置 `XC_PLUGIN_DEBUG=1`。
        // 不改变行为——只改变面包屑的去向。
        describe: 'Mirror plugin / hook / marketplace debug breadcrumbs to stderr (also XC_PLUGIN_DEBUG=1).',
      })
      .option('continue', {
        alias: 'c',
        type: 'boolean',
        default: false,
        describe: 'Resume the most recent session in this project (no picker)',
      })
      .option('scratch', {
        type: 'boolean',
        default: false,
        describe: 'Use the default quick-question workspace (~/.x-code/workspace)',
      })
      .option('resume', {
        alias: 'r',
        type: 'string',
        // 可选值：`xc --resume`（无值）打开选择器；`xc --resume <id-or-slug>`
        // 直接跳转到文件名匹配的会话。Yargs 将其视为字符串类型标志，因此
        // `argv.resume === undefined` 表示“未给出该标志”，`''` 表示
        // “给出了但无值”，其他任何字符串都是用户的查找键。
        describe: 'Resume a session: `--resume` opens the picker; `--resume <id>` jumps directly',
      })
      .version(VERSION)
      .alias('v', 'version')
      .help()
      .alias('h', 'help')
      .coerce({
        'max-turns': positiveNumber('max-turns'),
        'max-tokens': positiveNumber('max-tokens'),
        'max-cost': positiveNumber('max-cost'),
      })
      // 未知标志直接报错退出，而不是被静默忽略：拼错的 `--max-turn 5` 之前既不
      // 生效应有的上限，又把 `5` 拼进提示词发给模型。子命令（watch / trace /
      // audit / completion / plugin / login）在 index.ts 里先于本函数被拦截，
      // 因此 strictOptions 不会误伤它们的位置参数。
      .strictOptions()
      .epilogue(
        '  xc watch [paths...] --on-change "<prompt>"   Re-run the agent when files change\n' +
          '  xc trace [--last N] [--json]   Show recent local turn traces\n' +
          '  xc audit [--last N] [--json]   Show recent local tool approval decisions\n' +
          '  xc completion <bash|zsh|fish>  Print a shell completion script',
      )
      .parse()
  )
}
