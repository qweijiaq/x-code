// @x-code-cli/desktop — AgentHost 的纯视图/文件助手
//
// 从 agent-host.ts 拆出的无状态部分：协议视图转换、路径解析、目录统计、
// 技能签名扫描和工具标签。它们不依赖 AgentHost 实例状态，便于单独测试。
import fs from 'node:fs'
import path from 'node:path'

import type { EditDiffPayload, TodoItem, TokenUsage, UsageBreakdown, UserConfigItem } from '@x-code-cli/core'

import type {
  ApprovalKind,
  FileEditView,
  ProjectCheckResultView,
  UsageView,
  UserConfigFieldView,
} from '../shared/protocol.js'
import { checkCommandLabel } from './project-checks.js'
import type { CheckResult } from './project-checks.js'
import { usageView } from './sessions.js'

export interface ActiveTurn {
  id: string
  text: string
  startedAt: number
}

export interface PendingApproval {
  kind: ApprovalKind
  resolve: (value: unknown) => void
  authority?: { canonicalCallSha256: string; authorityHash: string }
}

export interface TurnResult {
  text: string
  reason: string
  sessionId: string
  modelId: string
}

export const FILE_TREE_SKIP = new Set([
  '.git',
  '.x-code',
  '.DS_Store',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
])
export const MAX_EDITOR_READ_BYTES = 1_000_000
export const MAX_EDITOR_WRITE_BYTES = 2_000_000

/** 内置工具界面的中文标签。面向模型的工具名称和英文描述保持不变。 */
export const TOOL_META: Record<string, { label: string; description: string }> = {
  readFile: { label: '读取文件', description: '读取本地文件的完整内容' },
  readDocument: {
    label: '读取文档',
    description: '从 PDF、Word、Excel、Markdown、CSV、EPUB、MOBI、图片、音频、视频中提取文本与元数据（本地解析）',
  },
  writeFile: { label: '写入文件', description: '创建或覆盖本地文件（写入权限）' },
  edit: { label: '编辑文件', description: '对文件做精确查找替换（写入权限）' },
  shell: { label: '执行命令', description: '运行 shell 命令并返回输出（写入权限）' },
  glob: { label: '查找文件', description: '按 glob 模式查找文件' },
  grep: { label: '搜索内容', description: '按正则搜索文件内容' },
  listDir: { label: '列出目录', description: '列出目录中的文件与子目录' },
  webSearch: { label: '联网搜索', description: '通过搜索服务检索网页' },
  webFetch: { label: '抓取网页', description: '抓取指定 URL 的网页内容' },
  askUser: { label: '询问用户', description: '向用户提出一个选择题' },
  enterPlanMode: { label: '进入计划模式', description: '切换到只读计划模式' },
  exitPlanMode: { label: '退出计划模式', description: '提交计划并请求批准' },
  todoWrite: { label: '待办清单', description: '更新当前任务的待办列表' },
  shellOutput: { label: '读取后台输出', description: '读取后台 shell 的输出' },
  killShell: { label: '终止后台进程', description: '终止一个后台 shell 进程（写入权限）' },
  batchRename: {
    label: '批量重命名',
    description: '按规则批量为文件改名，默认仅预览、不覆盖、上限 100 个（写入权限）',
  },
  convert: { label: '格式转换', description: '合并 PDF、提取 PDF 页面、macOS 图片格式转换（写入权限）' },
  transcribe: { label: '语音转写', description: '用本机 whisper 将音频转写为带时间戳的文本，音频不上传' },
  spreadsheet: { label: '表格处理', description: '读取、过滤聚合、写回 xlsx，并生成简单 SVG 图表（写入需授权）' },
  documentSearch: { label: '文档检索', description: '在本地文档库中做关键词与语义混合检索，返回文件、页码与片段' },
  documentLibrary: { label: '文档库', description: '索引文件夹、查看统计或清空本地文档库（清空需授权）' },
}

export function toCheckResultView(result: CheckResult): ProjectCheckResultView {
  return {
    id: result.id,
    label: result.label,
    kind: result.kind,
    commandLine: checkCommandLabel(result),
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.output,
  }
}

export function toUserConfigFields(items: UserConfigItem[] | undefined): UserConfigFieldView[] {
  return (items ?? []).map((item) => ({
    key: item.key,
    type: item.type,
    sensitive: item.sensitive === true,
    ...(item.prompt ? { prompt: item.prompt } : {}),
    required: item.required === true,
    ...(item.default !== undefined ? { default: item.default } : {}),
    ...(item.description ? { description: item.description } : {}),
  }))
}

export function toUsageView(usage: TokenUsage, modelId: string, breakdown?: UsageBreakdown): UsageView {
  return usageView(usage, modelId, breakdown)
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/** 通过符号链接解析到最深的现有祖先目录，再追加缺失的后缀。
 *  复刻 core 的权限路径辅助函数，但不导出另一个公共 API。 */
export async function directoryStats(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(target)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(target)
          bytes += stat.size
          files += 1
        } catch {
          // 扫描过程中已消失。
        }
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

export function realpathAllowMissing(target: string): string {
  const suffix: string[] = []
  let current = target
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

export function toFileEditView(payload: EditDiffPayload): FileEditView {
  return {
    filePath: payload.filePath,
    additions: payload.additions,
    removals: payload.removals,
    isCreate: payload.isCreate,
    content: payload.content,
    revertible: payload.afterContent !== undefined && (payload.isCreate || payload.beforeContent !== undefined),
    hunks: payload.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
    })),
  }
}

export function toTodoViews(
  todos: TodoItem[],
): Array<{ content: string; activeForm: string; status: TodoItem['status'] }> {
  return todos.map((todo) => ({ content: todo.content, activeForm: todo.activeForm, status: todo.status }))
}

const SKILL_SIGNATURE_SKIP = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'runtime',
  'models',
  'dist',
  'build',
  'target',
])

/** 外部技能安装的轻量变更检测器。只遍历技能目录
 *  （有界深度），并对 SKILL.md 的 path+mtime+size 做哈希。 */
export async function collectSkillSignatures(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKILL_SIGNATURE_SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSkillSignatures(full, depth + 1, out)
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      try {
        const stat = await fs.promises.stat(full)
        out.push(`${full}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        // 遍历过程中已消失。
      }
    }
  }
}
