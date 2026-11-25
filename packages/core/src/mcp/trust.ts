// @x-code-cli/core — MCP 项目级信任门
//
// 提交进 git 仓库的 `.x-code/config.json` 可以声明带任意 `command` 字符串的
// MCP 服务器——即克隆一个恶意仓库并启动 CLI，会悄悄 spawn 那个命令要做的
// 任何事。因此，在尊重任何项目级 mcpServers 块之前，我们要求一个以绝对项目
// 路径为键的显式同意步骤。
//
// 持久化文件：~/.x-code/trusted-projects.json（mode 0600）。
// 格式：{ trusted: [{ path: <absolute>, trustedAt: <ISO> }, ...] }
//
// 用户配置（~/.x-code/config.json）不受此门约束——用户自己写的；信任是隐式的。
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'

function trustedFile(): string {
  return path.join(userXcodeDir(), 'trusted-projects.json')
}

interface TrustedEntry {
  path: string
  trustedAt: string
}

interface TrustedStore {
  trusted: TrustedEntry[]
}

/** 规范化路径以便跨平台稳定比较。
 *  绝对 + resolved + 在 Windows 上小写（大小写不敏感 FS），
 *  macOS/Linux 上保留大小写。 */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function readStore(): Promise<TrustedStore> {
  try {
    const raw = await fs.readFile(trustedFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TrustedStore).trusted)) {
      // 过滤形状非法的条目：`path.resolve(null)` 会抛 ERR_INVALID_ARG_TYPE，
      // 而 `isProjectTrusted` 在 loader 里位于 try/catch 之外——一个被手工编辑
      // 过 / 半损坏的 trusted-projects.json（`{"trusted":[null]}`）会让 CLI
      // 启动崩溃，而不是安全地回落到"未信任"。
      const trusted = (parsed as TrustedStore).trusted.filter(
        (entry): entry is TrustedEntry =>
          !!entry && typeof entry.path === 'string' && typeof entry.trustedAt === 'string',
      )
      return { trusted }
    }
  } catch {
    // 文件缺失或格式错误——从干净状态开始
  }
  return { trusted: [] }
}

