import path from 'node:path'

import { lookupPlugin } from '@x-code-cli/core'
import type { PluginSource } from '@x-code-cli/core'

export type PluginInstallSourceResult =
  | { ok: true; source: PluginSource; marketplace: string; expectedName?: string }
  | { ok: false; code: 'plugin-not-found'; pluginName: string; marketplace: string }
  | { ok: false; code: 'invalid-github-source' }
  | { ok: false; code: 'unrecognized-source'; source: string }
  /** 市场索引不可读（known_marketplaces.json 损坏 / 权限问题）。 */
  | { ok: false; code: 'marketplace-lookup-failed'; pluginName: string; marketplace: string; message: string }

type LookupPlugin = (pluginId: string) => Promise<{ entry: { source: PluginSource } } | undefined>

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

export async function resolvePluginInstallSource(
  raw: string,
  findPlugin: LookupPlugin = lookupPlugin,
): Promise<PluginInstallSourceResult> {
  const localPath = isLocalPath(raw)
  // 任意 `scheme://` 都当 git URL：`ssh://git@host/x/y.git` 里的 `@` 会被误当成
  // `name@marketplace` 分隔符，解析出 `pluginName = 'ssh://git'`。
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  const gitUrl = hasScheme || raw.startsWith('git@')
  const githubShorthand = raw.startsWith('github:')
  const marketplaceSeparator = raw.lastIndexOf('@')
  const marketplaceReference = marketplaceSeparator > 0 && !localPath && !gitUrl && !githubShorthand

  if (marketplaceReference) {
    const pluginName = raw.slice(0, marketplaceSeparator)
    const marketplace = raw.slice(marketplaceSeparator + 1)
    let found: Awaited<ReturnType<LookupPlugin>>
    try {
      found = await findPlugin(`${pluginName}@${marketplace}`)
    } catch (error) {
      // 市场索引读取失败（non-JSON / 权限）：返回结构化错误，而不是裸 stack trace。
      return {
        ok: false,
        code: 'marketplace-lookup-failed',
        pluginName,
        marketplace,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (!found) return { ok: false, code: 'plugin-not-found', pluginName, marketplace }
    return { ok: true, source: found.entry.source, marketplace, expectedName: pluginName }
  }

  if (githubShorthand) {
    const match = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
    if (!match) return { ok: false, code: 'invalid-github-source' }
    return {
      ok: true,
      source: { kind: 'github', owner: match[1]!, repo: match[2]!, ref: match[3] },
      marketplace: 'local',
    }
  }

  if (gitUrl) return { ok: true, source: { kind: 'git', url: raw }, marketplace: 'local' }
  if (localPath) return { ok: true, source: { kind: 'local', path: raw }, marketplace: 'local' }
  return { ok: false, code: 'unrecognized-source', source: raw }
}
