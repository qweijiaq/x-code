// @x-code-cli/core — activateSkill 工具
//
// 仅当存在 SkillRegistry（即至少找到一个 SKILL.md）时才注入工具注册表。
// 模型判断当前任务匹配某个 skill 的描述时调用它；工具把该 skill 的
// Markdown 正文用 XML 标签包起来返回，模型随后把它当作工具结果并按其中的
// 指令执行。
//
// 这对应 Gemini CLI 的 activate_skill 工具和 Claude Code 的内联 SkillTool
// —— 是各主要竞品共用的通用模式。
import { tool } from 'ai'

import { z } from 'zod'

import type { SkillRegistry } from '../skills/registry.js'
import { wrapActivatedSkill } from '../skills/registry.js'

export function createActivateSkillTool(registry: SkillRegistry) {
  return tool({
    description: 'Activate one of the skills listed in the system prompt and inject its instructions.',
    inputSchema: z.object({
      name: z.string().describe('Name of the skill to activate'),
    }),
    execute: async ({ name }) => {
      const skill = registry.get(name)
      if (!skill) {
        const available = registry.names()
        return available.length > 0
          ? `Skill "${name}" not found. Available: ${available.join(', ')}`
          : `Skill "${name}" not found. No skills are currently loaded.`
      }
      return wrapActivatedSkill(skill)
    },
  })
}
