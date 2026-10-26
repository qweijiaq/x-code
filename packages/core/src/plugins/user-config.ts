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
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog } from '../utils.js'
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

async function readFile(): Promise<UserConfigFile> {
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as UserConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    debugLog('plugins.user-config-read-error', String(err))
    return {}
  }
}

async function writeFile(data: UserConfigFile): Promise<void> {
  const p = userConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // 0600 让文件只对属主用户可读。在 Windows 上是空操作（fs.chmod 不会
  // 同样地映射成 ACL）——不借助 icacls 的话我们做不了什么有意义的事。
  // 后续的 keychain 方案会妥善解决 Windows。
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
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

/** 把某个插件的 user-config map 物化为 env-var 记录，准备合并进子进程的
 *  环境。每个 manifest key 成为 env var 名；数字和布尔被强转成其字符串
 *  形式。未设置的字段被跳过（对应 env var 保持不动）。 */
export async function getPluginUserConfigEnv(pluginId: string): Promise<Record<string, string>> {
  const cfg = await getPluginUserConfig(pluginId)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg)) {
    env[k] = String(v)
  }
  return env
}
