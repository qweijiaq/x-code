import type { Marketplace } from '@x-code-cli/core'

export interface MarketplacePluginMatch {
  marketplace: string
  name: string
  description?: string
  verified?: boolean
}

export function searchMarketplacePlugins(
  marketplaces: readonly Marketplace[],
  keyword: string,
): MarketplacePluginMatch[] {
  const normalizedKeyword = (keyword ?? '').trim().toLowerCase()
  // 空关键词不构成「匹配一切」：调用方会把所有插件误报成匹配结果。
  if (!normalizedKeyword) return []
  const matches: MarketplacePluginMatch[] = []

  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      const searchableText = [plugin.name, plugin.description ?? '', ...(plugin.keywords ?? [])].join(' ').toLowerCase()
      if (searchableText.includes(normalizedKeyword)) {
        matches.push({
          marketplace: marketplace.name,
          name: plugin.name,
          description: plugin.description,
          verified: plugin.verified,
        })
      }
    }
  }

  return matches
}
