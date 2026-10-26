import type { Scenario } from '../framework/types.js'

const PAGE_PHRASE =
  /illustrative examples|literature without prior coordination|may use this domain|documentation examples|without needing permission|avoid use in operations|示例|文档示例|无需许可|无需事先协调|不用于/i

const scenario: Scenario = {
  id: '17-web-fetch',
  name: 'webFetch 工具：抓一个稳定 URL 并解出页面内容',
  // webFetch 不需要 API key，但需要出站 HTTPS。
  // example.com 走 HTTPS，自 1992 年起一直在线，且提供
  // 一个极小的 "Example Domain" 页面，任何 HTML→markdown 提取器都能处理。
  async run(ctx) {
    const prompt =
      'Use the webFetch tool to fetch https://example.com/ and then summarize the page content ' +
      'in one short sentence. Include in your summary at least one specific phrase you saw on the page.'
    let r = await ctx.runCli(prompt, { args: ['--max-turns', '4'] })

    // 即使 webFetch 本身正常，外部 HTTPS 也可能暂时失败。只对传输层
    // 失败重试一次；持续性失败仍会进入断言。
    const transientFailure = r.toolCalls.some(
      (tc) =>
        tc.toolName === 'webFetch' &&
        /Error fetching URL:.*(?:fetch failed|timed? ?out|timeout|ECONNRESET|EAI_AGAIN|socket)/is.test(
          tc.resultText ?? '',
        ),
    )
    if (transientFailure) {
      r = await ctx.runCli(prompt, { args: ['--max-turns', '4'] })
    }

    ctx.expect.exitCode(r, 0)
    const fetchCall = ctx.expect.toolCalled(r, 'webFetch', { url: /example\.com/ })
    ctx.expect.truthy(
      PAGE_PHRASE.test(fetchCall.resultText ?? ''),
      `webFetch result did not contain expected page content; got: ${(fetchCall.resultText ?? '').slice(0, 400)}`,
    )
    // 旧断言 /example|domain|.../ 在 prompt 里就有 "example.com"，模型不用真抓页面
    // 也能蒙混。这里改成 example.com 页面正文里独有的短语 — 凭常识/prompt 都拼不出来。
    // 注意：IANA 已改版 example.com，旧文案 "illustrative examples / may use this
    // domain" 换成了 "documentation examples / without needing permission /
    // Avoid use in operations"。两组短语都保留，任一版本页面都能命中。
    ctx.expect.assistantMentions(r, PAGE_PHRASE)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
