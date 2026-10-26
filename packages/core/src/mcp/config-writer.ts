// @x-code-cli/core — 读写用户 / 项目 config.json 中的 `mcpServers`
//
// 驱动 `/mcp add` 和 `/mcp remove`。活儿不大但容易出错：
//   - 保留无关的顶层字段（theme、model、thinking 等）
//   - 增删某一项时保留其他 mcpServers 条目
//   - 原子写入，使写入中途的 Ctrl-C 不会破坏文件
//   - 绝不在写入前只读一次——写入时重新读取，以免覆盖并发编辑
//     （罕见，但防御成本很低）
//
// writer 用与 loader 相同的 Zod schema 校验它持久化的每个配置，因此会在
// 加载时被拒绝的 add-json 输入会在这里就被拒绝——在入口处快速失败。
import fs from 'node:fs/promises'
import path from 'node:path'

import { getUserConfigPath } from '../config/index.js'
import { XCODE_DIR } from '../utils.js'
import { parseServerConfig } from './config-schema.js'
import { type McpServerConfig } from './types.js'

export type ConfigScope = 'user' | 'project'

/** 每个 scope 的 config.json 所在位置。镜像 loader 读取的相同路径，因此
 *  这里的写入保证会在下一次加载（或 `/mcp refresh`）时被拾取。 */
export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === 'user') return getUserConfigPath()
  return path.join(cwd, XCODE_DIR, 'config.json')
}

/** 读取给定 scope 解析后的 JSON 对象。文件不存在、为空或畸形时返回 `{}`
 *  ——调用方统一把这些情况当作"这里还没配置 MCP 服务器"。 */
async function readConfigObject(scope: ConfigScope, cwd: string): Promise<Record<string, unknown>> {
  const file = getConfigPath(scope, cwd)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 畸形的 JSON。我们刻意在解析失败时不覆盖——直接退出并让调用方报错。
    // 这里返回 {} 会掩盖损坏的配置，而写入会覆盖掉原有内容。
    throw new Error(`Config file at ${file} is not valid JSON. Fix it manually before running /mcp add or /mcp remove.`)
  }
  return {}
}

/** 原子 JSON 写入：先写 tmp，再 rename。结尾换行 + 2 空格缩进与别处
 *  （saveUserConfig）使用的约定一致。 */
async function writeConfigObject(scope: ConfigScope, cwd: string, obj: Record<string, unknown>): Promise<void> {
  const file = getConfigPath(scope, cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)
}

/** 给定服务器名当前所在位置。返回给 App.tsx 调用方，使 `/mcp remove` 能
 *  自动定位正确的 scope（并检测罕见的双 scope 歧义，那会强制显式 --scope）。 */
export type DetectScopeResult = { kind: 'not-found' } | { kind: 'user' } | { kind: 'project' } | { kind: 'both' }

export async function detectScope(name: string, cwd: string): Promise<DetectScopeResult> {
  const [user, project] = await Promise.all([serverExists(name, 'user', cwd), serverExists(name, 'project', cwd)])
  if (user && project) return { kind: 'both' }
  if (user) return { kind: 'user' }
  if (project) return { kind: 'project' }
  return { kind: 'not-found' }
}

export async function serverExists(name: string, scope: ConfigScope, cwd: string): Promise<boolean> {
  const obj = await readConfigObject(scope, cwd)
  const servers = obj.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  return Object.prototype.hasOwnProperty.call(servers, name)
}

/** 向给定 scope 的 config.json 添加服务器。拒绝覆盖——调用方必须先用
 *  `serverExists` 检查重复，并给出包含当前与拟添加配置的有用错误。 */
export async function writeServerToConfig(
  name: string,
  config: McpServerConfig,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string }> {
  // 先校验。通过 /mcp add-json 传入的坏 JSON 不应被写入、然后在下一次启动
  // 时爆炸——在入口处用清晰的 schema 错误快速失败。
  const validated = parseServerConfig(name, config)

  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  const servers =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  servers[name] = validated
  obj.mcpServers = servers
  await writeConfigObject(scope, cwd, obj)
  return { path: getConfigPath(scope, cwd) }
}

/** 从给定 scope 的 config.json 移除服务器。幂等：当名字不存在（或文件
 *  不存在）时返回 `removed: false`。保留一个空的 `mcpServers: {}` 而不是
 *  删除该字段——为将来的添加保留位置，并避免让用 git diff 该文件的用户
 *  感到意外的变动。 */
export async function removeServerFromConfig(
  name: string,
  scope: ConfigScope,
  cwd: string,
): Promise<{ path: string; removed: boolean }> {
  const file = getConfigPath(scope, cwd)
  const obj = await readConfigObject(scope, cwd)
  const existing = obj.mcpServers
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { path: file, removed: false }
  }
  const servers = existing as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return { path: file, removed: false }
  }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(servers)) {
    if (k !== name) next[k] = v
  }
  obj.mcpServers = next
  await writeConfigObject(scope, cwd, obj)
  return { path: file, removed: true }
}

/** 从给定 scope 读取 `name` 的当前配置，用于 /mcp add 的"已存在，这是当前
 *  内容"路径。不存在时返回 null。尽力而为：畸形条目返回 null 而不是抛出
 *  ——重复检查这个用例不应崩溃。 */
export async function readServerConfig(name: string, scope: ConfigScope, cwd: string): Promise<unknown | null> {
  try {
    const obj = await readConfigObject(scope, cwd)
    const servers = obj.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    const value = (servers as Record<string, unknown>)[name]
    return value ?? null
  } catch {
    return null
  }
}
