import type { ModelMessage } from 'ai'

import { BackgroundTaskRegistry } from '../src/agent/background-tasks.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { processToolCalls as dispatchToolCalls } from '../src/agent/tool-execution.js'
import { appendTrackedMessage } from '../src/agent/tracked-messages.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../src/types/index.js'

const stubModel = {} as LanguageModel
let toolSeq = 0

function makeCallbacks(): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onFileEdit: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('answer'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
  }
}

async function runTool(
  state: ReturnType<typeof createLoopState>,
  options: AgentOptions,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const call = { toolName, toolCallId: `call-${toolName}-${++toolSeq}`, input }
  appendTrackedMessage(state, {
    role: 'assistant',
    content: [{ type: 'tool-call', ...call }] as never,
  })
  await dispatchToolCalls([call], state, options, makeCallbacks(), stubModel)
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const content = state.messages[index]?.content
    if (!Array.isArray(content)) continue
    for (const part of content as Array<{ type?: string; toolCallId?: string; output?: unknown }>) {
      if (part.type === 'tool-result' && part.toolCallId === call.toolCallId) {
        if (typeof part.output === 'string') return part.output
        const output = part.output as { type?: string; value?: unknown } | undefined
        if (output && typeof output === 'object' && typeof output.value === 'string') return output.value
        return JSON.stringify(part.output ?? '')
      }
    }
  }
  return ''
}

describe('background query tools', () => {
  it('lists and describes background sub-agent tasks', async () => {
    const state = createLoopState('default', { projectCwd: process.cwd() })
    const registry = new BackgroundTaskRegistry()
    const { task } = registry.start({
      toolCallId: 'task-call',
      agentName: 'explore',
      description: 'Scan the repo',
    })
    registry.complete(task.id, {
      status: 'completed',
      resultText: 'finished scanning',
      turnCount: 2,
      toolCallCount: 3,
    })
    const options: AgentOptions = {
      modelId: 'test-model',
      trustMode: true,
      printMode: false,
      backgroundTaskRegistry: registry,
    }

    const list = await runTool(state, options, 'backgroundList', {})
    expect(list).toContain(task.id)
    expect(list).toContain('explore')
    expect(list).toContain('completed')

    const get = await runTool(state, options, 'backgroundGet', { taskId: task.id })
    expect(get).toContain('finished scanning')
    expect(get).toContain('turns: 2')
    expect(get).toContain('tools: 3')
  })

  it('returns a running task output immediately, and can wait for completion', async () => {
    const state = createLoopState('default', { projectCwd: process.cwd() })
    const registry = new BackgroundTaskRegistry()
    const { task } = registry.start({
      toolCallId: 'task-call',
      agentName: 'general-purpose',
      description: 'Long review',
    })
    const options: AgentOptions = {
      modelId: 'test-model',
      trustMode: true,
      printMode: false,
      backgroundTaskRegistry: registry,
    }

    const immediate = await runTool(state, options, 'backgroundOutput', { taskId: task.id })
    expect(immediate).toContain('running')
    expect(immediate).toContain('no output yet')

    setTimeout(() => {
      registry.complete(task.id, { status: 'completed', resultText: 'review complete' })
    }, 20)
    const waited = await runTool(state, options, 'backgroundOutput', {
      taskId: task.id,
      block: true,
      timeoutMs: 2_000,
    })
    expect(waited).toContain('completed')
    expect(waited).toContain('review complete')
  })

  it('reads local shell state without consuming output', async () => {
    const state = createLoopState('default', { projectCwd: process.cwd() })
    vi.spyOn(state.shellSessions, 'list').mockReturnValue([
      {
        shellId: 'shell-1',
        command: 'npm test',
        effectiveCwd: process.cwd(),
        status: 'running',
        startedAt: Date.now() - 5_000,
        recentOutput: 'running tests\n',
        omittedBytes: 0,
      } as never,
    ])
    const options: AgentOptions = { modelId: 'test-model', trustMode: true, printMode: false }

    const output = await runTool(state, options, 'backgroundOutput', { taskId: 'shell-1' })

    expect(output).toContain('shell-1')
    expect(output).toContain('npm test')
    expect(output).toContain('running tests')
  })
})
