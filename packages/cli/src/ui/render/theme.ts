// ─── UI 主题系统 ──────────────────────────────────────────────────
//
// 对标 Claude Code 的 `/theme` 设计，但只保留深色和浅色两套：用户明确要求
// 简洁，不需要色盲/ANSI 变体。主题选择同时驱动 diff 背景色和语法高亮调色板。
//
// UI 镶边颜色（spinner、边框、success/error、选中项……）不在这里——
// 它们是 `ui/tokens.ts` 里的语义 token，在调用时通过 `getTheme()` 解析出
// dark/light 值。
import type { SyntaxThemeName } from './syntax-highlight.js'

export type ThemeName = 'dark' | 'light'

export interface ThemeColors {
  name: ThemeName
  label: string
  description: string
  /** diff 行的背景色（24 位 hex）。render-diff 会把它翻译成 chalk 的 bgHex。 */
  diffAdded: string
  diffRemoved: string
  /** diff 行侧槽（行号 + `+`/`-` 符号）的前景色。 */
  diffAddedDecoration: string
  diffRemovedDecoration: string
  /** diff 行内未高亮文本的默认前景色。 */
  defaultFg: string | null
  /** 该主题驱动哪个语法高亮调色板。 */
  syntaxPalette: SyntaxThemeName
}

// 只保留深色和浅色两套主题：简洁优先，不再提供色盲/ANSI 变体。
// diff 背景色与语法调色板跟随主题，避免切换后代码颜色和背景打架。
export const THEMES: ThemeColors[] = [
  {
    name: 'dark',
    label: 'Dark',
    description: 'For dark terminals',
    diffAdded: '#0d2818',
    diffRemoved: '#2d1114',
    diffAddedDecoration: '#3fb950',
    diffRemovedDecoration: '#f85149',
    defaultFg: '#e6edf3',
    syntaxPalette: 'one-dark',
  },
  {
    name: 'light',
    label: 'Light',
    description: 'For light terminals',
    diffAdded: '#e6ffec',
    diffRemoved: '#ffebe9',
    diffAddedDecoration: '#1a7f37',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#1f2328',
    syntaxPalette: 'github-light',
  },
]

export const DEFAULT_THEME: ThemeName = 'dark'

let currentTheme: ThemeName = DEFAULT_THEME

export function setTheme(name: ThemeName): void {
  currentTheme = name
}

export function getTheme(): ThemeName {
  return currentTheme
}

export function getThemeColors(name?: ThemeName): ThemeColors {
  const target = name ?? currentTheme
  return THEMES.find((t) => t.name === target) ?? THEMES[0]!
}

export function parseThemeName(input: unknown): ThemeName | null {
  if (typeof input !== 'string') return null
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
  // 旧主题名继续映射到两套新主题，避免已有 config.json 启动失败。
  const aliases: Record<string, ThemeName> = {
    daltonized: 'dark',
    colorblind: 'dark',
    'colorblind-friendly': 'dark',
    ansi: 'dark',
    'dark-colorblind': 'dark',
    'light-colorblind': 'light',
    'dark-ansi': 'dark',
    'light-ansi': 'light',
    'dark-daltonized': 'dark',
    'light-daltonized': 'light',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (THEMES.some((t) => t.name === normalized)) return normalized as ThemeName
  return null
}
