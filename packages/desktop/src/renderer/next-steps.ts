import type { GoalView, TodoView } from '../shared/protocol.js'
import type { Entry } from './transcript-model.js'

export interface NextStep {
  id: string
  label: string
  prompt: string
}

export interface NextStepInput {
  entries: Entry[]
  todos?: TodoView[]
  goal?: GoalView | null
}

/**
 * 从刚结束的一轮真实结果里推下一步，而不是再调一次模型：
 * 改动、失败、待办、目标状态都是现成的信号，建议因此即时且免费。
 */
export function buildNextSteps(input: NextStepInput): NextStep[] {
  const entries = input.entries
  if (entries.length === 0) return []
  let lastUser = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].role === 'user') {
      lastUser = index
      break
    }
  }
  const turn = entries.slice(lastUser + 1)
  if (turn.length === 0) return []

  const failed = turn.some((entry) => entry.role === 'error' || entry.toolStatus === 'error')
  const edited = turn.some((entry) => entry.diff)
  const pendingTodos = (input.todos ?? []).filter((todo) => todo.status !== 'completed')
  const goal = input.goal

  const steps: NextStep[] = []
  if (failed) {
    steps.push({
      id: 'fix-failures',
      label: '修复刚才的失败',
      prompt: '修复刚才失败的命令或检查，说明失败原因，然后再跑一遍验证。',
    })
  }
  if (edited) {
    steps.push({
      id: 'review-changes',
      label: '检查改动并补测试',
      prompt: '检查你刚才的改动，补充或更新相关测试，并运行验证确认没有回归。',
    })
  }
  if (pendingTodos.length > 0) {
    const preview = pendingTodos
      .slice(0, 3)
      .map((todo) => todo.content)
      .join('；')
    steps.push({
      id: 'continue-todos',
      label: '继续未完成的待办',
      prompt: `继续完成剩余待办：${preview}。`,
    })
  }
  if (goal && goal.status === 'active') {
    steps.push({
      id: 'goal-progress',
      label: '总结目标进展',
      prompt: '总结当前目标的执行进展、失败轮次与下一步计划，并指出是否需要我介入。',
    })
  } else if (goal && goal.totalAttempts > 0) {
    steps.push({
      id: 'goal-review',
      label: '复盘这次目标执行',
      prompt: '复盘这次目标执行的过程：哪些轮次走了弯路、失败原因是什么、下次怎么避免。',
    })
  }
  if (edited) {
    steps.push({
      id: 'commit-changes',
      label: '整理并提交改动',
      prompt: '审阅当前工作区的改动，整理成一次语义清晰的提交，并说明提交内容。',
    })
  }
  if (steps.length === 0) {
    steps.push(
      {
        id: 'run-checks',
        label: '运行项目检查',
        prompt: '运行项目的类型检查、测试和构建，报告当前状态和需要修复的问题。',
      },
      {
        id: 'summarize',
        label: '总结刚才做了什么',
        prompt: '简要总结刚才这一轮做了什么、改了哪些地方，以及还有哪些没完成。',
      },
    )
  }
  return steps.slice(0, 4)
}

export function composeNextStepPrompt(steps: NextStep[]): string {
  if (steps.length === 0) return ''
  if (steps.length === 1) return steps[0].prompt
  return `请继续处理以下事项：\n${steps.map((step) => `- ${step.prompt}`).join('\n')}`
}
