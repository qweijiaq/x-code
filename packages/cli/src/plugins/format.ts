import type { PluginSource } from '@x-code-cli/core'

/** marketplace.json 里的来源字段是不可信的：本函数的输出会被原样写进终端与
 *  Markdown（`plugins/cli.ts` 的 console.log、`ui/app/commands/plugin.ts` 的
 *  消息渲染）。去掉所有控制字符（含 ESC、CR、LF）即可阻断 ANSI/OSC 转义注入
 *  与伪造列表行。 */
function safe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '')
}

export function formatPluginSource(source: PluginSource | undefined): string {
  if (!source) return '(unknown)'
  if (source.kind === 'local') return `local: ${safe(source.path)}`
  if (source.kind === 'git') return `git: ${safe(source.url)}${source.ref ? `#${safe(source.ref)}` : ''}`
  return `github:${safe(source.owner)}/${safe(source.repo)}${source.ref ? `#${safe(source.ref)}` : ''}`
}
