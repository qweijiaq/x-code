import path from 'node:path'

import type { Scenario } from '../framework/types.js'

const ROOT_MARKER = 'MAGENTA_FOX_8821'
const LEAF_MARKER = 'AZURE_OWL_4242'

const scenario: Scenario = {
  id: '19-knowledge-monorepo',
  name: 'AGENTS.md monorepo 链：root + leaf 都注入 system prompt',
  async run(ctx) {
    // 根目录的 `.git` 用来限定 AGENTS.md 向上查找的范围 — 没有它，
    // 查找会越过 tmpDir 继续向上，可能捡到开发者机器上无关的 CLAUDE.md
    // / AGENTS.md 文件，导致测试不稳定。
    await ctx.mkdir('.git')
    await ctx.writeFile('.git/HEAD', 'ref: refs/heads/main\n')

    await ctx.writeFile('AGENTS.md', [`# Repo root`, '', `The repo-root unique marker is ${ROOT_MARKER}.`].join('\n'))
    await ctx.writeFile(
      'packages/widget/AGENTS.md',
      [`# Widget package`, '', `The widget-package unique marker is ${LEAF_MARKER}.`].join('\n'),
    )
    await ctx.writeFile('packages/widget/package.json', '{"name":"widget"}\n')

    const widgetDir = path.join(ctx.tmpDir, 'packages', 'widget')
    const r = await ctx.runCli(
      'In this project both the repo root and the current package ship an AGENTS.md with one unique marker each. Quote both marker strings back to me verbatim.',
      { args: ['--max-turns', '4'], cwd: widgetDir },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.assistantMentions(r, ROOT_MARKER)
    ctx.expect.assistantMentions(r, LEAF_MARKER)
  },
}

export default scenario
