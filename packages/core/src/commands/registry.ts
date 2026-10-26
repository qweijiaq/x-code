// @x-code-cli/core — 斜杠命令注册表
//
// 在 CLI 启动时由插件贡献的命令文件构建一次。
// 当用户输入的 `/<name>` 不匹配任何内置命令或 skill 时，由 App.tsx 的
// 默认斜杠分发器来查询。与 SkillRegistry 一样采用
// 启动时冻结 / 字节稳定模型。
import fs from 'node:fs'

import { pluginDataDir } from '../plugins/paths.js'
import { type ReloadSummary, diffNamedEntries } from '../registry-diff.js'
import { type LoadCommandsOptions, loadPluginCommands } from './loader.js'
import type { CommandDefinition } from './types.js'

/** reload 返回的差异 —— 驱动 /plugin 刷新消息。 */
export type CommandReloadSummary = ReloadSummary

export class CommandRegistry {
  private byName: Map<string, CommandDefinition>

  constructor(commands: ReadonlyArray<CommandDefinition> = []) {
    this.byName = new Map()
    // 名称冲突时后者覆盖前者（与 SkillRegistry 合并
    // user → plugin → project 的方式一致）。
    for (const c of commands) this.byName.set(c.name, c)
  }

  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name)
  }

  list(): CommandDefinition[] {
    return [...this.byName.values()]
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  /** 用一次全新的加载替换内存中的命令集。由 /plugin refresh 使用 ——
   *  保持注册表身份稳定，使已捕获的 `options.commandRegistry` 引用仍然有效。 */
  reload(commands: ReadonlyArray<CommandDefinition>): CommandReloadSummary {
    const previous = this.byName
    const next = new Map<string, CommandDefinition>()
    for (const c of commands) next.set(c.name, c)
    const summary = diffNamedEntries(
      previous,
      next,
      (prev, cmd) => prev.body !== cmd.body || prev.pluginId !== cmd.pluginId || prev.pluginRoot !== cmd.pluginRoot,
    )
    this.byName = next
    return summary
  }
}

export async function createCommandRegistry(opts: LoadCommandsOptions = {}): Promise<CommandRegistry> {
  const commands = await loadPluginCommands(opts)
  return new CommandRegistry(commands)
}

/** 重新扫描插件命令目录并原地重建注册表。
 *  调用方负责传入最新的插件派生 extraDirs。 */
export async function reloadCommandRegistry(
  registry: CommandRegistry,
  opts: LoadCommandsOptions = {},
): Promise<CommandReloadSummary> {
  const commands = await loadPluginCommands(opts)
  return registry.reload(commands)
}

/** 在把命令体作为模型提示词发送前，对其应用 Claude Code 风格的占位符替换。
 *  识别的占位符与真实 Claude Code 插件命令文件一致（已与
 *  `anthropics/claude-code/plugins/<plugin>/commands/<cmd>.md` 核对）：
 *
 *    $ARGUMENTS  /  ${ARGUMENTS}    — 用户在命令名之后输入的文本
 *                                     （`/code-review 123` → `123`）。
 *                                     未给参数时为空字符串。
 *    ${CLAUDE_PLUGIN_ROOT}          — 所属插件安装目录的绝对路径
 *                                     （带版本号；重装时清空）。
 *    ${CLAUDE_PLUGIN_DATA}          — 插件持久化数据目录
 *                                     （`~/.x-code/plugins/data/<id>/`），
 *                                     重装与升级后仍保留。首次替换时
 *                                     自动创建。命令无插件上下文时
 *                                     保持原样。 */
export function expandCommandBody(cmd: CommandDefinition, args: string): string {
  const root = cmd.pluginRoot ?? ''
  let dataDir = ''
  if (cmd.pluginId && cmd.body.includes('${CLAUDE_PLUGIN_DATA}')) {
    dataDir = pluginDataDir(cmd.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // mkdir 失败时 dataDir 仍保留该路径字符串 ——
      // 用户的 shell 脚本若真的尝试写入那里，会得到合理的错误提示。
    }
  }
  return cmd.body
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', dataDir)
    .replaceAll('${ARGUMENTS}', args)
    .replaceAll('$ARGUMENTS', args)
}