async function writeStore(store: TrustedStore): Promise<void> {
  await fs.mkdir(userXcodeDir(), { recursive: true })
  // 原子写入：tmp + rename。避免进程在写入中途被杀时留下半个文件
  // （信任文件很小，但原则成立——我们绝不想损坏的 JSON 把用户锁在 MCP 之外）。
  //
  // 临时名带进程 / 随机后缀：多个 CLI 实例同时写这份文件时，固定名
  // `trusted-projects.json.tmp` 会被两个进程交替写、先后 rename，产生交错内容
  // 甚至 ENOENT。`mode` 只在创建时生效，若临时文件是上一次崩溃的残留（或以
  // 0644 被别的工具创建过），rename 会把那份宽松权限变成正式的信任文件——
  // 所以写入后必须显式 chmod 收紧。
  const tmp = `${trustedFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, trustedFile())
}

export async function isProjectTrusted(projectPath: string): Promise<boolean> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  return store.trusted.some((e) => normalize(e.path) === normalized)
}

export async function trustProject(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  if (store.trusted.some((e) => normalize(e.path) === normalized)) return
  store.trusted.push({ path: path.resolve(projectPath), trustedAt: new Date().toISOString() })
  await writeStore(store)
}

/** 撤销项目 MCP 信任。下次加载 `.x-code/config.json` 时会重新询问。 */
export async function untrustProject(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  const next = store.trusted.filter((entry) => normalize(entry.path) !== normalized)
  if (next.length === store.trusted.length) return
  await writeStore({ trusted: next })
}

export type TrustChoice = 'trust' | 'skip' | 'exit'

const TRUST_LABEL = 'Trust this project'
const SKIP_LABEL = 'Skip project MCP'
const EXIT_LABEL = 'Exit X-Code'

/** 服务器名 / 命令串来自提交进仓库的 `.x-code/config.json`，是不可信输入。
 *  原样拼进提示文本会带来两类问题：(1) 命令里的 ANSI 转义 / `\r` / `\n` 能在
 *  终端里重绘、覆盖甚至伪造对话框内容，让真实命令隐身；(2) 超长字符串刷屏，
 *  把真正的选项挤出可视区域。 */
const MAX_PREVIEW_CHARS = 512

/** 询问用户是否信任项目的 MCP 配置。
 *
 *  调用方传入一个通用 askUser 回调（与 agent loop 用于 askUser 工具调用的
 *  那个相同），使信任提示以与 UI 其余部分相同的对话框风格渲染。我们展示
 *  实际的命令字符串，使用户能审计将要运行什么。
 *
 *  返回：
 *    'trust' — 用户接受；调用方应通过 trustProject(...) 持久化
 *    'skip'  — 只加载用户级 mcpServers
 *    'exit'  — 调用方应终止 CLI */
export async function promptForTrust(
  projectPath: string,
  serverSummaries: Array<{ name: string; preview: string }>,
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>,
): Promise<TrustChoice> {
  let truncated = false
  const sanitize = (value: string): string => {
    const flattened = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    if (flattened.length <= MAX_PREVIEW_CHARS) return flattened
    truncated = true
    return `${flattened.slice(0, MAX_PREVIEW_CHARS)}…`
  }

  const lines = serverSummaries.map((s) => `  • ${sanitize(s.name)}: ${sanitize(s.preview)}`).join('\n')
  const question =
    // 渲染规范化后的绝对路径：信任是以绝对路径为键的，不显示它，用户就无法
    // 核对到底在同意哪个目录（攻击者可以把仓库放在与已信任目录同名的路径下）。
    `This project (${normalize(projectPath)}) wants to load ${serverSummaries.length} MCP server(s):\n` +
    lines +
    `\n\nThese commands will run on your machine. Trust only if you trust this project.` +
    (truncated ? `\n(Some commands were truncated — see .x-code/config.json for the full text.)` : '')

  const answer = await askUser(question, [
    { label: TRUST_LABEL, description: 'Remember this choice. The project MCP servers will load.' },
    { label: SKIP_LABEL, description: 'Use only user-level mcpServers for this session. No write to disk.' },
    { label: EXIT_LABEL, description: 'Close the CLI without loading any MCP servers.' },
  ])

  // 全等比较而非前缀匹配：UI 可能改变标签大小写（"Trust this project" →
  // "Allow"），前缀匹配会静默落到 'skip' 丢掉用户已确认的信任；部分 askUser
  // 实现还允许自由输入（Other），"trusted earlier" 这类文本不该通过。
  // 回调 resolve 出 undefined/null 时也不再抛错。
  const normalized = typeof answer === 'string' ? answer.trim().toLowerCase() : ''
  if (normalized === TRUST_LABEL.toLowerCase()) return 'trust'
  if (normalized === EXIT_LABEL.toLowerCase()) return 'exit'
  return 'skip'
}

/** 构建信任对话框中每个服务器展示的单行预览。Stdio 服务器暴露其完整
 *  command + args；HTTP 服务器展示 URL。我们刻意不截断——用户需要看到
 *  全貌才能做出知情的决定。 */
export function buildServerPreview(config: { command?: string; args?: string[]; url?: string }): string {
  // loader 把从磁盘读到的原始配置（未经 schema 校验）直接断言成这个形状，所以
  // 不能相信声明类型：`args` 若是数字 / 布尔，扩展运算符会抛
  // `TypeError: x is not iterable` 崩掉整个信任视图；`command` / `url` 若是对象
  // 会渲染成 `[object Object]`，让用户在信息缺失的情况下点「信任」。
  const raw = config as { command?: unknown; args?: unknown; url?: unknown }
  if (typeof raw.url === 'string' && raw.url) return raw.url
  if (typeof raw.command === 'string' && raw.command) {
    const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : []
    return [raw.command, ...args].join(' ')
  }
  return '(invalid config)'
}
