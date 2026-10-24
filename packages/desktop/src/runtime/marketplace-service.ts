import {
  addKnownMarketplace,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
} from '@x-code-cli/core'
import type { Marketplace, MarketplaceEntry } from '@x-code-cli/core'

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

export async function installMarketplacePluginInfo(id: string): Promise<{ pluginId: string; version: string }> {
  const found = await lookupPlugin(id)
  if (!found) throw new Error(`市场中未找到插件 ${id}`)
  const result = await installPlugin({
    source: found.entry.source,
    marketplace: found.marketplace.name,
    expectedName: found.entry.name,
    scope: 'user',
    consent: () => true,
  })
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
