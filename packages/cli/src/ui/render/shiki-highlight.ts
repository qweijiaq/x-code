// @x-code-cli/cli — 基于 Shiki 的语法高亮器（原型）。
//
// 用真正的 TextMate 语法引擎补充内置正则高亮器（syntax-highlight.ts），
// 仿照 codex-cli 使用 syntect 的方式：
//
//  - 惰性单例：引擎在启动时后台预热（`warmShikiEngine`，即发即忘）。就绪前
//    每个入口都返回 null，调用方回退到正则高亮器——渲染路径保持同步，
//    从不在引擎初始化上阻塞。
//  - 护栏（与 codex 的 highlight.rs 同理）：超过 MAX_LINES 行 / MAX_BYTES
//    字节 / 每行 MAX_LINE_BYTES 的输入会被拒绝，返回 null 让调用方渲染
//    纯文本/回退文本。渲染循环在 UI 线程上靠 setInterval 绘制，所以病理性的
//    数千行粘贴绝不能同步分词。
//  - 预加载集合之外的语言按需加载：罕见围栏（如 `ruby`）的首次渲染会触发
//    异步加载并对该次渲染回退；之后的渲染使用 shiki。
//
// 引擎选型：通过 `shiki/wasm` 使用 Oniguruma WASM（base64 内联，esbuild
// 无需再打包 .wasm 资源）。实测在我们这种输入规模下比纯 JS 正则引擎快约
// 30-40 倍——JS 引擎处理 500 行代码块要约 160ms，会明显卡住渲染循环。
import { type HighlighterCore, type LanguageInput, createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { type SyntaxThemeName, highlightLine } from './syntax-highlight.js'
import { chalk as c } from './tokens.js'

// ─── 护栏 ───

/** 用户拍板的决定：比这长的代码块不值得读（或上色）——按纯文本渲染。 */
const MAX_LINES = 500
const MAX_BYTES = 256 * 1024
/** 单行的压缩巨型行是病态输入；跳过它。 */
const MAX_LINE_BYTES = 4 * 1024

// ─── 主题映射 ───

/** 我们的 4 个语法调色板 → shiki 主题名。`ansi` 没有 shiki 等价物
 *  （终端 16 色调色板），所以映射到 null 并始终回退到内置高亮器。 */
const SHIKI_THEMES: Record<Exclude<SyntaxThemeName, 'ansi'>, string> = {
  'one-dark': 'one-dark-pro',
  monokai: 'monokai',
  'github-light': 'github-light',
}

let currentShikiTheme: string | null = SHIKI_THEMES['one-dark']

/** setSyntaxTheme 的镜像——从同样两个位置调用（启动时应用配置、`/theme`
 *  切换），让 shiki 路径跟随当前 UI 主题。 */
export function setShikiTheme(name: SyntaxThemeName): void {
  currentShikiTheme = name === 'ansi' ? null : SHIKI_THEMES[name]
}

// ─── 语言注册表 ───

/** 预热时急加载的语言——占据 agent 输出主体的那些。下面 LANG_LOADERS 里的
 *  其余语言在首次使用时加载。 */
const EAGER_LANGS = ['typescript', 'javascript', 'json', 'bash', 'python', 'markdown', 'yaml'] as const

async function loadShikiLanguage(name: string): Promise<LanguageInput> {
  const { languages } = EAGER_LANGS.includes(name as (typeof EAGER_LANGS)[number])
    ? await import('./shiki-assets-common.js')
    : await import('./shiki-assets-extra.js')
  return languages[name]!
}

/** 围栏 id / 扩展名 → shiki 语言 id + 惰性加载器。键是小写。shiki 默认不认识
 *  的围栏别名（或拼写不同的，如 `shell`）在这里做归一化。 */
const LANG_LOADERS: Record<string, () => Promise<LanguageInput>> = {
  ts: () => loadShikiLanguage('typescript'),
  typescript: () => loadShikiLanguage('typescript'),
  tsx: () => loadShikiLanguage('tsx'),
  mts: () => loadShikiLanguage('typescript'),
  cts: () => loadShikiLanguage('typescript'),
  js: () => loadShikiLanguage('javascript'),
  javascript: () => loadShikiLanguage('javascript'),
  jsx: () => loadShikiLanguage('jsx'),
  mjs: () => loadShikiLanguage('javascript'),
  cjs: () => loadShikiLanguage('javascript'),
  json: () => loadShikiLanguage('json'),
  jsonc: () => loadShikiLanguage('jsonc'),
  json5: () => loadShikiLanguage('json5'),
  html: () => loadShikiLanguage('html'),
  xml: () => loadShikiLanguage('xml'),
  vue: () => loadShikiLanguage('vue'),
  svelte: () => loadShikiLanguage('svelte'),
  css: () => loadShikiLanguage('css'),
  scss: () => loadShikiLanguage('scss'),
  less: () => loadShikiLanguage('less'),
  yml: () => loadShikiLanguage('yaml'),
  yaml: () => loadShikiLanguage('yaml'),
  toml: () => loadShikiLanguage('toml'),
  ini: () => loadShikiLanguage('ini'),
  sh: () => loadShikiLanguage('bash'),
  bash: () => loadShikiLanguage('bash'),
  shell: () => loadShikiLanguage('bash'),
  zsh: () => loadShikiLanguage('bash'),
  shellscript: () => loadShikiLanguage('bash'),
  py: () => loadShikiLanguage('python'),
  python: () => loadShikiLanguage('python'),
  go: () => loadShikiLanguage('go'),
  golang: () => loadShikiLanguage('go'),
  rs: () => loadShikiLanguage('rust'),
  rust: () => loadShikiLanguage('rust'),
  md: () => loadShikiLanguage('markdown'),
  markdown: () => loadShikiLanguage('markdown'),
  sql: () => loadShikiLanguage('sql'),
  c: () => loadShikiLanguage('c'),
  h: () => loadShikiLanguage('c'),
  cpp: () => loadShikiLanguage('cpp'),
  cxx: () => loadShikiLanguage('cpp'),
  java: () => loadShikiLanguage('java'),
  kt: () => loadShikiLanguage('kotlin'),
  kotlin: () => loadShikiLanguage('kotlin'),
  swift: () => loadShikiLanguage('swift'),
  rb: () => loadShikiLanguage('ruby'),
  ruby: () => loadShikiLanguage('ruby'),
  php: () => loadShikiLanguage('php'),
  lua: () => loadShikiLanguage('lua'),
  dockerfile: () => loadShikiLanguage('dockerfile'),
  docker: () => loadShikiLanguage('dockerfile'),
  graphql: () => loadShikiLanguage('graphql'),
  diff: () => loadShikiLanguage('diff'),
  make: () => loadShikiLanguage('makefile'),
  makefile: () => loadShikiLanguage('makefile'),
}

// ─── 引擎单例 ───

let highlighter: HighlighterCore | null = null
let warmPromise: Promise<void> | null = null
/** 已知已加载的语言 id（shiki 名字）。 */
const loadedLangs = new Set<string>()
/** 正在进行的按需加载，以 shiki 语言 id 为键。 */
const pendingLangs = new Map<string, Promise<void>>()

/** 在后台启动引擎初始化。可安全多次调用——后续调用是空操作。永不 reject。 */
export function warmShikiEngine(): void {
  if (highlighter || warmPromise) return
  warmPromise = (async () => {
    const assets = await import('./shiki-assets-common.js')
    const h = await createHighlighterCore({
      themes: assets.themes,
      langs: (await Promise.all(
        EAGER_LANGS.map(async (id) => {
          const loader = LANG_LOADERS[id]
          return loader ? await loader() : null
        }),
      ).then((mods) => mods.filter((m) => m !== null))) as LanguageInput[],
      engine: createOnigurumaEngine(Promise.resolve(assets.wasm)),
    })
    for (const id of EAGER_LANGS) loadedLangs.add(shikiLangId(id))
    highlighter = h
  })().catch(() => {
    // 引擎失败（OOM、坏块……）——永久停留在正则回退上，而不是让 UI 崩溃。
    warmPromise = null
  })
}

/** 把围栏 id / 扩展名归一化到我们的加载器注册的 shiki 语言 id。必须覆盖
 *  LANG_LOADERS 里的每个别名——`loadedLangs` 和 `codeToTokens` 都以归一化
 *  后的 id 为键。 */
function shikiLangId(fenceId: string): string {
  switch (fenceId) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'sh':
    case 'shell':
    case 'zsh':
    case 'shellscript':
      return 'bash'
    case 'py':
      return 'python'
    case 'golang':
      return 'go'
    case 'rs':
      return 'rust'
    case 'rb':
      return 'ruby'
    case 'kt':
      return 'kotlin'
    case 'yml':
      return 'yaml'
    case 'md':
      return 'markdown'
    case 'h':
      return 'c'
    case 'cxx':
      return 'cpp'
    case 'docker':
      return 'dockerfile'
    case 'make':
      return 'makefile'
    default:
      return fenceId
  }
}

