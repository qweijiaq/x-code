import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '23-continue-session',
  name: '--continue 加载上轮会话：模型记得前一轮告诉过它的数字',
  // 在同一个 tmpDir 里连续两次调用 `xc -p`。第二次用 --continue，
  // 让 main() 从 <tmpDir>/.x-code/sessions/ 里挑出最新的 jsonl，
  // 作为 initialSession 交给 runPrintMode — runPrintMode 随后通过
  // hydrateLoopState 播种 agentLoop 的 LoopState。没有 print 模式对
  // initialSession 的这段接线，第二轮会看到全新会话，完全不知道
  // 4242 是什么意思。
  async run(ctx) {
    const r1 = await ctx.runCli(
      'For this session, please remember a specific fact: the magic number is 4242. Just acknowledge in one short sentence — no tools needed.',
      { args: ['--max-turns', '2'] },
    )
    ctx.expect.exitCode(r1, 0)
    ctx.expect.assistantMentions(r1, '4242')

    const r2 = await ctx.runCli(
      'What magic number did I tell you to remember a moment ago? Answer with the number alone.',
      { args: ['--continue', '--max-turns', '2'] },
    )
    ctx.expect.exitCode(r2, 0)
    ctx.expect.assistantMentions(r2, '4242')
  },
}

export default scenario
