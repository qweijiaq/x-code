// @x-code-cli/cli — /skill 斜杠命令处理器。
//
// 通过一个工厂从 App.tsx 抽出，闭包捕获每个子命令需要的依赖：注册表访问（读 +
// 重载）、设置写入器、提示缓存失效，以及待定技能 ref。返回 App.tsx 里分发器调用的
// 处理器函数。
//
// 子命令：install / list / refresh / disable / enable / uninstall。
// 未知子命令打印用法提示。
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  USER_XCODE_DIR,
  getScopedDisabledSkills,
  reloadSkillRegistry,
  setSkillDisabled,
  skillSettingsPath,
} from '@x-code-cli/core'
import type { AgentOptions, SkillDefinition, SkillSettingsScope } from '@x-code-cli/core'

import { parseScopeFlag } from './scope-flag.js'

export interface SkillCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  invalidateSystemPromptCache: () => void
  pendingSkillRef: { current: SkillDefinition | null }
  bumpSkillRegistryVersion: () => void
}

/** SKILL.md frontmatter 的最小 YAML 名称提取器。
 *  只需找到 `name: <value>`——完整解析在加载器里做。 */
function extractSkillName(content: string): string | null {
  const match = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  return match ? match[1].trim() : null
}

/** 把技能参数拆成 `(name, scope)`，识别 `--scope=user` / `--scope=project` /
 *  `-s=user` 等。无标志的裸参数返回 `scope: undefined`，让调用方可按技能来源取
 *  默认。未知 scope 字符串被忽略（scope 保持 undefined）——让解析器保持宽容。 */
function parseSkillScopeFlag(arg: string): { name: string; scope?: SkillSettingsScope } {
  const { value, scope } = parseScopeFlag(arg)
  return { name: value, scope }
}

