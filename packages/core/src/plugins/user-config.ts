// @x-code-cli/core — 插件 userConfig 存储
//
// 每个插件都可以在自己的 manifest 里声明一个 `userConfig` 块——一份它需要
// 用户提供的字段清单（API key、账号 id、工作目录等）。安装时 CLI 逐个字段
// 提示输入值；本模块负责磁盘持久层。
//
// 布局：
//
//   ~/.x-code/plugins/user-config.json    →  {
//                                              [pluginId]: { [key]: <value> }
//                                            }
//
// 存储格式是普通 JSON map；文件以 0600（仅属主可读写）创建，让其它用户
// 会话里的进程读不到敏感值。这并不能替代真正的操作系统 keychain
// （macOS Keychain / Windows Credential Manager / Linux libsecret）——
// 它是一个务实的 v1，避开了原生构建的复杂度。`sensitive: true` 字段仍会在
// 提示时驱动掩码输入；只是落盘存储共用同一个文件。
//
// 未来的增强会把 `sensitive` 条目挪进真正的 keychain。读取方会从两个来源
// 合并，所以日后加入它属于非破坏性变更。
//
// 为什么不把 sensitive 与非 sensitive 拆成两个文件：那只会成倍增加文件 IO
// 却抬不高安全门槛（两个文件都在同一目录、权限相同）。真正的保护需要真正
// 的 keychain；在那之前，单个文件如实说明我们在做什么。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage } from '../utils.js'
import { pluginsRoot } from './paths.js'

/** 单个字段的值类型。manifest 的 `type` 字段（string / number / boolean）
 *  在提示时被强制执行，但我们本来就经 JSON 往返，而 JSON 只认得这三种
 *  原始类型。 */
export type UserConfigValue = string | number | boolean

/** 每个插件的 user-config map：以 manifest 的 `key` 字段为键。 */
export type PluginUserConfig = Record<string, UserConfigValue>

/** 完整文件布局：{ [pluginId]: PluginUserConfig }。 */
type UserConfigFile = Record<string, PluginUserConfig>

function userConfigPath(): string {
  return path.join(pluginsRoot(), 'user-config.json')
}

/** 读取整个 user-config.json。
 *
 *  只有**文件不存在**（ENOENT / ENOTDIR）等价于"还没有任何插件的配置"。
 *  `setPluginUserConfig` / `clearPluginUserConfig` 都是读-改-写，把
 *  EACCES / EISDIR / EINTR / EBUSY 之类瞬时故障或 JSON 解析失败（上次写到
 *  一半崩溃、磁盘满截断）降级成 `{}` 后写回，会把**所有其它插件**的
 *  userConfig 一起抹掉——用户只能重新逐个输入 API key，且毫无提示。 */
async function readFile(): Promise<UserConfigFile> {
  let raw: string
  try {
    raw = await fs.readFile(userConfigPath(), 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return {}
    debugLog('plugins.user-config-read-error', String(err))
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    debugLog('plugins.user-config-parse-error', String(err))
    throw new Error(`plugin user-config at ${userConfigPath()} is not valid JSON: ${errorMessage(err)}`, { cause: err })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 结构非法 ≠ "没有配置"：降级成 {} 后写回会抹掉所有插件的 userConfig（含
    // API key），所以和解析失败走同一条 fail-loud 路径。
    throw new Error(
      `plugin user-config at ${userConfigPath()} has an unexpected shape (expected a JSON object of plugin id → values)`,
    )
  }
  // 逐条规整：某 pluginId 的值若不是对象（手工编辑 / 旧版本写入），原样返回会
  // 让 resolvePluginUserConfigEnv 里的 Object.entries("abc") 产出 "0"/"1"
  // 这样的环境变量名。无原型对象同时挡住 `__proto__` 键的原型污染。
  const record = Object.create(null) as UserConfigFile
  for (const [pluginId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      debugLog('plugins.user-config-entry-invalid', pluginId)
      continue
    }
    const values = Object.create(null) as PluginUserConfig
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = value
    }
    record[pluginId] = values
  }
  return record
}

/** 原子写入：先写临时文件再 rename，避免崩溃 / ENOSPC 在正式文件里留下被
 *  截断的 JSON（叠加上面的读错误处理，那会造成全量丢失）。这个文件里存的
 *  是 manifest 声明的 `sensitive` 字段（API key 等），所以权限必须收紧：
 *  `mode` 只在**创建**新文件时生效，复用上次以 0644 创建残留的临时文件、或
 *  被旧版本创建过时，权限位不会更新——因此显式 `chmod` 一次。 */
