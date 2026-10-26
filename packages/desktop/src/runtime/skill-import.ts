import fs from 'node:fs'
import path from 'node:path'

import { userXcodeDir } from '@x-code-cli/core'

const SKILL_FILENAME = 'SKILL.md'

function frontmatterName(raw: string): string | null {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const line = frontmatter?.[1].match(/^name:\s*(.+)$/m)
  return line?.[1]?.trim().replace(/^["']|["']$/g, '') || null
}

function slugify(name: string): string {
  const slug = name
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'skill'
}

function uniqueDir(root: string, base: string): string {
  let candidate = path.join(root, base)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${index}`)
    index++
  }
  return candidate
}

/**
 * 把 SKILL.md 文件或技能目录复制到用户技能目录
 * （`~/.x-code/skills/<name>`）。调用方负责重新加载技能注册表并
 * 验证新条目；导入失败的条目由调用方移除。
 */
export async function importSkillIntoUserDir(sourcePath: string): Promise<{ dir: string; sourceName: string }> {
  const source = path.resolve(sourcePath)
  const stat = await fs.promises.stat(source)
  const skillsRoot = path.join(userXcodeDir(), 'skills')
  await fs.promises.mkdir(skillsRoot, { recursive: true })

  if (stat.isDirectory()) {
    const skillFile = path.join(source, SKILL_FILENAME)
    if (!fs.existsSync(skillFile)) {
      throw new Error('所选目录中没有 SKILL.md')
    }
    const raw = await fs.promises.readFile(skillFile, 'utf-8')
    const sourceName = frontmatterName(raw) ?? path.basename(source)
    const dest = uniqueDir(skillsRoot, slugify(sourceName))
    await fs.promises.cp(source, dest, { recursive: true })
    return { dir: dest, sourceName }
  }

  if (!source.toLowerCase().endsWith('.md')) {
    throw new Error('请选择 SKILL.md 文件或包含 SKILL.md 的目录')
  }
  const raw = await fs.promises.readFile(source, 'utf-8')
  const sourceName = frontmatterName(raw) ?? path.basename(source, path.extname(source))
  const dest = uniqueDir(skillsRoot, slugify(sourceName))
  await fs.promises.mkdir(dest, { recursive: true })
  await fs.promises.copyFile(source, path.join(dest, SKILL_FILENAME))
  return { dir: dest, sourceName }
}
