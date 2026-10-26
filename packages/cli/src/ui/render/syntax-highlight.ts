// @x-code-cli/cli — diff 渲染器的逐行语法高亮器。
//
// 为什么自己写：我们考察过的每个现成 Node 终端高亮器（cli-highlight、
// chalk-highlight 等）要么拉进 highlight.js（约 600KB），要么已经多年没发版。
// 这里的 diff 用例很窄——每个 diff 只高亮约 60 行、深色背景，且只需要识别
// 常见的 token 类别。约 150 行正则就能换来 80% 的视觉收益，依赖体量只有
// 0.1%。
//
// 逐行处理：高亮器一次处理一行 diff。这意味着状态不会跨行保留（被 hunk 边界
// 拆开的块注释无法在上下文行间持续高亮），但这与 Claude Code StructuredDiff
// 回退的渲染方式一致——每一行都是独立的 React 节点。对 diff 用例来说这个
// 限制在实践中不可见：hunk 的上下文窗口只有 3 行，而一个 `/* ... */` 恰好横跨
// 那几行的情况极其罕见。
//
// 主题系统：一组命名调色板（one-dark、monokai、github-light、ansi）。活动
// 调色板保存在模块级 ref 中，启动时从 `~/.x-code/config.json` 初始化，运行时
// 由 `/theme` 翻转（每个 UI 主题都捆绑一个语法调色板）。任何想拿当前调色板的
// 渲染路径都以不带 theme 参数的方式调用 `highlightLine`——这会取到实时的模块
// ref。测试和预览可以传显式主题来绕过全局。
import { chalk as c } from './tokens.js'

// ─── 主题 ───

/** 高亮器产出的 token 类别。每个主题把这些类别映射到颜色。
 *
 *  `storage` 从 `keyword` 里拆出来，是为了对齐 CC / syntect 的约定：
 *  控制流关键字（`if`、`return`、`throw`）用 `keyword`，声明关键字
 *  （`const`、`let`、`function`、`class`、`interface`）用 `storage`。
 *  在 Monokai 里两者分别是亮粉和青色——不拆的话 `function` 会和 `if`
 *  同色，与 CC 不符。参见 CC color-diff/index.ts:248-265。 */
type Token = 'keyword' | 'storage' | 'type' | 'string' | 'number' | 'comment' | 'function' | 'literal'

/** 调色板：一种颜色（hex `#rrggbb`、`'magenta'` 这类 ANSI 名，或 `null`
 *  表示「不动前景色——用终端默认」）。 */
type ColorSpec = string | null
type Palette = Record<Token, ColorSpec>

/** 内置语法主题。名字用小写连字符。
 *
 *  两个调色板派生自 CC：`monokai`（CC 的「Monokai Extended」——所有深色
 *  `/theme` 模式都捆绑它）和 `github-light`（CC 的「GitHub」——所有浅色
 *  `/theme` 模式都捆绑它）。其余名字早于对齐 CC 的工作。 */
export type SyntaxThemeName = 'one-dark' | 'monokai' | 'github-light' | 'ansi'

