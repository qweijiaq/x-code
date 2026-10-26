// ─── UI 主题系统 ──────────────────────────────────────────────────
//
// 对标 Claude Code 的 `/theme` 设计：用户从六个 UI 主题中选一个，这个选择
// 同时驱动 diff 背景色和语法高亮调色板。diff 背景色曾经是静态常量——
// 这意味着 /theme 切换对 diff 界面（最显眼的代码展示元素）毫无影响。现在
// 这些常量在渲染时根据当前主题派生。
//
// 每个主题还会绑定一个语法调色板（例如 dark → monokai，
// dark-ansi → ansi）。我们把语法调色板名字暴露在主题对象上，这样启动接线
// 和 `/theme` 命令就能放在同一处。
//
// UI 镶边颜色（spinner、边框、success/error、选中项……）不在这里——
// 它们是 `ui/tokens.ts` 里的语义 token，在调用时通过 `getTheme()`
// 解析出 dark/light/ansi 值。
import type { SyntaxThemeName } from './syntax-highlight.js'

export type ThemeName = 'dark' | 'light' | 'dark-daltonized' | 'light-daltonized' | 'dark-ansi' | 'light-ansi'

export interface ThemeColors {
  name: ThemeName
  label: string
  description: string
  /** 24 位颜色用 `#rrggbb`，纯 ANSI 主题用 `'ansi:default'`（后者让背景
   *  保持终端默认色，并用暗色样式 / 装饰前景色标记 `-` 行）。render-diff
   *  会把这些字符串翻译成正确的 chalk 调用。
   *
   *  数值与 Claude Code 的 `native-ts/color-diff/index.ts buildTheme()` 一致
   *  ——这些才是真正画到终端上的颜色。CC `utils/theme.ts` 里单独（更亮）的
   *  数值只是选择器预览用的 UI 指示色，不是滚动区里 diff 正文的样子。 */
  diffAdded: string
  diffRemoved: string
  /** diff 行侧槽（行号 + `+`/`-` 符号）的前景色。CC 用高饱和的「装饰」色
   *  绘制侧槽，使其在接近黑色的背景上跳出来——没有它，侧槽在
   *  diffAdded/diffRemoved 所用的深度下会看不见。 */
  diffAddedDecoration: string
  diffRemovedDecoration: string
  /** diff 行内未高亮文本的默认前景色。对标 CC 的 `Theme.foreground`
   *  （color-diff/index.ts:303,334）——深色下是 `#f8f8f2`，浅色下是
   *  `#333333`。没有它，未匹配字符和纯 `-` 行会回退到终端默认白色
   *  （通常是 `#cccccc`），于是 CC 的 diff 行明显更亮。ANSI 主题传 `null`
   *  ——它们应遵循用户的 16 色终端调色板，而不是强行指定 hex 值。 */
  defaultFg: string | null
  /** 该主题驱动哪个语法高亮调色板。根据主题整体观感挑选——色盲友好主题
   *  用低对比调色板，ANSI 主题用 16 色 ansi 调色板。 */
  syntaxPalette: SyntaxThemeName
}

// 主题标签与 CC 的 ThemePicker 完全一致（只是 label 字符串；CC 的主题行
// 没有 description 字段）。语法调色板映射也对标 CC 的
// `defaultSyntaxThemeName`（color-diff/index.ts:182）：
// dark* → Monokai，light* → GitHub，*ansi → ansi。
export const THEMES: ThemeColors[] = [
  {
    name: 'dark',
    label: 'Dark mode',
    description: '',
    diffAdded: '#022800',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#50c850',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light',
    label: 'Light mode',
    description: '',
    diffAdded: '#dcffdc',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#248a3d',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-daltonized',
    label: 'Dark mode (colorblind-friendly)',
    description: '',
    diffAdded: '#001b29',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#51a0c8',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light-daltonized',
    label: 'Light mode (colorblind-friendly)',
    description: '',
    diffAdded: '#dbedff',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#24578a',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-ansi',
    label: 'Dark mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    // CC 设置 ansi 的 `foreground: ansiIdx(7)`（color-diff/index.ts:296），
    // 即它显式把未匹配字符画成白色。没有这个，我们的 `+` 行标点
    // （`()`、`;`、`.`、`log`）会继承终端默认色，看起来比 CC 的更淡。
    // Chalk 的 `white` 生成 \e[37m，正好映射到 ansiIdx(7)。
    defaultFg: 'white',
    syntaxPalette: 'ansi',
  },
  {
    name: 'light-ansi',
    label: 'Light mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    defaultFg: 'white',
    syntaxPalette: 'ansi',
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
  const aliases: Record<string, ThemeName> = {
    daltonized: 'dark-daltonized',
    colorblind: 'dark-daltonized',
    'colorblind-friendly': 'dark-daltonized',
    ansi: 'dark-ansi',
    'dark-colorblind': 'dark-daltonized',
    'light-colorblind': 'light-daltonized',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (THEMES.some((t) => t.name === normalized)) return normalized as ThemeName
  return null
}
