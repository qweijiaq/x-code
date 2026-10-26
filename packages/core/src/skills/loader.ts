// @x-code-cli/core — Skill 加载器
//
// 扫描 ~/.x-code/skills/*/SKILL.md 和 <repo-root>/.x-code/skills/*/SKILL.md，
// 查找带 YAML frontmatter 的用户自定义技能。子目录布局与所有主要竞品
// （Gemini CLI、Opencode、Codex）保持一致，并允许在 SKILL.md 旁边放置未来的
// 支持文件。
//
// 优先级：项目级技能覆盖同名用户级技能。坏文件以警告形式跳过——一个损坏的
// SKILL.md 绝不能导致 CLI 崩溃。
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { parseFrontmatter } from '../frontmatter.js'
import { XCODE_DIR, errorMessage, userXcodeDir } from '../utils.js'
import type { SkillDefinition } from './registry.js'

const SKILL_FILENAME = 'SKILL.md'

/** 每个技能列出的文件数的硬上限——即使技能附带几十个 references / assets /
 *  scripts，也能让激活载荷保持有界。超出此值的技能会追加一个截断标记，
 *  让模型知道该列表并非完整。 */
const MAX_LISTED_FILES = 50

/** 列出技能自带文件时要跳过的目录名——隐藏目录以及几乎不含技能资源的
 *  明显大目录。按 basename 匹配，而非 glob。 */
const SKILL_FILE_LIST_SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'runtime',
  'models',
  'dist',
  'build',
  'target',
])

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
})

/** 遍历技能目录并返回其非隐藏文件的相对路径（排除 SKILL.md 本身）。在
 *  加载时使用，这样 SkillRegistry 就有一份可直接注入的自带资源列表——
 *  Opencode 和 Gemini CLI 在激活时也做同样的列举，但 X-Code 把它随
 *  SkillDefinition 一起缓存，因为 registry 本就会话内冻结（`/skill refresh`
 *  会重建）。 */
async function listSkillFiles(skillDir: string): Promise<string[]> {
  const out: string[] = []

  async function walk(currentDir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKILL_FILE_LIST_SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(currentDir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(currentDir, entry.name)
      const rel = path.relative(skillDir, fullPath).split(path.sep).join('/')
      if (rel === SKILL_FILENAME) continue
      out.push(rel)
    }
  }

  await walk(skillDir)
  return out.sort()
}

/** 查找 SKILL.md 目录。同时支持 `skills/<name>/SKILL.md` 和某些第三方安装器
 *  使用的嵌套 `skills/@scope/<name>/SKILL.md` 布局。包含 SKILL.md 的目录被
 *  视为技能根目录，不再向下递归。 */
async function findSkillDirs(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries
      .filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKILL_FILE_LIST_SKIP_DIRS.has(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of dirs) {
      const full = path.join(dir, entry.name)
      try {
        await fs.access(path.join(full, SKILL_FILENAME))
        out.push(full)
        continue
      } catch {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return out
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition['source'],
  pluginId?: string,
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  for (const skillDir of await findSkillDirs(dir)) {
    const skillFile = path.join(skillDir, SKILL_FILENAME)

    try {
      await fs.access(skillFile)
    } catch {
      continue
    }

    try {
      const raw = await fs.readFile(skillFile, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[skills] Skipping ${skillFile}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[skills] Skipping ${skillFile}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const files = await listSkillFiles(skillDir)

      skills.push({
        name: result.data.name,
        description: result.data.description,
        content: parsed.body.trim(),
        source,
        dir: skillDir,
        files,
        ...(pluginId ? { pluginId } : {}),
      })
    } catch (err) {
      console.error(`[skills] Skipping ${skillFile}: ${errorMessage(err)}`)
    }
  }

  return skills
}

export interface LoadSkillsOptions {
  /** 在内置的 user + project 路径之后额外扫描的技能目录。用于把插件贡献的
   *  `skills/` 目录并入同一个 registry——见 packages/core/src/plugins/integration.ts。
   *  顺序很重要：后出现的条目在名称冲突时胜出。插件技能在项目技能之前扫描
   *  （这样用户编写的项目技能可以覆盖同名插件技能）。 */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string }>
}

/** 从 user + project 目录加载技能，外加任何传入的 extra dirs（插件系统用它
 *  来并入插件贡献的技能目录）。环境变量 `XC_SKILLS_DIR` 覆盖内置路径以便测试
 *  （extras 仍会被尊重）。 */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<SkillDefinition[]> {
  const override = process.env.XC_SKILLS_DIR
  if (override) {
    const overrideSkills = await loadSkillsFromDir(override, 'project')
    return [...overrideSkills, ...(await loadFromExtras(opts.extraDirs))]
  }

  const userDir = path.join(userXcodeDir(), 'skills')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'skills')

  const userSkills = await loadSkillsFromDir(userDir, 'user')
  const pluginSkills = await loadFromExtras(opts.extraDirs)
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // 合并顺序——registry 中后写者胜出（项目覆盖插件，插件覆盖用户内置）。
  // 这与我们告知用户的优先级一致：项目级技能始终覆盖任何来自插件的技能。
  return [...userSkills, ...pluginSkills, ...projectSkills]
}

async function loadFromExtras(extras: LoadSkillsOptions['extraDirs']): Promise<SkillDefinition[]> {
  if (!extras || extras.length === 0) return []
  const out: SkillDefinition[] = []
  for (const { dir, pluginId } of extras) {
    // 插件提供的技能，其文件系统来源实际上是 ~/.x-code/plugins/cache/...
    // 下的缓存目录，因此 'user' 最贴近（它是用户级安装的，而非每个项目的）。
    // `pluginId` 承载供 UI 展示的真实出处。
    out.push(...(await loadSkillsFromDir(dir, 'user', pluginId)))
  }
  return out
}