async function writeFile(data: UserConfigFile): Promise<void> {
  const p = userConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const payload = JSON.stringify(data, null, 2) + '\n'
  try {
    // 'wx'：独占创建，绝不复用残留文件（那会带上别人的权限位，或跟随符号链接）。
    await fs.writeFile(tmp, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    // 0600 让文件只对属主用户可读。在 Windows 上是空操作（fs.chmod 不会
    // 同样地映射成 ACL）——不借助 icacls 的话我们做不了什么有意义的事。
    // 后续的 keychain 方案会妥善解决 Windows。
    if (process.platform !== 'win32') await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, p)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/** 读取某个插件已保存的配置。当插件还没有保存过配置时返回空对象——调用方
 *  可从 manifest 为各键取默认值。 */
export async function getPluginUserConfig(pluginId: string): Promise<PluginUserConfig> {
  const all = await readFile()
  return all[pluginId] ?? {}
}

/** 写入某个插件的配置。与既有字段合并而非整体替换——调用方想的话可以
 *  每个字段调用一次（例如交互式提示循环）。 */
export async function setPluginUserConfig(pluginId: string, values: PluginUserConfig): Promise<void> {
  const all = await readFile()
  all[pluginId] = { ...(all[pluginId] ?? {}), ...values }
  await writeFile(all)
}

/** 丢弃某个插件的配置（例如卸载时）。 */
export async function clearPluginUserConfig(pluginId: string): Promise<void> {
  const all = await readFile()
  if (!(pluginId in all)) return
  delete all[pluginId]
  await writeFile(all)
}

/** 绝不允许由插件 userConfig 提供的环境变量名。
 *
 *  manifest 对这些 key 只有 `z.string().min(1)` 约束，没有任何命名限制，而
 *  `getPluginUserConfigEnv` 会把它们**原样**合并进该插件所有 stdio MCP server
 *  与 hook 子进程的环境。用户在安装提示里填入的值一旦落到下面这些名字上，等
 *  于把子进程的代码执行 / 动态链接 / 命令解析面交给插件作者：
 *
 *   - `NODE_OPTIONS` / `NODE_PATH` / `BASH_ENV` / `ENV` / `ZDOTDIR` /
 *     `PYTHONSTARTUP` / `PERL5OPT` / `RUBYOPT` —— 子进程启动即执行指定代码；
 *   - `LD_*` / `DYLD_*` —— 动态链接劫持（用前缀规则，避免逐个枚举时漏掉
 *     `DYLD_PRINT_LIBRARIES`、`DYLD_ROOT_PATH` 这类变体）；
 *   - `GIT_CONFIG*` / `GIT_SSH*` / `SSH_ASKPASS` / `GIT_ASKPASS` /
 *     `GIT_EXEC_PATH` —— 劫持 git（`GIT_CONFIG_PARAMETERS` 可以注入
 *     `core.pager` / `core.fsmonitor`，等价于命令执行）；
 *   - `NODE_TLS_REJECT_UNAUTHORIZED` / `NODE_EXTRA_CA_CERTS` —— 关掉该插件所有
 *     stdio MCP server 的证书校验 / 注入攻击者 CA（MITM）；
 *   - `PATH` / `PATHEXT` / `COMSPEC` / `IFS` / `HOME` / `SHELL` —— 改写命令解析。
 *
 *  被丢弃的 key 会由调用方（plugins/integration.ts）写进 `mcpErrors`，让
 *  `/plugin doctor` 能浮现出来，而不是静默吞掉。 */
const RESERVED_USER_CONFIG_ENV_KEYS: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_PRINT_ENV',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CONFIG',
  'SSH_ASKPASS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'DOTNET_STARTUP_HOOKS',
  'DOTNET_ADDITIONAL_DEPS',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'KSH_ENV',
  'ZENV',
  'PERL5DB',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'IFS',
  'HOME',
  'SHELL',
  'ELECTRON_RUN_AS_NODE',
])

/** 前缀黑名单：逐个枚举必然漏掉变体（`DYLD_ROOT_PATH`、
 *  `GIT_CONFIG_PARAMETERS`、`LD_AUDIT` …），所以整族拒绝。 */
const RESERVED_USER_CONFIG_ENV_PREFIXES: readonly string[] = ['DYLD_', 'LD_', 'GIT_CONFIG']

/** 该环境变量名是否被 userConfig 通道拒绝（Windows 的环境变量名大小写不敏感）。 */
export function isReservedUserConfigEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (RESERVED_USER_CONFIG_ENV_KEYS.has(upper)) return true
  return RESERVED_USER_CONFIG_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/** {@link getPluginUserConfigEnv} 的完整结果：可用变量 + 因命名危险而被丢弃的
 *  键名（供 `/plugin doctor` 上报）。 */
export interface PluginUserConfigEnv {
  env: Record<string, string>
  droppedKeys: string[]
}

/** 把某个插件的 user-config map 物化为 env-var 记录，准备合并进子进程的
 *  环境。每个 manifest key 成为 env var 名；数字和布尔被强转成其字符串
 *  形式。未设置的字段被跳过（对应 env var 保持不动），
 *  {@link isReservedUserConfigEnvKey} 命中的键名会被丢弃并回报。 */
export async function resolvePluginUserConfigEnv(pluginId: string): Promise<PluginUserConfigEnv> {
  const cfg = await getPluginUserConfig(pluginId)
  const env: Record<string, string> = {}
  const droppedKeys: string[] = []
  for (const [k, v] of Object.entries(cfg)) {
    if (isReservedUserConfigEnvKey(k)) {
      droppedKeys.push(k)
      continue
    }
    env[k] = String(v)
  }
  if (droppedKeys.length > 0) {
    debugLog('plugins.user-config-reserved-env-key', `${pluginId}: ${droppedKeys.join(', ')}`)
  }
  return { env, droppedKeys }
}

/** {@link resolvePluginUserConfigEnv} 的便捷形式，只返回可用的环境变量。 */
export async function getPluginUserConfigEnv(pluginId: string): Promise<Record<string, string>> {
  return (await resolvePluginUserConfigEnv(pluginId)).env
}
