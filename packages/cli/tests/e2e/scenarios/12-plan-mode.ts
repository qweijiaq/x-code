import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '12-plan-mode',
  name: '--plan 启动：模型只读探索、不调写工具',
  async run(ctx) {
    await ctx.writeFile('src/main.ts', 'export const greet = () => "hello"\n')
    await ctx.writeFile('package.json', '{"name":"demo"}\n')

    const r = await ctx.runCli(
      'I want to refactor src/main.ts to also export a `bye` function. Look at what is there and then describe (in writing) how you would change it. Do not actually make the change.',
      { args: ['--plan', '--trust', '--max-turns', '12'] },
    )
    ctx.expect.exitCode(r, 0)

    // 计划模式可以调用 writeFile/edit — 但只能作用于 `.x-code/plans/`
    // 下的计划存储文件。enterPlanMode 的工具结果明确告诉模型对计划
    // 文件使用 writeFile 来构建计划（见 plan-tools.ts:131）。我们关心的
    // 不变量是：任何写工具都不碰 `.x-code/plans/` 之外的东西。
    const isPlanFile = (p: unknown): boolean => typeof p === 'string' && /[\\/]\.x-code[\\/]plans[\\/]/.test(p)
    for (const tc of r.toolCalls) {
      if (tc.toolName !== 'writeFile' && tc.toolName !== 'edit') continue
      const filePath = tc.input.filePath
      ctx.expect.truthy(
        isPlanFile(filePath),
        `plan mode wrote outside .x-code/plans/: ${tc.toolName} → ${String(filePath)}`,
      )
    }

    // src/main.ts 必须完全未被改动
    await ctx.expect.fileContent('src/main.ts', /greet/)
    const content = await ctx.readFile('src/main.ts')
    ctx.expect.truthy(!content.includes('bye'), 'src/main.ts should NOT have been modified in plan mode')
  },
}

export default scenario