const THEMES: Record<SyntaxThemeName, Palette> = {
  // One Dark——Atom 的标志性主题。深色背景上平静、均衡的对比度。对多数
  // 用户是不错的默认。
  'one-dark': {
    keyword: '#c678dd', // 紫
    storage: '#c678dd', // 紫——One Dark 把 storage 与 keyword 归为一组
    type: '#e5c07b', // 沙黄
    string: '#98c379', // 苔绿
    number: '#d19a66', // 暖橙
    comment: '#7f848e', // 暗冷灰
    function: '#61afef', // 亮蓝
    literal: '#d19a66', // 橙（与数字同族）
  },
  // Monokai——Sublime Text 的经典。有力、高饱和。值逐字节对齐 CC 的
  // MONOKAI_SCOPES（native-ts/color-diff/index.ts:190-215），让深色模式
  // diff 渲染出与 Claude Code「Monokai Extended」syntect 主题相同的语法色。
  monokai: {
    keyword: '#f92672', // 亮粉——控制关键字（if/return/throw）
    storage: '#66d9ef', // 青——声明关键字（const/let/function/class）
    type: '#a6e22e', // 黄绿——类型、内建
    string: '#e6db74', // 柔黄
    number: '#be84ff', // 柔紫——数字/字面量（CC rgb 190,132,255）
    comment: '#75715e', // 棕灰
    function: '#a6e22e', // 黄绿——函数/类标题（CC 与类型归为一组）
    literal: '#be84ff', // 柔紫
  },
  // GitHub Light——值逐字节对齐 CC 的 GITHUB_SCOPES（native-ts/color-diff/
  // index.ts:218-243）。为浅色终端调校：在白色上清晰可读的深饱和色。
  // 与 light / light-daltonized 的 /theme 模式捆绑。
  'github-light': {
    keyword: '#a71d5d', // 深品红——控制关键字
    storage: '#a71d5d', // 深品红——GitHub 把 storage 与 keyword 归为一组
    type: '#0086b3', // 青绿——类型、内建、数字、字面量
    string: '#183691', // 藏青——字符串
    number: '#0086b3', // 青绿
    comment: '#969896', // 中灰
    function: '#795da3', // 紫——函数/类标题
    literal: '#0086b3', // 青绿
  },
  // ANSI——使用终端的 16 色调色板（chalk 命名色）。在任何地方看起来都正确，
  // 甚至哑终端也行；用保真度换兼容性。值逐字节对齐 CC 的 `ANSI_SCOPES`
  // （color-diff/index.ts:267-280）：每项都用 `ansiIdx(N)` 且 N 在 10-14 区间，
  // 即亮色调色板那一半。我们此前用的是普通 0-7 的名字，让 ANSI 模式明显比
  // CC 暗/不饱和。映射：
  //   keyword         = ansiIdx(13) = 亮品红
  //   _storage        = ansiIdx(14) = 亮青
  //   built_in / type = ansiIdx(14) = 亮青
  //   string          = ansiIdx(10) = 亮绿
  //   number / literal = ansiIdx(12) = 亮蓝
  //   title.function  = ansiIdx(11) = 亮黄
  //   comment         = ansiIdx(8)  = 亮黑（chalk `gray`）
  ansi: {
    keyword: 'magentaBright',
    storage: 'cyanBright',
    type: 'cyanBright',
    string: 'greenBright',
    number: 'blueBright',
    comment: 'gray',
    function: 'yellowBright',
    literal: 'blueBright',
  },
}

const DEFAULT_SYNTAX_THEME: SyntaxThemeName = 'one-dark'

/** 活动主题——当 `highlightLine` 未传显式 theme 参数时读取。初始化为默认值；
 *  启动时（从用户配置）由 `setSyntaxTheme` 翻转，用户运行 `/theme` 时再次翻转。 */
let currentTheme: SyntaxThemeName = DEFAULT_SYNTAX_THEME

export function setSyntaxTheme(name: SyntaxThemeName): void {
  currentTheme = name
}

// ─── 语言检测 ───

/** 我们为之写了专门分词规则的语言。不在此集合里的都回退到纯文本
 *  （不高亮），那仍然是合法渲染——只是不那么花哨。 */
type Lang = 'js' | 'json' | 'html' | 'css' | 'yaml' | 'shell' | 'python' | 'go' | 'rust' | 'md'

/** 供文件扩展名（detectLanguage 用）和 markdown 围栏语言标识
 *  （detectFenceLanguage 用）共用的单一查找表。键是小写。多数条目两种上下文
 *  都合法（如 `ts`、`py`、`rs`）；`typescript`、`python`、`golang`、`rust`、
 *  `javascript`、`shell` 这类仅围栏别名对文件路径根本不匹配（扩展名不用这些
 *  形式）。`mts` / `cts` 这类仅扩展名的条目对围栏实际上也不会匹配。 */
