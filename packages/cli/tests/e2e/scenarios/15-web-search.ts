import type { Scenario } from '../framework/types.js'

const WIKIPEDIA_URL = /https:\/\/en\.wikipedia\.org\/wiki\/Prompt_engineering/i

const scenario: Scenario = {
  id: '15-web-search',
  name: 'webSearch 工具：搜一个外部主题（需要搜索后端 key）',
  requires: (env) => Boolean(env.TAVILY_API_KEY || env.BRAVE_API_KEY || env.EXA_API_KEY),
  requiresReason: 'set TAVILY_API_KEY, BRAVE_API_KEY or EXA_API_KEY to enable',
  async run(ctx) {
    const r = await ctx.runCli(
      'Use the webSearch tool to find the Wikipedia article URL for prompt engineering, ' +
        'then quote the URL in your final answer.',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    const searchCall = ctx.expect.toolCalled(r, 'webSearch', { query: /(prompt[- ]?engin|wikipedia)/i })
    // 维基百科文章 URL 稳定 — 不像文档站点那样频繁换域名
    //（例如 Anthropic 把 docs.anthropic.com 迁到 platform.claude.com），
    // 所以断言能在搜索结果和最终答案中都精确锁定该 URL。
    ctx.expect.truthy(
      WIKIPEDIA_URL.test(searchCall.resultText ?? ''),
      `webSearch result did not contain the expected Wikipedia URL; got: ${(searchCall.resultText ?? '').slice(0, 400)}`,
    )
    ctx.expect.assistantMentions(r, WIKIPEDIA_URL)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
