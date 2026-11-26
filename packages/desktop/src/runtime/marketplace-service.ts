import {
  addKnownMarketplace,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
} from '@x-code-cli/core'
import type { ConsentPreview, Marketplace, MarketplaceEntry } from '@x-code-cli/core'

import type { MarketplaceEntryView, MarketplaceListView } from '../shared/protocol.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function matchesQuery(entry: MarketplaceEntry, query: string): boolean {
  const haystack = [entry.name, entry.description ?? '', entry.category ?? '', ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function toView(entry: MarketplaceEntry, marketplace: Marketplace, installed: Set<string>): MarketplaceEntryView {
  const id = `${entry.name}@${marketplace.name}`
  return {
    id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    version: entry.version,
    verified: entry.verified,
    marketplace: marketplace.name,
    homepage: entry.homepage,
    installed: installed.has(id),
  }
}

export async function listMarketplacePlugins(query = '', refresh = false): Promise<MarketplaceListView> {
  const errors: string[] = []
  let marketplaces: Marketplace[] = []

  if (refresh) {
    const known = await readKnownMarketplaces()
    for (const entry of known.marketplaces) {
      try {
        marketplaces.push(await fetchMarketplace(entry))
      } catch (error) {
        errors.push(`${entry.name}: ${errorMessage(error)}`)
      }
    }
  }
  if (marketplaces.length === 0) {
    marketplaces = await readAllCachedMarketplaces()
  }

  const installed = new Set((await listInstalledPlugins()).map((record) => record.id))
  const normalized = query.trim().toLowerCase()
  const entries = marketplaces
    .flatMap((marketplace) =>
      marketplace.plugins
        .filter((entry) => !normalized || matchesQuery(entry, normalized))
        .map((entry) => toView(entry, marketplace, installed)),
    )
    .sort((a, b) => Number(b.verified === true) - Number(a.verified === true) || a.name.localeCompare(b.name))

  return {
    entries,
    marketplaces: marketplaces.map((marketplace) => ({
      name: marketplace.name,
      displayName: marketplace.displayName,
      description: marketplace.description,
      count: marketplace.plugins.length,
    })),
    errors,
  }
}

/** 插件里真正有执行面（任意 shell / 任意子进程）的贡献。
 *  renderer 的正常安装路径是 `plugins:preview` → `plugins:install`，用户先看到
 *  [[ConsentPreview]] 才确认；而这条 `settings:marketplace-install` 通道没有
 *  任何 UI 可以渲染预览，因此只在“没有可执行贡献”时才允许静默放行。 */
function executableContribution(preview: ConsentPreview): string | null {
  const surface: string[] = []
  if (preview.hookEvents.length > 0) surface.push(`hooks（${preview.hookEvents.join(', ')}）`)
  if (preview.inlineMcpServerNames.length > 0) surface.push(`MCP server（${preview.inlineMcpServerNames.join(', ')}）`)
  if (preview.hasPathMcpServers) surface.push('MCP server（由文件声明）')
  if (preview.hasPathHooks) surface.push('hooks（由文件声明）')
  if (surface.length === 0) return null
  return (
    `插件 ${preview.pluginId} 会注入 ${surface.join('、')}，需要先预览并确认。` +
    '请在「设置 → 插件」中用安装对话框重新安装该插件。'
  )
}

export async function installMarketplacePluginInfo(id: string): Promise<{ pluginId: string; version: string }> {
  const found = await lookupPlugin(id)
  if (!found) throw new Error(`市场中未找到插件 ${id}`)
  // 不再无条件 `consent: () => true`：那等于让第三方市场的插件未经用户知情同意
  // 就获得注入 hooks / 启动 MCP 的能力。这里用预览做闸门，拒绝时抛出可提示文案。
  let refusal: string | null = null
  let result: Awaited<ReturnType<typeof installPlugin>> | null = null
  try {
    result = await installPlugin({
      source: found.entry.source,
      marketplace: found.marketplace.name,
      expectedName: found.entry.name,
      scope: 'user',
      consent: (preview) => {
        refusal = executableContribution(preview)
        return refusal === null
      },
    })
  } catch (error) {
    if (refusal) throw new Error(refusal)
    throw new Error(`安装 ${id} 失败：${errorMessage(error)}`)
  }
  if (!result) throw new Error(`安装 ${id} 失败`)
  return { pluginId: result.pluginId, version: result.manifest.version }
}

export async function addMarketplace(name: string, source: string): Promise<MarketplaceListView> {
  const cleanName = name.trim()
  const cleanSource = source.trim()
  if (!cleanName || !cleanSource) throw new Error('市场名称和来源不能为空')
  await addKnownMarketplace({ name: cleanName, source: cleanSource })
  await fetchMarketplace({ name: cleanName, source: cleanSource })
  return listMarketplacePlugins('', false)
}
