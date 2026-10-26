import path from 'node:path'

import { installPlugin, lookupPlugin } from '@x-code-cli/core'
import type { ConsentPreview, PluginSource, PluginUserConfig, UserConfigItem, UserConfigValue } from '@x-code-cli/core'

import type { PluginInstallTarget, UserConfigValues } from '../shared/protocol.js'

export interface InstalledPluginInfo {
  pluginId: string
  version: string
}

interface ResolvedTarget {
  source: PluginSource
  marketplace: string
  expectedName?: string
  verified?: boolean
}

function isLocalPath(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
}

/** 剥离复制粘贴的 `xc plugin install …` / `claude plugin install …`
 *  包装。不执行任何 shell；只使用目标参数。 */
export function normalizeInstallCommand(command: string): string {
  const match = command.trim().match(/^(?:xc|x-code|claude)\s+plugin\s+install\s+(.+)$/i)
  const raw = (match ? match[1] : command).trim()
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new Error('安装命令为空')
  const extras = tokens.slice(1).filter((token) => token !== '-y' && token !== '--yes')
  if (extras.length > 0) throw new Error(`安装命令包含不支持的参数: ${extras.join(' ')}`)
  return tokens[0]!
}

export function coerceUserConfigValue(type: UserConfigItem['type'], value: string | number | boolean): UserConfigValue {
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true'
  }
  return String(value)
}

/** 把安装时的表单值与 manifest 默认值合并。敏感字段为空值
 *  表示「保留已存储的值 / 保持未设置」。 */
export function buildUserConfigValues(fields: UserConfigItem[], provided?: UserConfigValues): PluginUserConfig {
  const merged: PluginUserConfig = {}
  for (const field of fields) {
    const value = provided && Object.hasOwn(provided, field.key) ? provided[field.key] : undefined
    if (value !== undefined && !(field.sensitive === true && value === '')) {
      merged[field.key] = coerceUserConfigValue(field.type, value)
    } else if (field.default !== undefined) {
      merged[field.key] = field.default
    }
  }
  return merged
}

function userConfigPrompt(provided?: UserConfigValues) {
  return async (fields: UserConfigItem[] | undefined): Promise<PluginUserConfig> =>
    buildUserConfigValues(fields ?? [], provided)
}

async function resolveSource(raw: string): Promise<ResolvedTarget> {
  const localPath = isLocalPath(raw)
  const gitUrl = /^https?:\/\//i.test(raw) || raw.startsWith('git@')
  const githubShorthand = raw.startsWith('github:')

  if (!localPath && !gitUrl && !githubShorthand) {
    const at = raw.lastIndexOf('@')
    if (at > 0) {
      const pluginName = raw.slice(0, at)
      const marketplace = raw.slice(at + 1)
      const found = await lookupPlugin(`${pluginName}@${marketplace}`)
      if (!found) throw new Error(`市场 ${marketplace} 中没有找到插件 ${pluginName}`)
      return {
        source: found.entry.source,
        marketplace,
        expectedName: pluginName,
        verified: found.entry.verified,
      }
    }
  }

  if (githubShorthand) {
    const match = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
    if (!match) throw new Error('GitHub 地址格式应为 github:owner/repo[#ref]')
    return {
      source: { kind: 'github', owner: match[1]!, repo: match[2]!, ref: match[3] },
      marketplace: 'local',
    }
  }
  if (gitUrl) return { source: { kind: 'git', url: raw }, marketplace: 'local' }
  if (localPath) return { source: { kind: 'local', path: path.resolve(raw) }, marketplace: 'local' }

  throw new Error('无法识别的安装目标。支持 name@marketplace、github:owner/repo、Git URL 或本地路径')
}

async function resolveTarget(target: PluginInstallTarget): Promise<ResolvedTarget> {
  if (target.kind === 'marketplace') {
    const found = await lookupPlugin(target.id)
    if (!found) throw new Error(`市场中未找到插件 ${target.id}`)
    return {
      source: found.entry.source,
      marketplace: found.marketplace.name,
      expectedName: found.entry.name,
      verified: found.entry.verified,
    }
  }
  if (target.kind === 'path') {
    return { source: { kind: 'local', path: path.resolve(target.path) }, marketplace: 'local' }
  }
  return resolveSource(normalizeInstallCommand(target.command))
}

/** 把插件解析/下载到足以生成核心 consent 预览的程度，
 *  然后在移入缓存前中止。 */
export async function previewPluginInstall(target: PluginInstallTarget): Promise<ConsentPreview> {
  const resolved = await resolveTarget(target)
  let captured: ConsentPreview | null = null
  try {
    await installPlugin({
      ...resolved,
      scope: 'user',
      consent: (preview) => {
        captured = preview
        return false
      },
    })
  } catch (error) {
    if (!captured) throw error
  }
  if (!captured) throw new Error('无法获取插件安装预览')
  return captured
}

export async function installPluginWithConsent(
  target: PluginInstallTarget,
  userConfig?: UserConfigValues,
): Promise<InstalledPluginInfo> {
  const resolved = await resolveTarget(target)
  const result = await installPlugin({
    ...resolved,
    scope: 'user',
    // 调用方已从预览 UI 获得用户的明确确认。
    consent: () => true,
    userConfigPrompt: userConfigPrompt(userConfig),
  })
  return { pluginId: result.pluginId, version: result.manifest.version }
}

/** 为 skill 命令路径保留：在 skill 命令本身被确认后，
 *  安装插件目标/命令。 */
export async function installPluginTarget(
  commandOrTarget: string,
  userConfig?: UserConfigValues,
): Promise<InstalledPluginInfo> {
  return installPluginWithConsent({ kind: 'command', command: commandOrTarget }, userConfig)
}
