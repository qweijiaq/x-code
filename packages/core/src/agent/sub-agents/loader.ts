// @x-code-cli/core — 自定义子代理加载器
//
// 扫描 ~/.x-code/agents/*.md 和 <repo-root>/.x-code/agents/*.md，寻找带 YAML frontmatter 的
// 用户自定义子代理。坏文件会被跳过并向 stderr 发警告——单个损坏的代理文件绝不能拖垮 CLI。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { parseFrontmatter } from '../../frontmatter.js'
import { XCODE_DIR, errorMessage, userXcodeDir } from '../../utils.js'
import type { SubAgentDefinition } from './types.js'

/**
 * Claude 插件生态里的 agent 习惯把工具清单写成逗号分隔的字符串
 * （`tools: Glob, Grep, LS, Read`），而不是 YAML 数组。只接受数组会把这类
 * 插件里的 agent 全部静默跳过，所以两种形态都要吃。
 */
const stringList = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined
    if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean)
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  })

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: stringList,
  disallowedTools: stringList,
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  shellRestrictions: stringList,
})

async function loadAgentsFromDir(
  dir: string,
  source: SubAgentDefinition['source'],
  pluginId?: string,
): Promise<SubAgentDefinition[]> {
  const agents: SubAgentDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw, { coerceTypes: true })
      if (!parsed) {
        console.error(`[sub-agents] Skipping ${filePath}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[sub-agents] Skipping ${filePath}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const fm = result.data
      // 正文为空时子代理会收到一份空 system prompt，行为无法定位；按坏文件处理，
      // 与其他跳过路径一样告警后继续扫描。
      const prompt = parsed.body.trim()
      if (!prompt) {
        console.error(`[sub-agents] Skipping ${filePath}: empty agent body (no prompt)`)
        continue
      }
      agents.push({
        name: fm.name,
        description: fm.description,
        prompt,
        tools: fm.tools,
        disallowedTools: fm.disallowedTools,
        model: fm.model,
        maxTurns: fm.maxTurns ?? 30,
        shellRestrictions: fm.shellRestrictions,
        source,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[sub-agents] Skipping ${filePath}: ${errorMessage(err)}`)
    }
  }

  return agents
}

export interface LoadCustomAgentsOptions {
  /** 额外要扫描的子代理目录，连同所属 plugin id。
   *  插件贡献如何变成这个形状，见 packages/core/src/plugins/integration.ts。 */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/** 从用户 + 项目目录，以及任何额外目录（插件贡献）加载自定义子代理。
 *  环境变量 `XC_AGENTS_DIR` 会覆盖内置路径（供测试用；额外目录仍会生效）。 */
export async function loadCustomAgents(opts: LoadCustomAgentsOptions = {}): Promise<SubAgentDefinition[]> {
  const override = process.env.XC_AGENTS_DIR
  if (override) {
    const overrideAgents = await loadAgentsFromDir(override, 'project')
    // 注册表是「后写胜出」：override 必须排在末尾，否则插件目录里的同名 agent
    // 会覆盖掉调用方（测试）明确指定的那一个。
    return [...(await loadAgentsFromExtras(opts.extraDirs)), ...overrideAgents]
  }

  const userDir = path.join(userXcodeDir(), 'agents')
  // process.cwd() 在 cwd 被删除后会抛 ENOENT；单个目录解析失败不能让整个
  // loadCustomAgents reject（文件头约定：坏文件/坏目录都不能拖垮 CLI）。
  let projectDir: string | undefined
  try {
    projectDir = path.join(process.cwd(), XCODE_DIR, 'agents')
  } catch (err) {
    console.error(`[sub-agents] Skipping project agent directory: ${errorMessage(err)}`)
  }

  const userAgents = await loadAgentsFromDir(userDir, 'user')
  const pluginAgents = await loadAgentsFromExtras(opts.extraDirs)
  const projectAgents = projectDir ? await loadAgentsFromDir(projectDir, 'project') : []

  // user → plugin → project。SubAgentRegistry 的 Map.set 会覆盖重名项，
  // 因此靠后的条目胜出——与 skills 的优先级一致。
  return [...userAgents, ...pluginAgents, ...projectAgents]
}

async function loadAgentsFromExtras(extras: LoadCustomAgentsOptions['extraDirs']): Promise<SubAgentDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SubAgentDefinition[] = []
  for (const { dir, pluginId } of extras) {
    out.push(...(await loadAgentsFromDir(dir, 'user', pluginId)))
  }
  return out
}
