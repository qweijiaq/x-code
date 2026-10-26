// @x-code-cli/core — 技能注册表
//
// 在 CLI 启动时构建一次，并在整个会话中复用。技能列表嵌入两个字节稳定的
// 表面——系统提示的 `## Available Skills` 块和 `activateSkill` 工具描述——
// 两者都缓存在 LoopState.systemPromptCache 上。因此添加、移除、启用或禁用
// 技能需要要么 (a) 在下一次 streamText 调用之前运行并让该缓存失效，要么
// (b) 等待 CLI 重启。/skill disable|enable|remove 处理器走 (b)——它们把
// 设置写入磁盘并打印 "Restart the CLI to apply." 提示。/skill refresh 处理器
// 走 (a)——它调用本对象上的 `reloadSkillRegistry()` 原地重建内部映射，然后
// 触发 systemPromptCache 失效，使下一轮拾取变更。刷新时保持同一个
// SkillRegistry 对象引用，意味着所有捕获了 `options.skillRegistry` 的其他
// 代码路径（agent loop 的 buildTools、App.tsx 的斜杠命令补全……）都继续
// 指向正确的东西，无需重新接线。
import { type ReloadSummary, diffNamedEntries } from '../registry-diff.js'
import { type LoadSkillsOptions, loadSkills } from './loader.js'
import { loadDisabledSkillsSet } from './settings.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  source: 'user' | 'project'
  /** 技能目录的绝对路径（即包含 SKILL.md 的目录）。在激活时使用，以便模型
   *  能解析相对自身 scripts / references / assets 的相对路径。 */
  dir: string
  /** 技能目录中文件的相对路径，排除 SKILL.md 以及隐藏 / 大目录。在激活时
   *  与正文一起列出，让模型无需 glob 就知道存在哪些自带资源。上限为
   *  MAX_LISTED_FILES——过长的列表会被截断并附加 "... N more" 标记。 */
  files: string[]
  /** 当此技能来自插件贡献时，所属插件的 id（`name@marketplace`）。UI 显示为
   *  "(from plugin: …)"，`/skill uninstall` 会重定向到 `/plugin uninstall`。 */
  pluginId?: string
  /** 桌面管理的隔离运行时（依赖环境、解释器路径）。追加到激活载荷中，使模型
   *  在运行时目录中安装 / 运行技能依赖，而不是在项目目录中。 */
  runtimeHint?: string
}

export interface SkillEntry extends SkillDefinition {
  disabled: boolean
}

/** `reloadSkillRegistry()` 返回的摘要。驱动 /skill refresh 中的消息表面——
 *  调用方能像 /mcp refresh 那样展示 "added: a, b" / "removed: c" /
 *  "unchanged: d, e"。 */
export type SkillReloadSummary = ReloadSummary

export class SkillRegistry {
  private byName: Map<string, SkillEntry>

  constructor(skills: SkillDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byName = new Map()
    // 后写者胜出：项目技能覆盖同名用户域技能，因为 loadSkills() 先返回用户域，
    // 再返回项目。
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
  }

  /** 用一次全新加载替换内存中的技能列表。供 /skill refresh 使用——保持同一个
   *  SkillRegistry 对象身份，让每个缓存的 `options.skillRegistry` 引用（agent
   *  loop、CLI 斜杠补全、App.tsx 处理器）继续指向正确的东西。返回与先前状态的
   *  逐名称 diff，让调用方能在面向用户的消息中渲染 "added / removed / changed /
   *  unchanged" 摘要。 */
  reload(skills: SkillDefinition[], disabled: ReadonlySet<string>): SkillReloadSummary {
    const previous = this.byName
    const next = new Map<string, SkillEntry>()
    for (const skill of skills) {
      next.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
    const summary = diffNamedEntries(
      previous,
      next,
      (prev, entry) =>
        prev.description !== entry.description ||
        prev.content !== entry.content ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled,
    )
    this.byName = next
    return summary
  }

  /** 按名称获取已启用的技能。禁用的技能对 agent loop 和斜杠命令派发隐藏——
   *  若需检查 disabled 标志（/skill list 处理器会这么做），使用 `getEntry()`。 */
  get(name: string): SkillDefinition | undefined {
    const entry = this.byName.get(name)
    if (!entry || entry.disabled) return undefined
    return entry
  }

  /** 仅已启用的技能。 */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled)
  }

  /** 仅已启用技能的名称。 */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name)
  }

  /** 每个已加载的技能，带 `disabled` 标志。供 /skill list 和 disable/enable/
   *  remove 处理器使用，让它们也能对禁用技能操作。 */
  listAll(): SkillEntry[] {
    return [...this.byName.values()]
  }

  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name)
  }
}

/** 从 loader 的 MAX_LISTED_FILES 镜像来的硬上限——注入格式化器以同样的值
 *  截断渲染的文件列表，使两者保持一致。loader 先排序 + 截断，本函数把
 *  `skill.files` 视为已是有界的。 */
const MAX_RENDERED_FILES = 50

/** 构建放进 `<activated_skill name="...">...</activated_skill>` 的精确文本，
 *  用于两条激活路径（模型通过 `activateSkill` 工具自行决定，以及用户显式
 *  `/<skillname>`）。格式遵循 Opencode 的惯例：先正文，然后是带基础目录 +
 *  相对路径提示 + 文件列表的页脚。两个调用点共享一个格式化器，使模型看到的
 *  字节流保持一致，无论谁触发了激活。 */
export function formatSkillActivationBody(skill: SkillDefinition): string {
  const lines: string[] = [skill.content.trim(), '']
  lines.push(`Base directory for this skill: ${skill.dir}`)
  lines.push(
    'Relative paths in this skill (e.g., scripts/foo.sh, references/api.md) are resolved against the base directory above.',
  )
  if (skill.runtimeHint) lines.push('', skill.runtimeHint)
  if (skill.files.length > 0) {
    lines.push('', 'Files in this skill directory:')
    const shown = skill.files.slice(0, MAX_RENDERED_FILES)
    for (const f of shown) lines.push(`- ${f}`)
    if (skill.files.length > MAX_RENDERED_FILES) {
      lines.push(`- ... and ${skill.files.length - MAX_RENDERED_FILES} more file(s) not shown`)
    }
  }
  return lines.join('\n')
}

/** 把技能的激活正文包进 `<activated_skill name="X">` XML 外壳。两条激活路径
 *  都使用它，使外壳字节一致，无论触发者是谁。 */
export function wrapActivatedSkill(skill: SkillDefinition): string {
  return `<activated_skill name="${skill.name}">\n${formatSkillActivationBody(skill)}\n</activated_skill>`
}

export async function createSkillRegistry(opts: LoadSkillsOptions = {}): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return new SkillRegistry(skills, disabled)
}

/** 重新扫描技能目录 + settings.json，然后原地修改给定的 registry。调用方负责
 *  使任何内嵌了先前技能列表的 systemPromptCache 失效——/skill refresh 处理器
 *  正是这么做的。 */
export async function reloadSkillRegistry(
  registry: SkillRegistry,
  opts: LoadSkillsOptions = {},
): Promise<SkillReloadSummary> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return registry.reload(skills, disabled)
}
