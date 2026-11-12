// @x-code-cli/core — 变更影响分析工具
//
// 给根 Agent 一个只读入口：从 git 变更或显式文件出发，返回直接/传递依赖与
// 相关测试。实现复用 analysis/impact.ts，CLI `/impact` 使用同一份逻辑。
import { tool } from 'ai'

import { z } from 'zod'

import { analyzeChangeImpact, formatImpactReport } from '../analysis/impact.js'

export function createImpactAnalysisTool(projectCwd: string) {
  return tool({
    description:
      'Analyze the impact of changed code files. Defaults to changed files from git status; pass `files` to override. Returns direct/transitive dependents and related test files, with a readable summary. Read-only. Use before refactors or to decide which tests to run.',
    inputSchema: z.object({
      files: z.array(z.string()).max(50).optional().describe('Changed file paths (default: git status)'),
      maxDepth: z.number().int().min(1).max(8).optional().describe('Dependency BFS depth (default: 3)'),
      lsp: z.boolean().optional().describe('Also query TypeScript LSP references (slower)'),
    }),
    execute: async ({ files, maxDepth, lsp }) => {
      const report = await analyzeChangeImpact({
        cwd: projectCwd,
        ...(files && files.length > 0 ? { files } : {}),
        ...(maxDepth ? { maxDepth } : {}),
        ...(lsp ? { lsp: true } : {}),
      })
      return { report, summary: formatImpactReport(report) }
    },
  })
}
