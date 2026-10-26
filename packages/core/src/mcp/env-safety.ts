// @x-code-cli/core — 拒绝作为运行时代码注入载体的环境变量
//
// MCP stdio 服务器会把 `env` 映射直接传给 spawn()。这个映射可能来自三个
// 来源：
//   1. 用户输入 `xc mcp add --env KEY=VAL`
//   2. 项目 / 用户的 mcp.json 文件
//   3. 声明自己 mcpServers 的插件 manifest
//
// (3) 正是本模块存在的目的。插件以用户安装时授予的信任运行，但像
// `NODE_OPTIONS=--require ./evil.js` 这样的键会让插件在下一次启动任何
// 基于 node 的 MCP 服务器时把它变成任意代码执行——从"manifest 安装"升级
// 为"以用户账户执行 RCE"。同样的伎俩在 Linux（LD_PRELOAD）和 macOS
// （DYLD_INSERT_LIBRARIES）上有效，也通过各自 *STARTUP / *OPT 名字对
// Python/Perl/Ruby 运行时有效。
//
// 我们位于 spawn 边界（registry.connectOneServer），因此所有来源都由同一个
// 检查覆盖，而不只是 CLI 解析器。
//
// 这是黑名单而非白名单：合法的 MCP 服务器需要接受任意 env 键来传 API
// token / 应用配置，所以白名单不可行。黑名单很短，且只针对那些唯一合法
// 用途就是"启动时加载代码"的名字。

/** 运行时解释为"启动时加载这段代码"的环境变量名。
 *  比较时忽略大小写（见 {@link assertSafeEnv}）。 */
const DANGEROUS_ENV_KEYS = new Set<string>([
  // Node
  'NODE_OPTIONS',
  // Linux 动态链接器
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // macOS 动态链接器
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // Shell 初始化 / 每条命令的钩子。BASH_ENV 在非交互 bash 中运行；
  // ENV 在 POSIX sh 中运行；PROMPT_COMMAND 在每个交互提示符上运行。
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  // Python
  'PYTHONSTARTUP',
  'PYTHONPATH',
  // Perl
  'PERL5OPT',
  'PERL5LIB',
  // Ruby
  'RUBYOPT',
  'RUBYLIB',
])

export class UnsafeEnvError extends Error {
  constructor(public readonly key: string) {
    super(
      `Env key "${key}" is blocked by the MCP env safety check: it is a runtime ` +
        `code-loading hook (NODE_OPTIONS / LD_PRELOAD-class) and would let an MCP ` +
        `config or plugin manifest run arbitrary code at server start. If you ` +
        `really need this, export it in the shell that launches xc instead.`,
    )
    this.name = 'UnsafeEnvError'
  }
}

/** 若 `env` 包含黑名单键则抛出 {@link UnsafeEnvError}。
 *
 *  比较忽略大小写：Windows 环境变量名在 OS 层面大小写不敏感，所以拒绝
 *  `NODE_OPTIONS` 却放行 `Node_Options` 只是做戏。POSIX 环境变量名大小写
 *  敏感，但没有任何合法配置会使用这些键的非大写变体。 */
export function assertSafeEnv(env: Record<string, string> | undefined): void {
  if (!env) return
  for (const k of Object.keys(env)) {
    if (DANGEROUS_ENV_KEYS.has(k.toUpperCase())) {
      throw new UnsafeEnvError(k)
    }
  }
}