/** 如果围栏 id 是我们可以加载但尚未加载的，就在后台开始加载。语言现在就绪
 *  时返回 true。 */
function ensureLang(shikiId: string, fenceId: string): boolean {
  if (loadedLangs.has(shikiId)) return true
  if (!highlighter) return false
  const loader = LANG_LOADERS[fenceId]
  if (!loader) return false
  let pending = pendingLangs.get(shikiId)
  if (!pending) {
    const h = highlighter
    pending = loader()
      .then(async (language) => {
        await h.loadLanguage(language)
        loadedLangs.add(shikiId)
      })
      .catch(() => {
        // 无法加载的语法——视为不支持，停留在回退上。
      })
      .finally(() => pendingLangs.delete(shikiId))
    pendingLangs.set(shikiId, pending)
  }
  return false
}

// ─── Token → ANSI ───

// shiki/vscode-textmate 的 FontStyle 位标志——我们只保留 Bold，并像 codex
// 的 convert_style 那样抑制 Italic/Underline（它们在终端输出里是视觉噪音）。
const FONT_BOLD = 2

interface ShikiToken {
  content: string
  color?: string
  fontStyle?: number
}

/** 把一行 token 渲染成 ANSI。相比朴素的逐 token 上色，有两个吞吐/输出体积
 *  优化：
 *  1. 颜色等于主题默认前景色的 token 原样输出——TextMate 语法会给每个
 *     空格/标识符都打上 fg scope，否则字节数会翻三倍，还白白加重单元格
 *     diff 的负担，视觉上毫无收益。
 *  2. 颜色和 bold 都相同的相邻 token 合并为一段 SGR 序列。 */