export function createSkillCommandHandler(deps: SkillCommandDeps) {
  const { options, addCommandMessage, invalidateSystemPromptCache, pendingSkillRef, bumpSkillRegistryVersion } = deps

  async function handleSkill(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()
    const subArg = parts.slice(1).join(' ').trim()

    if (sub === 'install') {
      if (!subArg) {
        addCommandMessage(text, 'Usage: `/skill install <url>`')
        return
      }
      let content: string
      try {
        const res = await fetch(subArg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        content = await res.text()
      } catch (err) {
        addCommandMessage(text, `Failed to fetch \`${subArg}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      const name = extractSkillName(content)
      if (!name) {
        addCommandMessage(text, 'Invalid SKILL.md: missing `name` in frontmatter.')
        return
      }

      const skillDir = path.join(USER_XCODE_DIR, 'skills', name)
      const skillFile = path.join(skillDir, 'SKILL.md')
      try {
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8')
      } catch (err) {
        addCommandMessage(text, `Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      addCommandMessage(
        text,
        `Skill **${name}** installed to \`${skillFile}\`\nRun \`/skill refresh\` to use \`/${name}\` now, or restart xc.`,
      )
      return
    }

    if (sub === 'list') {
      const skills = options.skillRegistry?.listAll() ?? []
      if (skills.length === 0) {
        const skillsPath = path.join(USER_XCODE_DIR, 'skills', '<name>', 'SKILL.md')
        addCommandMessage(
          text,
          `No skills loaded. Place SKILL.md files in \`${skillsPath}\` then run \`/skill refresh\` (or restart).`,
        )
        return
      }
      const lines = skills.map((s) => {
        const tag = s.disabled ? '[off]' : '[on] '
        return `- ${tag} **${s.name}** (${s.source}): ${s.description}`
      })
      addCommandMessage(text, `**Loaded skills** (${skills.length}):\n${lines.join('\n')}`)
      return
    }

    if (sub === 'refresh') {
      if (!options.skillRegistry) {
        addCommandMessage(text, 'No skill registry to refresh.')
        return
      }
      let summary
      try {
        summary = await reloadSkillRegistry(options.skillRegistry)
      } catch (err) {
        addCommandMessage(text, `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 使提示缓存失效：系统提示的 `## Available Skills` 块和 activateSkill 工具
      // 描述都内嵌了技能列表。宁可吃一次缓存 miss，也别把过期的技能表面发给模型。
      // 与 /mcp refresh 做的取舍相同。
      invalidateSystemPromptCache()
      // 若用户为刚被删除或禁用的技能 `/<skillname>`，就丢弃待定技能——否则下一条
      // 普通用户消息会注入孤儿技能内容。
      const pending = pendingSkillRef.current
      if (pending && !options.skillRegistry.get(pending.name)) {
        pendingSkillRef.current = null
      }
      // 强制斜杠命令 tab 补全 + /help 列表基于新技能集重新 memo。注册表对象身份
      // 稳定（reload() 原地变更），所以版本计数器就是 React 重算 memo 列表所需的
      // 信号。
      bumpSkillRegistryVersion()

      const summaryParts: string[] = []
      if (summary.added.length) summaryParts.push(`added: ${summary.added.join(', ')}`)
      if (summary.removed.length) summaryParts.push(`removed: ${summary.removed.join(', ')}`)
      if (summary.changed.length) summaryParts.push(`changed: ${summary.changed.join(', ')}`)
      if (summary.unchanged.length) summaryParts.push(`unchanged: ${summary.unchanged.join(', ')}`)
      if (summaryParts.length === 0) summaryParts.push('no skills found')
      const lines = [`Reloaded skills — ${summaryParts.join('; ')}.`]
      // 主结果与提示注记之间用紧凑的 `\n`——与 /mcp refresh 以及 /skill install /
      // disable / enable / remove 其余部分使用的模式一致。单个命令的结果块内不
      // 留空行。
      lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'disable' || sub === 'enable') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, `Usage: \`/skill ${sub} <name> [--scope=user|project]\``)
        return
      }
      const { name: bareName, scope } = parseSkillScopeFlag(name)
      const entry = options.skillRegistry?.getEntry(bareName)
      if (!entry) {
        addCommandMessage(
          text,
          `No skill named \`${bareName}\` is loaded. Run \`/skill list\` to see available skills.`,
        )
        return
      }
      // 把禁用作用域默认到技能自身来源，让用户无需输入 --scope 就能得到预期的
      // 「禁用项目技能 yansu」。重新启用是对称的：先从来源作用域清除；如果技能
      // 仍然实际处于禁用状态，那是因为另一个作用域也列了它，我们会提示出来。
      const effectiveScope: SkillSettingsScope = scope ?? entry.source
      const disable = sub === 'disable'
      let result: 'changed' | 'noop'
      try {
        result = await setSkillDisabled(bareName, effectiveScope, disable)
      } catch (err) {
        addCommandMessage(text, `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const settingsFile = skillSettingsPath(effectiveScope)
      if (result === 'noop') {
        addCommandMessage(
          text,
          disable
            ? `Skill **${bareName}** is already disabled in ${effectiveScope} settings (\`${settingsFile}\`).`
            : `Skill **${bareName}** is not disabled in ${effectiveScope} settings (\`${settingsFile}\`).`,
        )
        return
      }
      // 重新启用后，检查另一个作用域是否仍把它藏着——这是用户先在 user 作用域禁用
      // 又指望 project 级启用能救回它时的常见坑。
      let otherScopeNote = ''
      if (!disable) {
        const other: SkillSettingsScope = effectiveScope === 'user' ? 'project' : 'user'
        try {
          const stillDisabled = (await getScopedDisabledSkills(other)).includes(bareName)
          if (stillDisabled) {
            otherScopeNote = `\n_Note: \`${bareName}\` is also listed in ${other} settings (\`${skillSettingsPath(other)}\`). Run \`/skill enable ${bareName} --scope=${other}\` to fully re-enable._`
          }
        } catch {
          // 尽力而为的提示——静默失败无妨
        }
      }
      const verb = disable ? 'Disabled' : 'Enabled'
      addCommandMessage(
        text,
        `${verb} skill **${bareName}** in ${effectiveScope} settings (\`${settingsFile}\`).${otherScopeNote}\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    if (sub === 'uninstall') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, 'Usage: `/skill uninstall <name>`')
        return
      }
      const entry = options.skillRegistry?.getEntry(name)
      if (!entry) {
        addCommandMessage(text, `No skill named \`${name}\` is loaded. Run \`/skill list\` to see available skills.`)
        return
      }
      // 插件贡献的技能位于插件的缓存目录下，不在 <baseDir>/skills/ 下。这里的
      // `/skill uninstall` 会算出错误路径，要么静默空操作，要么删掉无关目录——
      // 改为把用户重定向到 `/plugin uninstall`。
      if (entry.pluginId) {
        addCommandMessage(
          text,
          `Skill **${name}** comes from plugin \`${entry.pluginId}\` — uninstall it with \`/plugin uninstall ${entry.pluginId}\` instead of \`/skill uninstall\`.`,
        )
        return
      }
      const baseDir = entry.source === 'user' ? USER_XCODE_DIR : path.join(process.cwd(), '.x-code')
      const skillDir = path.join(baseDir, 'skills', name)
      try {
        await fs.rm(skillDir, { recursive: true, force: true })
      } catch (err) {
        addCommandMessage(text, `Failed to remove \`${skillDir}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // 同时清除任何禁用条目——留下指向已卸载技能的过期条目，会在将来以同名重新
      // 安装时静默吞掉它（它会以禁用状态回来）。
      try {
        await setSkillDisabled(name, 'user', false)
        await setSkillDisabled(name, 'project', false)
      } catch {
        // 尽力而为——主 rm 已经成功了
      }
      addCommandMessage(
        text,
        `Uninstalled skill **${name}** from \`${skillDir}\`.\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    addCommandMessage(
      text,
      'Usage: `/skill install <url>` · `/skill list` · `/skill refresh` · `/skill disable <name>` · `/skill enable <name>` · `/skill uninstall <name>`',
    )
  }

  return { handleSkill }
}