const LANG_LOOKUP: Record<string, Lang> = {
  // JS / TS 族——共用一个分词器（`interface`、`type`、`enum` 这类 TS 写法
  // 当关键字处理；分词器刻意宽容，裸 JS 里的误报在视觉上也不碍眼）。
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  vue: 'js', // Vue SFC 大多是 TS——对 diff 显示来说足够接近
  svelte: 'js',
  // 数据格式
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  // Web（网页）
  html: 'html',
  htm: 'html',
  xml: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  // 配置
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'yaml', // 对 diff 上色来说足够接近（key=value、字符串、数字）
  // Shell 脚本
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  // 其他
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  md: 'md',
  markdown: 'md',
}

export function detectLanguage(filePath: string): Lang | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath)
  if (!m) return null
  return LANG_LOOKUP[m[1]!.toLowerCase()] ?? null
}

/** 把 markdown 围栏语言标识（围栏代码块开头 ``` 后面的那部分）映射到我们
 *  支持的某个 `Lang` 值。围栏没有语言提示、或语言未覆盖时返回 null——
 *  调用方回退到纯（不高亮）文本。 */
export function detectFenceLanguage(fenceLang: string | undefined): Lang | null {
  if (!fenceLang) return null
  return LANG_LOOKUP[fenceLang.trim().toLowerCase()] ?? null
}

// ─── 分词 ───

interface Rule {
  re: RegExp
  token: Token
}

/** 从规则集构建单一 sticky 正则（`y` 标志，锚定在 lastIndex）。我们在当前
 *  位置按顺序试每条规则；第一个匹配的胜出。模式必须写得避免灾难性回溯——
 *  全程保持简单且有界。 */
function makeRules(rules: { re: RegExp; token: Token }[]): Rule[] {
  return rules.map(({ re, token }) => ({
    // 强制 sticky，好让下面的循环能逐位置扫描。原始 `re` 可能已经带 `y`；
    // 若没有，就用同样的 pattern + sticky 标志重建一个。
    re: re.flags.includes('y') ? re : new RegExp(re.source, re.flags + 'y'),
    token,
  }))
}

/** 存储/声明关键字——用 `storage` token 色渲染，对齐 CC 的 `_storage` scope
 *  （color-diff/index.ts:248-265）。跨语言一份全局集合：hljs / syntect 不管
 *  源语言都把这几类当同一个 scope，而且这些词不会与任何需要不同着色的东西
 *  重叠。 */
const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

/** JS / TS 全局「support」对象——hljs 归为 `built_in`、CC 的 MONOKAI_SCOPES
 *  涂成黄绿色（color-diff/index.ts:193）。把它们路由到 `function` 调色板槽，
 *  正是这让 `console.log(...)` 呈现为**绿色** `console` + 普通 `log`——与 CC
 *  一致。没有它，我们之前的「后跟 `(` 的标识符」启发式会把 `log`（方法）涂绿、
 *  让 `console`（全局）保持普通，用户指出那恰是 CC 的反转。 */
const JS_GLOBALS = new Set([
  'console',
  'globalThis',
  'window',
  'document',
  'process',
  'module',
  'exports',
  'require',
  '__dirname',
  '__filename',
  'global',
  'self',
  'Math',
  'JSON',
  'Symbol',
  'Reflect',
  'Atomics',
  'Intl',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Proxy',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
])

const KEYWORDS_JS = new Set([
  'await',
  'async',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'as',
  'declare',
  'namespace',
  'satisfies',
  'override',
])

const LITERALS_JS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const KEYWORDS_PYTHON = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

const KEYWORDS_GO = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'true',
  'false',
  'nil',
])

const KEYWORDS_RUST = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
])

const KEYWORDS_SHELL = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'function',
  'in',
  'return',
  'exit',
  'export',
  'local',
  'readonly',
  'unset',
  'echo',
  'printf',
  'source',
])

