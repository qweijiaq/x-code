// @x-code-cli/core — 基于文件的斜杠命令类型
//
// “命令”是一个由插件提供的 markdown 文件（将来也可能直接写在
// ~/.x-code/commands/ 下），在启动时转成斜杠命令。真正的 Claude Code
// 插件将其作为 `commands/<name>.md` 与 plugin.json 放在一起 ——
// `code-review` 插件 `commands/` 下的 `code-review.md` 注册为 `/code-review`。
//
// 文件格式（与 anthropics/claude-code 真实插件内容核对过的
// Claude Code 规范一致）：
//
//     ---
//     description: Code review a pull request
//     allowed-tools: Bash(gh pr view:*), …      # 我们目前忽略此项
//     ---
//
//     <body — 模型要执行的提示词模板>
//
//     发送给模型前对 body 应用的替换：
//       $ARGUMENTS                — 命令名之后输入的文本
//       ${ARGUMENTS}              — 同上，花括号形式
//       ${CLAUDE_PLUGIN_ROOT}     — 插件根目录的绝对路径
//                                   （这样命令体可通过 shell
//                                   引用打包的脚本）

export interface CommandDefinition {
  /** 不含前导斜杠的命令调用名。由文件名派生
   *  （`code-review.md` → `code-review`）。 */
  name: string
  /** frontmatter `description` 字段里的一行简短摘要 ——
   *  `/help` 和 `/plugin info` 用它来标注命令。 */
  description?: string
  /** 提示词模板（frontmatter 之后的所有内容），已去除首尾空白。 */
  body: string
  /** 该命令的来源。`'user'` = `~/.x-code/commands/*.md`，
   *  `'project'` = `<repo-root>/.x-code/commands/*.md`，`'plugin'` =
   *  插件贡献的 `commands/*.md`。与 SkillDefinition / SubAgentDefinition 对应。 */
  source: 'user' | 'project' | 'plugin'
  /** 当 source === 'plugin' 时，所属插件的 id
   *  （`name@marketplace`）。用于 `/plugin info` 和正确设置
   *  `${CLAUDE_PLUGIN_ROOT}`。 */
  pluginId?: string
  /** 插件根目录的绝对路径。会替换 body 中的
   *  `${CLAUDE_PLUGIN_ROOT}` —— 这样引用打包脚本的命令体
   *  能正确解析它们。 */
  pluginRoot?: string
}
