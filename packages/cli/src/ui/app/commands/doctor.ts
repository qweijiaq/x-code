// @x-code-cli/cli — /doctor 斜杠命令处理器。
//
// 一次性环境诊断：检查 API 密钥、Node 版本、shell 可用性、MCP 服务器健康、
// 插件加载错误、自定义代理解析状态，以及知识文件大小。以 Claude Code 的
// /doctor 为模板，但范围限定在 x-code-cli 实际需要的内容。
import { getAvailableProviders, getEnvVarName, getOpenAIAuthStatus } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { VERSION } from '../../../version.js'

export interface DoctorCommandDeps {
  options: AgentOptions
  modelId: string
  addInfoMessage: (content: string) => void
  echoCommand: (text: string) => void
}

/** 所有已知供应商键——顺序与 PROVIDER_DETECTION_ORDER 一致。 */
const ALL_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'alibaba', 'xai', 'zhipu', 'moonshotai'] as const

export function createDoctorCommandHandler(deps: DoctorCommandDeps) {
  const { options, modelId, addInfoMessage, echoCommand } = deps

  function handleDoctor(text: string): void {
    echoCommand(text)
    const sections: string[] = []

    // ── 环境 ────────────────────────────────────────────────────
    {
      const lines = ['**Environment**', '']
      lines.push(`- Version: ${VERSION}`)
      lines.push(`- Node:    ${process.version}`)
      lines.push(`- Model:   ${modelId}`)
      lines.push(`- OS:      ${process.platform} ${process.arch}`)

      const nodeVersion = parseInt(process.version.slice(1), 10)
      if (nodeVersion < 20) {
        lines.push('', '⚠ Node ≥ 20.19 is required. Current version may cause issues.')
      }
      sections.push(lines.join('\n'))
    }

    // ── 供应商 ──────────────────────────────────────────────────────
    {
      const available = new Set(getAvailableProviders())
      const openAIAuth = getOpenAIAuthStatus()
      const lines = ['**Providers**', '']
      for (const p of ALL_PROVIDERS) {
        const envVar = getEnvVarName(p)
        const ok = available.has(p)
        if (p === 'openai' && openAIAuth.mode === 'chatgpt') {
          const suffix = openAIAuth.apiKeyConfigured ? '; OPENAI_API_KEY inactive' : ''
          lines.push(`- openai: ✓ ChatGPT subscription${suffix}`)
          if (openAIAuth.credentialError) lines.push(`  ⚠ ${openAIAuth.credentialError}`)
          continue
        }
        lines.push(`- ${p}: ${ok ? '✓' : `✗  (set \`${envVar}\`)`}`)
      }
      // 自定义供应商
      const hasCustom = available.has('custom')
      if (hasCustom) {
        lines.push('- custom: ✓')
      }
      const configuredCount = available.size
      if (configuredCount === 0) {
        lines.push('', '⚠ No provider configured. Run `xc login` or set a provider API key.')
      }
      sections.push(lines.join('\n'))
    }

    // ── MCP 服务器 ────────────────────────────────────────────────────
    {
      const statuses = options.mcpRegistry?.serverStatus() ?? []
      const lines = ['**MCP Servers**', '']
      if (statuses.length === 0) {
        lines.push('_(none configured)_')
      } else {
        for (const s of statuses) {
          const kind = s.status.kind
          if (kind === 'connected') {
            const st = s.status as { kind: 'connected'; toolCount: number; resourceCount: number }
            lines.push(`- ${s.name}: ✓ connected (${st.toolCount} tools, ${st.resourceCount} resources)`)
          } else if (kind === 'failed') {
            const st = s.status as { kind: 'failed'; error: string }
            const errSnippet = st.error.length > 80 ? st.error.slice(0, 80) + '…' : st.error
            lines.push(`- ${s.name}: ✗ failed — ${errSnippet}`)
            if (s.stderrTail) {
              lines.push(`  stderr: ${s.stderrTail.slice(0, 120)}`)
            }
          } else if (kind === 'needs_auth') {
            lines.push(`- ${s.name}: ⚠ needs authentication — run \`/mcp auth ${s.name}\``)
          } else if (kind === 'disabled') {
            lines.push(`- ${s.name}: — disabled`)
          } else {
            lines.push(`- ${s.name}: ${kind}`)
          }
        }
        const failedCount = statuses.filter((s) => s.status.kind === 'failed').length
        if (failedCount > 0) {
          lines.push(
            '',
            `⚠ ${failedCount} server${failedCount === 1 ? '' : 's'} failed. Check config or run \`/mcp refresh\`.`,
          )
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── 插件 ────────────────────────────────────────────────────────
    {
      const all = options.pluginRegistry?.listAll() ?? []
      const errors = options.pluginRegistry?.loadErrors() ?? []
      const lines = ['**Plugins**', '']
      const enabled = all.filter((p) => p.enabled).length
      const disabled = all.length - enabled
      lines.push(`- Loaded: ${all.length} (${enabled} enabled, ${disabled} disabled)`)
      lines.push(`- Errors: ${errors.length}`)
      if (errors.length > 0) {
        lines.push('')
        for (const e of errors) {
          lines.push(`  ✗ ${e.id ?? '(unknown)'} — ${e.message}`)
        }
        lines.push('', 'Run `/plugin doctor` for details.')
      }
      sections.push(lines.join('\n'))
    }

    // ── 子代理 ─────────────────────────────────────────────────────
    {
      const agents = options.subAgentRegistry?.list() ?? []
      const lines = ['**Sub-Agents**', '']
      const builtIn = agents.filter((a) => a.source === 'built-in').length
      const custom = agents.length - builtIn
      lines.push(`- Total: ${agents.length} (${builtIn} built-in, ${custom} custom)`)
      if (custom > 0) {
        const customAgents = agents.filter((a) => a.source !== 'built-in')
        for (const a of customAgents) {
          lines.push(`  • ${a.name} (${a.source}${a.pluginId ? `, plugin: ${a.pluginId}` : ''})`)
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── 技能 ─────────────────────────────────────────────────────────
    {
      const skills = options.skillRegistry?.listAll() ?? []
      const lines = ['**Skills**', '']
      const enabled = skills.filter((s) => !s.disabled).length
      const disabled = skills.length - enabled
      lines.push(`- Total: ${skills.length} (${enabled} enabled, ${disabled} disabled)`)
      sections.push(lines.join('\n'))
    }

    // ── 命令 ────────────────────────────────────────────────────────
    {
      const commands = options.commandRegistry?.list() ?? []
      const lines = ['**Commands**', '']
      if (commands.length === 0) {
        lines.push('_(none from plugins)_')
      } else {
        lines.push(`- Total: ${commands.length}`)
        for (const cmd of commands) {
          lines.push(`  • /${cmd.name} (${cmd.source}${cmd.pluginId ? `, plugin: ${cmd.pluginId}` : ''})`)
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── 组装 ───────────────────────────────────────────────────────
    addInfoMessage(sections.join('\n\n'))
  }

  return handleDoctor
}
