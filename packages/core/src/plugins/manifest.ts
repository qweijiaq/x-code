// @x-code-cli/core — 插件 manifest 发现 + zod 校验
//
// 只做一件事：给定磁盘上的插件根目录，找到它的 manifest（按优先级探测
// 三个被接受的相对路径），解析并校验 JSON，然后返回一个 `PluginManifest`。
// 贡献路径的解析与作用域 / 启用状态的判断由调用方负责。
//
// manifest 中未知的顶层字段会被静默剥除（zod 对 `z.object` 的默认行为）。
// 这是有意的：让带有我们不懂字段（如 `output-styles`、`lspServers`）的
// 较新 Claude Code manifest 仍能解析——我们只是不响应这些字段。`/plugin
// doctor` 随后会把它们呈现为“已加载但贡献了 X 个不支持的字段”，让用户
// 知道他们得到的是部分行为。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { errorMessage, fileExists } from '../utils.js'
import { GEMINI_MANIFEST_REL, MANIFEST_CANDIDATES, isSafePluginPathComponent } from './paths.js'
import type { ManifestFormat, PluginManifest } from './types.js'

// ── Zod schema ─────────────────────────────────────────────────────────

const authorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
])

const userConfigItemSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  sensitive: z.boolean().optional(),
  prompt: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
})

/** 有些贡献字段既接受相对路径（string），也接受内联对象——Claude Code 的
 *  `mcpServers` 和 `hooks` 就是这种。这里不校验内联对象的形状；那是 mcp /
 *  hooks 子系统的事，它们已有自己的 schema。 */
const pathOrInline = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

/** 插件名：小写字母、数字、短横线；必须以字母或数字开头。与 Claude Code /
 *  Codex / Gemini 一致，并保证名字在 Windows 上可用作文件系统路径组件。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const manifestSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z
    .string()
    .min(1)
    .regex(NAME_RE, 'name must be lowercase letters, digits, and dashes only (e.g. "linear-issues")')
    .refine(isSafePluginPathComponent, 'name is reserved or unsafe as a cross-platform filesystem component'),
  // version 在真实 Claude Code 插件里是可选的（已对照
  // anthropics/claude-plugins-official 验证——许多插件不带该字段，包括
  // amplitude 这类主流第三方插件）。我们默认填 "0.0.0"，好让缓存路径和
  // installed_plugins.json 记录仍有一个可用字符串。
  version: z
    .string()
    .min(1)
    .refine(isSafePluginPathComponent, 'version must be one safe cross-platform filesystem component')
    .optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  keywords: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),

  skills: z.string().min(1).optional(),
  agents: z.string().min(1).optional(),
  commands: z.string().min(1).optional(),
  mcpServers: pathOrInline.optional(),
  hooks: pathOrInline.optional(),

  userConfig: z.array(userConfigItemSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  engines: z.object({ 'x-code': z.string().optional() }).optional(),
})

// ── 发现 ───────────────────────────────────────────────────────────

export interface ManifestDiscovery {
  /** manifest 文件的绝对路径。 */
  manifestPath: string
  format: ManifestFormat
}

/** 探测插件根目录的 manifest。返回优先级最高的匹配。当只存在 Gemini
 *  manifest 时返回 `{ format: 'gemini', ... }`——安装器借此给出友好的
 *  “我们不支持 Gemini 扩展”错误，而不是令人困惑的“未找到 manifest”。 */
export async function discoverManifest(rootDir: string): Promise<ManifestDiscovery | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const full = path.join(rootDir, candidate.rel)
    if (await fileExists(full)) {
      return { manifestPath: full, format: candidate.format }
    }
  }
  const gemini = path.join(rootDir, GEMINI_MANIFEST_REL)
  if (await fileExists(gemini)) {
    return { manifestPath: gemini, format: 'gemini' }
  }
  return null
}

// ── 解析 ─────────────────────────────────────────────────────────────

export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly manifestPath: string,
  ) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

/** 解析并校验 manifest JSON 文件。缺省时填 `schemaVersion: "1"`（隐式默认
 *  值——多数既有 Claude Code 插件都不设此字段）。失败时抛带路径标记消息的
 *  `ManifestParseError`，让 loader 能把它收集为 doctor 条目而不中止整个
 *  启动。 */
export async function parseManifest(manifestPath: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch (err) {
    throw new ManifestParseError(`failed to read manifest: ${errorMessage(err)}`, manifestPath)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ManifestParseError(`manifest is not valid JSON: ${errorMessage(err)}`, manifestPath)
  }

  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ManifestParseError(`invalid manifest — ${issues}`, manifestPath)
  }

  const data = result.data
  return {
    ...data,
    schemaVersion: data.schemaVersion ?? '1',
    version: data.version ?? '0.0.0',
    // 归一化 author 联合类型——内部调用方只处理对象形式。字符串作者会被
    // 转成 `{ name: <string> }`。
    author: typeof data.author === 'string' ? { name: data.author } : data.author,
  }
}
