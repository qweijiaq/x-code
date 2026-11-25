import type { GoalVerifier } from '@x-code-cli/core'

const DEFAULT_SUBAGENT_VERIFIER_PROMPT =
  'Verify that the current goal objective is fully complete in the repository/session state.'
const VERIFIER_TIMEOUT_MS = 120_000
/** 目标循环每轮都是一次完整的 agent 回合，`--max-turns` 无上限等于取消 token
 *  预算保护。给一个足够宽松但仍有限的上界，超出时明确报错而不是静默接受。 */
const MAX_GOAL_TURNS = 1000
const MAX_TOKEN_BUDGET = 1_000_000_000

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  for (const match of input.matchAll(re)) {
    const quoted = match[1] ?? match[2]
    // 只有引号内的内容需要反转义（单次扫描，`\\(.)` 只吃掉一个反斜杠）；
    // 未加引号的 token 原样保留，避免把 Windows 路径里的反斜杠改写掉。
    tokens.push(quoted === undefined ? (match[3] ?? '') : quoted.replace(/\\(.)/g, '$1'))
  }
  return tokens
}

/** 解析一个正整数值的 flag。缺失值、后面紧跟另一个 flag、非数字、越界都抛出
 *  可读错误——静默保留默认值会让用户以为限流已经生效。 */
function parsePositiveInt(flag: string, raw: string | undefined, max: number): number {
  if (raw === undefined || raw === '' || raw.startsWith('--')) {
    throw new Error(`${flag} requires a value, e.g. ${flag} 20`)
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${flag} requires a positive integer, got "${raw}"`)
  }
  if (value > max) throw new Error(`${flag} must be at most ${max}, got ${value}`)
  return value
}

export function parseGoalCreateArgs(arg: string): {
  objective: string
  maxTurns?: number
  tokenBudget?: number
  requiresUserConfirmation?: boolean
  verifiers: GoalVerifier[]
} {
  const tokens = tokenizeArgs(arg)
  const objectiveParts: string[] = []
  const verifiers: GoalVerifier[] = []
  let maxTurns: number | undefined
  let tokenBudget: number | undefined
  let requiresUserConfirmation = false
  let verifierPrompt = DEFAULT_SUBAGENT_VERIFIER_PROMPT

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--verify') {
      const command = tokens[++i]
      // 缺值时静默丢弃验证器，用户会以为目标有校验——实际无验证直接判定完成。
      if (command === undefined || command === '' || command.startsWith('--')) {
        throw new Error('--verify requires a shell command, e.g. --verify "pnpm test"')
      }
      verifiers.push({ kind: 'shell', command, timeoutMs: VERIFIER_TIMEOUT_MS })
      continue
    }
    if (token === '--max-turns') {
      maxTurns = parsePositiveInt(token, tokens[++i], MAX_GOAL_TURNS)
      continue
    }
    if (token === '--token-budget') {
      tokenBudget = parsePositiveInt(token, tokens[++i], MAX_TOKEN_BUDGET)
      continue
    }
    if (token === '--confirm') {
      requiresUserConfirmation = true
      continue
    }
    if (token === '--verifier-prompt') {
      const prompt = tokens[++i]
      if (prompt === undefined || prompt === '' || prompt.startsWith('--')) {
        throw new Error('--verifier-prompt requires a value')
      }
      verifierPrompt = prompt
      // 就近生效 + 向后兼容：`--verifier-prompt` 既修正已经创建的最近一个 subagent
      // 验证器（所以 flag 顺序无关），也成为之后 `--verifier-agent` 的默认提示词。
      const latestSubAgent = findLatestSubAgentVerifier(verifiers)
      if (latestSubAgent?.kind === 'subagent') latestSubAgent.prompt = verifierPrompt
      continue
    }
    if (token === '--verifier-agent') {
      const agent = tokens[++i]
      if (agent === undefined || agent === '' || agent.startsWith('--')) {
        throw new Error('--verifier-agent requires a sub-agent name')
      }
      verifiers.push({
        kind: 'subagent',
        agent,
        prompt: verifierPrompt,
        timeoutMs: VERIFIER_TIMEOUT_MS,
      })
      continue
    }
    // 未知的 `--flag`（拼错、或者 `--max-turn` 这种少字母的写法）以前会被当成
    // 目标描述文本塞给模型，用户既得不到「参数无效」的反馈，objective 也被污染。
    if (/^--[A-Za-z]/.test(token)) throw new Error(`Unknown option ${token}`)
    objectiveParts.push(token)
  }

  return {
    objective: objectiveParts.join(' ').trim(),
    maxTurns,
    tokenBudget,
    requiresUserConfirmation,
    verifiers,
  }
}

function findLatestSubAgentVerifier(
  verifiers: GoalVerifier[],
): Extract<GoalVerifier, { kind: 'subagent' }> | undefined {
  for (let i = verifiers.length - 1; i >= 0; i--) {
    const verifier = verifiers[i]
    if (verifier.kind === 'subagent') return verifier
  }
  return undefined
}
