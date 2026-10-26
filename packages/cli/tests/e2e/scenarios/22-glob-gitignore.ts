import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '22-glob-gitignore',
  name: 'glob 工具尊重 .gitignore：node_modules/ 被过滤掉',
  // 针对 commit 605cba1 的回归守卫 — glob 切换到了 ripgrep，并开始
  // 遵守 .gitignore。在那之前，`**/*.js` 会毫无顾忌地返回每一个
  // 依赖文件，既是噪音又是成本放大。
  async run(ctx) {
    // ripgrep 只有在检测到 git 仓库时才遵守 .gitignore（glob 工具里
    // 特意没有 `--no-require-git` 标志 — 在 git 树之外，.gitignore 语义上
    // 不适用）。所以测试需要一个最小的 .git/ 标记来走通 gitignore 路径。
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')
    await ctx.writeFile('.gitignore', 'node_modules/\n')
    await ctx.writeFile('src/main.js', '// app entry\n')
    await ctx.writeFile('src/util.js', '// helper\n')
    await ctx.writeFile('node_modules/lodash/index.js', '// vendor\n')
    await ctx.writeFile('node_modules/react/index.js', '// vendor\n')

    const r = await ctx.runCli(
      'Use the glob tool with the pattern `**/*.js` to find every JavaScript file in this directory tree. List the paths the tool returned.',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    const globCall = ctx.expect.toolCalled(r, 'glob')
    const result = globCall.resultText ?? ''
    ctx.expect.truthy(
      /main\.js/.test(result) && /util\.js/.test(result),
      `glob should find src/main.js and src/util.js; got resultText:\n${result.slice(0, 400)}`,
    )
    ctx.expect.truthy(
      !/node_modules/.test(result),
      `glob result should respect .gitignore and exclude node_modules/; got resultText:\n${result.slice(0, 400)}`,
    )
  },
}

export default scenario
