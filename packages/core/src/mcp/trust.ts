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
      return parsed as TrustedStore
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
  const tmp = trustedFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
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

export type TrustChoice = 'trust' | 'skip' | 'exit'

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
  _projectPath: string,
  serverSummaries: Array<{ name: string; preview: string }>,
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>,
): Promise<TrustChoice> {
  const lines = serverSummaries.map((s) => `  • ${s.name}: ${s.preview}`).join('\n')
  const question =
    `This project wants to load ${serverSummaries.length} MCP server(s):\n` +
    lines +
    `\n\nThese commands will run on your machine. Trust only if you trust this project.`

  const answer = await askUser(question, [
    { label: 'Trust this project', description: 'Remember this choice. The project MCP servers will load.' },
    { label: 'Skip project MCP', description: 'Use only user-level mcpServers for this session. No write to disk.' },
    { label: 'Exit X-Code', description: 'Close the CLI without loading any MCP servers.' },
  ])

  const lower = answer.toLowerCase()
  if (lower.startsWith('trust')) return 'trust'
  if (lower.startsWith('exit')) return 'exit'
  return 'skip'
}

/** 构建信任对话框中每个服务器展示的单行预览。Stdio 服务器暴露其完整
 *  command + args；HTTP 服务器展示 URL。我们刻意不截断——用户需要看到
 *  全貌才能做出知情的决定。 */
export function buildServerPreview(config: { command?: string; args?: string[]; url?: string }): string {
  if (config.url) return config.url
  if (config.command) {
    const parts = [config.command, ...(config.args ?? [])]
    return parts.join(' ')
  }
  return '(invalid config)'
}
