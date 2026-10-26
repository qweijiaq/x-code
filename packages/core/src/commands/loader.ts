// @x-code-cli/core — 基于文件的命令加载器
//
// 扫描插件贡献的 `commands/` 目录中的 `*.md` 文件，返回可直接注册到
// CommandRegistry 的 CommandDefinition。
// 与 sub-agents 加载器结构一致 —— 同样的最小 YAML frontmatter 解析器，
// 同样的“单个坏文件记录日志并跳过、绝不中断启动”的错误处理方式。
import fs from 'node:fs/promises'
import path from 'node:path'

import { parseFrontmatter } from '../frontmatter.js'
import { XCODE_DIR, errorMessage, userXcodeDir } from '../utils.js'
import type { CommandDefinition } from './types.js'

async function loadCommandsFromDir(
  dir: string,
  source: CommandDefinition['source'],
  pluginId?: string,
  pluginRoot?: string,
): Promise<CommandDefinition[]> {
  const out: CommandDefinition[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)
    const name = entry.slice(0, -3) // 去掉 .md 后缀

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      // 没有 frontmatter 的命令仍然有效 —— 整个文件内容即命令体。
      // 真正的 Claude Code 命令总是带 frontmatter，但这里保持宽容。
      const description = parsed?.data.description as string | undefined
      const body = (parsed ? parsed.body : raw).trim()

      const cmd: CommandDefinition = {
        name,
        description,
        body,
        source,
      }
      // pluginId / pluginRoot 仅对插件来源的命令有意义。
      // 对 user / project 命令，${CLAUDE_PLUGIN_ROOT} 会在 expandCommandBody
      // 中回退为空字符串 —— 是安全的空操作。
      if (pluginId) cmd.pluginId = pluginId
      if (pluginRoot) cmd.pluginRoot = pluginRoot
      out.push(cmd)
    } catch (err) {
      console.error(`[commands] Skipping ${filePath}: ${errorMessage(err)}`)
    }
  }
  return out
}

export interface LoadCommandsOptions {
  /** 插件贡献的命令目录，每个都带有所属插件的 id 和根目录。
   *  顺序决定注册表插入顺序（名称冲突时后者获胜）。 */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string; pluginRoot: string }>
}

/** 从 user（`~/.x-code/commands/*.md`）+ plugin（extraDirs）+ project
 *  （`<cwd>/.x-code/commands/*.md`）三个来源加载斜杠命令。
 *  合并顺序为 user → plugin → project，这样 CommandRegistry 的
 *  last-write-wins 语义得到 **project > plugin > user** 的优先级 ——
 *  与 skills + sub-agents 一致。`userXcodeDir()` 在加载时调用，因此
 *  `X_CODE_HOME`（测试使用）能重定向 user 作用域路径。 */
export async function loadPluginCommands(opts: LoadCommandsOptions = {}): Promise<CommandDefinition[]> {
  const userDir = path.join(userXcodeDir(), 'commands')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'commands')

  const userCmds = await loadCommandsFromDir(userDir, 'user')
  const pluginCmds: CommandDefinition[] = []
  for (const { dir, pluginId, pluginRoot } of opts.extraDirs ?? []) {
    pluginCmds.push(...(await loadCommandsFromDir(dir, 'plugin', pluginId, pluginRoot)))
  }
  const projectCmds = await loadCommandsFromDir(projectDir, 'project')

  return [...userCmds, ...pluginCmds, ...projectCmds]
}