/** 简单语法语言的关键字分类：在语言的关键字集合里查词，可选地把 PascalCase
 *  归类为类型。JS 有自己更丰富的逻辑（LITERALS / GLOBALS / PascalCase），所以
 *  不在这张表里。 */
const KEYWORD_RULES: Partial<Record<Lang, { keywords: Set<string>; pascalAsType?: boolean }>> = {
  python: { keywords: KEYWORDS_PYTHON, pascalAsType: true },
  go: { keywords: KEYWORDS_GO, pascalAsType: true },
  rust: { keywords: KEYWORDS_RUST, pascalAsType: true },
  shell: { keywords: KEYWORDS_SHELL },
}

// ─── 各语言的规则表 ───
//
// 每条规则列表在每个字节位置按顺序尝试。第一条匹配的规则消费那些字符并产出一段
// 着色片段。关键：注释 / 字符串 / 数字规则必须排在标识符规则之前，这样 `"if"` 这种
// 字符串里的 `if` 才不会被当成关键字高亮。

function jsRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    // 有界的块注释，保持正则不至于灾难性——一行超过 500 字符的东西反正也是
    // 病态输入，宁可放弃也别挂起。
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /`(?:[^`\\]|\\.){0,500}`/, token: 'string' },
    { re: /0[xX][0-9a-fA-F]+n?/, token: 'number' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/, token: 'number' },
    // 声明名捕获：`function` / `class` / `interface` / `type` / `enum` /
    // `namespace` 之后的下一个标识符在 hljs 里是 `title.*` scope。我们把它们
    // 全部折叠到 `function` token，因为 CC 的三个主题对 `title.function` 和
    // `title.class` 的处理完全相同：monokai 黄绿、ansi 亮黄。（github-light
    // 是唯一的例外——那里 `title.class` 是黑色，但我们把类名留在 `function` 槽
    // 以保持 monokai/ansi 模式下正确，用户在这些模式下能更明显看出差别。）
    {
      re: /(?<=\b(?:function|class|interface|type|enum|namespace)\s+)[A-Za-z_$][\w$]*/,
      token: 'function',
    },
    // 通用标识符——keyword / literal / global / type 的查询发生在 paint() 里。
    // 注意：我们刻意不在这里放通用的「后跟 `(` 的标识符」规则。按 CC 的 hljs
    // scoping，`obj.method(...)` 这类方法调用把 `method` 涂成 `property`
    // （= 默认前景色，无色），而不是函数名。之前的启发式把 `log` 涂成黄绿——
    // 与 CC 正好颠倒。函数调用现在按设计保持普通。
    { re: /[A-Za-z_$][\w$]*/, token: 'keyword' },
  ])
}

function jsonRules(): Rule[] {
  return makeRules([
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /\b(?:true|false|null)\b/, token: 'literal' },
  ])
}

function htmlRules(): Rule[] {
  return makeRules([
    { re: /<!--[\s\S]{0,500}?-->/, token: 'comment' },
    // 标签名：`<TagName` 和 `</TagName`。黄色。
    { re: /<\/?[A-Za-z][\w-]*/, token: 'type' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 属性名——不完美（也会匹配松散的 id）但足够接近。
    { re: /\b[a-zA-Z_:][\w:.-]*(?=\s*=)/, token: 'function' },
  ])
}

function cssRules(): Rule[] {
  return makeRules([
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 带 `.foo`、`#bar`、`:hover` 的选择器——黄色。
    { re: /[#.][a-zA-Z_-][\w-]*/, token: 'type' },
    { re: /:[a-zA-Z-]+(?:\([^)]*\))?/, token: 'function' },
    // 属性名（标识符后直接跟 `:`）。
    { re: /\b[a-zA-Z-]+(?=\s*:)/, token: 'function' },
    // #hex 颜色和数字值（可带单位）。
    { re: /#[0-9a-fA-F]{3,8}\b/, token: 'number' },
    { re: /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms|fr)?\b/, token: 'number' },
  ])
}

function yamlRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 后跟 `:` 的键（在行的开头附近；我们不跟踪位置，所以这是近似的）。
    { re: /\b[a-zA-Z_][\w-]*(?=\s*:)/, token: 'function' },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/i, token: 'literal' },
    { re: /-?\b\d+(?:\.\d+)?\b/, token: 'number' },
  ])
}

function shellRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'[^'\n]{0,500}'/, token: 'string' },
    // 变量：$VAR 或 ${VAR}。
    { re: /\$\{[^}\n]{1,200}\}|\$[A-Za-z_]\w*/, token: 'literal' },
    // 选项标志（`-la`、`--check`）。syntect 把这些归为 `variable.parameter`；
    // 我们路由到 `storage`（monokai 里是青 / ansi 里是亮青）——这正是让 codex
    // 的 `Ran …` 行读起来像高亮命令的原因。必须排在数字规则之前，以免
    // `--verbose` 被半匹配成一串数字，也要排在标识符规则之前，以免 `-la` 被拆成
    // `-` + 单词。
    { re: /-{1,2}[A-Za-z][\w-]*/, token: 'storage' },
    { re: /-?\b\d+\b/, token: 'number' },
    { re: /[A-Za-z_][\w-]*/, token: 'keyword' },
  ])
}

function pythonRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    // 三引号字符串（单行——多行反正也扛不住逐行分词）。
    { re: /"""(?:[^"\\]|\\.){0,500}"""/, token: 'string' },
    { re: /'''(?:[^'\\]|\\.){0,500}'''/, token: 'string' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function goRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /`[^`]{0,500}`/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // 字符字面量（rune）
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function rustRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // 字符字面量
    { re: /\b\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?(?:[uif]\d+|usize|isize)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*!/, token: 'function' }, // 宏
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function mdRules(): Rule[] {
  return makeRules([
    { re: /^#{1,6}\s.*/, token: 'type' }, // 标题
    { re: /\*\*[^*\n]{1,200}\*\*/, token: 'keyword' },
    { re: /`[^`\n]{1,200}`/, token: 'string' },
    { re: /\[[^\]\n]{1,200}\]\([^)\n]{1,200}\)/, token: 'function' },
  ])
}

const RULES_BY_LANG: Record<Lang, () => Rule[]> = {
  js: jsRules,
  json: jsonRules,
  html: htmlRules,
  css: cssRules,
  yaml: yamlRules,
  shell: shellRules,
  python: pythonRules,
  go: goRules,
  rust: rustRules,
  md: mdRules,
}

// ─── Token 着色 ───

/** 从活动调色板应用一种颜色规格。hex 字符串走 `chalk.hex`；命名的 ANSI 颜色走
 *  chalk 的命名访问器；null 规格原样返回文本（用于标识符分类落空、单词不匹配任何
 *  已知 keyword/type 模式时的回退）。 */
export function applyColor(text: string, spec: ColorSpec): string {
  if (spec === null) return text
  if (spec.startsWith('#')) return c.hex(spec)(text)
  // 命名的 ANSI 颜色——一次小型访问器查找。chalk 把它标成可链式 getter，
  // 但我们只需要常见的 8/16 色。
  const named = (c as unknown as Record<string, (s: string) => string>)[spec]
  if (typeof named === 'function') return named(text)
  return text
}

/** 默认前景色回退。paint() 和 highlightLine 里未匹配字符的循环用它，让 diff 行里
 *  的纯文本获得与 CC `Theme.foreground` 相同的亮奶油色/深灰色。`defaultFg` 为
 *  null/undefined 时原样落空。 */
function paintDefault(text: string, defaultFg: ColorSpec | undefined): string {
  if (!defaultFg) return text
  return applyColor(text, defaultFg)
}

