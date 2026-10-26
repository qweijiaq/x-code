// @x-code-cli/cli — `xc` CLI 的 yargs 参数定义。
//
// 与入口点分开，以便一长串选项（8-10 个标志 + 2 个别名 version/help）不会
// 挤占 index.ts 中的启动编排。`Argv` 的形状就是 yargs 从下面的选项链推断
// 出来的——刻意保持隐式，这样在一处添加 / 重命名标志会自动更新使用方的类型。
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { VERSION } from './version.js'

export async function parseCliArgs(args: string[] = hideBin(process.argv)) {
  return yargs(args)
    .scriptName('x-code')
    .usage('$0 [options] [prompt]')
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
    .parse()
}