function paintLine(tokens: ShikiToken[], themeFg: string | null): string {
  let out = ''
  let pending = ''
  let pendingKey: string | null = null
  for (const t of tokens) {
    if (!t.content) continue
    const color = t.color?.toLowerCase()
    const key = !color || color === themeFg ? null : `${color}${t.fontStyle && t.fontStyle & FONT_BOLD ? 'b' : ''}`
    if (key !== pendingKey) {
      out += flush(pending, pendingKey)
      pending = ''
      pendingKey = key
    }
    pending += t.content
  }
  return out + flush(pending, pendingKey)
}

function flush(text: string, key: string | null): string {
  if (!text) return ''
  if (key === null) return text
  const bold = key.endsWith('b')
  const hex = bold ? key.slice(0, -1) : key
  const fn = c.hex(hex)
  return bold ? fn.bold(text) : fn(text)
}

// ─── 公共 API ───

/** 用 shiki 高亮 `code`（整个代码片段，任意行数），返回可见内容相同的 ANSI
 *  彩色文本。以下情况返回 null——调用方回退到正则高亮器或纯文本——：引擎尚未
 *  预热、当前主题是 `ansi`、围栏语言未知/尚未加载，或输入超出护栏。永不抛异常。 */
export function highlightCodeShiki(code: string, fenceLang: string | undefined): string | null {
  if (!highlighter || !currentShikiTheme || !fenceLang) return null
  if (code.length === 0) return code
  if (code.length > MAX_BYTES) return null
  const lines = code.split('\n')
  if (lines.length > MAX_LINES) return null
  for (const line of lines) {
    if (line.length > MAX_LINE_BYTES) return null
  }

  const fenceId = fenceLang.trim().toLowerCase()
  const shikiId = shikiLangId(fenceId)
  if (!ensureLang(shikiId, fenceId)) return null

  try {
    const theme = highlighter.getTheme(currentShikiTheme)
    const themeFg = (theme as { fg?: string }).fg?.toLowerCase() ?? null
    const { tokens } = highlighter.codeToTokens(code, { lang: shikiId, theme: currentShikiTheme })
    return (tokens as ShikiToken[][]).map((line) => paintLine(line, themeFg)).join('\n')
  } catch {
    // 该输入上的语法/主题小故障——回退，绝不让渲染崩溃。
    return null
  }
}

/** 高亮 shell 命令预览（单行或多行）。先尝试 shiki 引擎，shiki 未就绪或拒绝
 *  该输入时回退到内置正则高亮器。所有 shell 预览调用点（实时工具行、已提交
 *  滚动区行、权限对话框）都必须经过这一个辅助函数，避免各自着色漂移。 */
export function highlightShellCommand(command: string): string {
  return highlightCodeShiki(command, 'shell') ?? highlightLine(command, 'shell')
}

/** 测试钩子：引擎预热完成后为 true。 */
export function isShikiReady(): boolean {
  return highlighter !== null
}