function paint(text: string, token: Token, lang: Lang, palette: Palette, defaultFg?: ColorSpec): string {
  // 标识符后分类：对于同一条正则匹配关键字 / 字面量 / 通用标识符的语言，我们
  // 依据源词重新分桶。这让规则表保持扁平。
  if (token === 'keyword') {
    const word = text
    // 存储关键字在所有语言都路由到 `storage` 调色板槽——`function`/`const`/
    // `class`/`def`/`fn`/`struct` 等呈现为青（Monokai）/ 品红（GitHub），而不是
    // 与控制流关键字同一种亮粉。对齐 CC scopeColor 的 STORAGE_KEYWORDS 检查
    // （color-diff/index.ts:459-461）。
    if (STORAGE_KEYWORDS.has(word)) return applyColor(text, palette.storage)
    if (lang === 'js') {
      if (KEYWORDS_JS.has(word)) return applyColor(text, palette.keyword)
      if (LITERALS_JS.has(word)) return applyColor(text, palette.literal)
      // 已知 JS 全局（`console`、`Math`、`JSON`、...）→ palette.type。
      // 理由：hljs 把它们归为 `built_in`，而在 CC 的三个语法主题里 `built_in`
      // 和 `type` 总是同色（monokai 黄绿 / github-light 青绿 / ansi 亮青）。
      // `function` 槽保留给 `title.function`（`greet` 这类声明名），后者在
      // github-light（紫）和 ANSI（亮黄）里不同。
      if (JS_GLOBALS.has(word)) return applyColor(text, palette.type)
      // 启发式：PascalCase 标识符极可能是类型/类名。便宜，在常见惯用代码上
      // 没有假阴性。
      if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    const rule = KEYWORD_RULES[lang]
    if (rule) {
      if (rule.keywords.has(word)) return applyColor(text, palette.keyword)
      if (rule.pascalAsType && /^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    return applyColor(text, palette.keyword)
  }
  if (token === 'storage') return applyColor(text, palette.storage)
  if (token === 'string') return applyColor(text, palette.string)
  if (token === 'number') return applyColor(text, palette.number)
  if (token === 'comment') return applyColor(text, palette.comment)
  if (token === 'function') return applyColor(text, palette.function)
  if (token === 'type') return applyColor(text, palette.type)
  if (token === 'literal') return applyColor(text, palette.literal)
  return paintDefault(text, defaultFg)
}

// ─── 主入口 ───

/** 用命名主题（省略时用活动模块级主题）高亮一行代码。返回 ANSI 彩色文本，
 *  可见宽度与输入完全一致——只加转义码，不替换字符。
 *
 *  `lang` 为 null（不认识的扩展名）时，输出（无 `defaultFg`）与输入一致。有
 *  `defaultFg` 时，所有字符都获得前景色，让 diff 背景上未高亮的文本匹配 CC 更亮的
 *  奶油色/深灰色，而不是终端默认白。 */
export function highlightLine(
  line: string,
  lang: Lang | null,
  theme?: SyntaxThemeName,
  defaultFg?: string | null,
): string {
  if (line.length === 0) return line

  // 不认识的语言：如果有 defaultFg 就把整行涂上（这样没有 Python 规则的
  // Python diff 仍能获得亮奶油色前景在背景上），否则原样。
  if (lang === null) {
    return defaultFg ? applyColor(line, defaultFg) : line
  }

  const palette = THEMES[theme ?? currentTheme]
  const rules = RULES_BY_LANG[lang]()
  let pos = 0
  let out = ''
  const len = line.length

  while (pos < len) {
    let matched = false
    for (const r of rules) {
      r.re.lastIndex = pos
      const m = r.re.exec(line)
      if (m && m.index === pos && m[0].length > 0) {
        out += paint(m[0], r.token, lang, palette, defaultFg ?? undefined)
        pos += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      // 没有规则匹配——用 defaultFg 涂一个字符（或原样透传）。这捕获了标点
      // `(`、`)`、`;`、`{`、`}` 等——CC 的 hljs 把它们归为 `punctuation`
      // （= theme.foreground）。单字符推进保证循环有界。
      out += defaultFg ? applyColor(line[pos]!, defaultFg) : line[pos]!
      pos++
    }
  }
  return out
}
