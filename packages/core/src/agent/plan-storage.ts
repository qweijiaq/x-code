// @x-code-cli/core — Plan 模式文件存储
//
// 计划存放在用户项目内的 `.x-code/plans/<slug>-<YYYYMMDD-HHMMSS>.md`
// （而不是用户作用域的 `~/.x-code/`）。这与 `.x-code/sessions/`、
// `.x-code/memory/` 的作用域方式一致：按项目隔离、被 gitignore、绝不跨仓库共享。
// “slug 在前 + 时间戳在后”的命名与 `.x-code/plans/` 下已有的旧文件名一致
// （例如 `vue-3-vite-typescript-snake-game-20260420-102410.md`）——
// 既能在 `ls` 里一眼看懂，又能按最近时间排序。
//
// Claude Code 把计划全局存放在 `~/.claude/plans/{slug}.md`，slug 用随机的
// 双词组合（`brilliant-crystal.md`）。我们应需求选择了“项目本地 + 由主题派生的
// slug”——以后更容易找到，而且计划跟它为之编写的仓库待在一起。
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR } from '../utils.js'

const PLANS_SUBDIR = 'plans'
const SLUG_MAX_LEN = 40

/** 把任意任务描述转换成对文件系统安全、小写、以连字符分隔的 slug。
 *  丢弃 `[a-z0-9 -]` 之外的一切字符（因此 CJK / emoji / 标点会坍缩为空——
 *  纯 CJK 任务会产生空 slug，这是有意为之，由调用方的“仅时间戳”兜底处理）。
 *  长度上限为 SLUG_MAX_LEN，以便 `ls` 列保持可读。 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '')
}

/** 把 Date 格式化为 `YYYYMMDD-HHMMSS`。本地时间、无时区后缀——
 *  与旧计划文件的约定一致，用户也已习惯这样肉眼扫读。 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** 计划目录所在的基准。必须由调用方传入会话的 `projectCwd`：`process.cwd()`
 *  只是兜底。desktop 运行时存在 `process.chdir(workspace)` 与多会话共进程的情况，
 *  一旦 `process.cwd() !== state.projectCwd`：①计划文件会写到别的项目/工作区目录下，
 *  违背本文件顶部“按项目隔离”的设计；②`makePlanFilePath` 产出的路径落在
 *  `tool-execution.ts` 计算的 `planRoot`（= `projectCwd/.x-code/plans`）之外，
 *  `enforcePlanModeBoundary` 会拒绝模型对当前计划文件的 writeFile/edit，
 *  plan 模式直接不可用。 */
function plansDir(cwd: string = process.cwd()): string {
  return path.join(cwd, XCODE_DIR, PLANS_SUBDIR)
}

/** 根据任务描述（通常是用户最近的一条消息）生成新的计划文件路径。
 *  纯函数——无 I/O——因此调用方可以在文件实际存在之前，先把路径暂存到 LoopState 上。
 *  格式：`<slug>-<timestamp>.md`（时间戳可能冲突时仅用 slug；任务文本产生空 slug 时仅用时间戳）。
 *  当调用方已有预先算好的 slug（例如 agentLoop 的会话级 `taskSlug`）时，传入 `opts.slug`
 *  以跳过本地的 slugify 步骤——这对非 ASCII 任务文本很重要，因为那种情况 slugify 会返回空。 */
export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date; projectCwd?: string }): string {
  // `opts.slug` 不是可信输入：enterPlanMode 的 `topic` 直接来自模型可控的工具入参
  // （见 plan-tools.ts）。不过滤的话 `../../../../.ssh/authorized_keys` 会被
  // `path.join` 规范化成计划目录之外的路径，且能绕过 SLUG_MAX_LEN 撞上
  // ENAMETOOLONG / Windows 非法文件名字符。与本地 slugify 同等净化。
  const slug = slugify(opts?.slug ?? taskText)
  const ts = formatTimestamp(opts?.now ?? new Date())
  const name = slug ? `${slug}-${ts}` : ts
  const dir = plansDir(opts?.projectCwd)
  const target = path.join(dir, `${name}.md`)
  if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`unsafe plan file name: ${name}`)
  }
  return target
}

/** 为会话派生一个人类易读的文件名 slug。
 *
 *  这必须保持本地且同步：会话命名只是元数据，绝不能延迟用户的第一条模型请求。
 *  纯 CJK / 纯 emoji 输入会返回 ''，调用方会将其映射为仅时间戳的文件名。 */
export function generateTaskSlug(taskText: string): string {
  return slugify(taskText)
}

/** 确保计划目录存在。使用递归 mkdir，这样就不必单独再确保 `.x-code/` 存在——
 *  在新项目里写第一个计划时，父目录会自动创建。 */
async function ensurePlanDir(cwd: string = process.cwd()): Promise<void> {
  await fs.mkdir(plansDir(cwd), { recursive: true })
}

/** 读取 `planPath` 处的计划正文。文件不存在时返回空字符串——
 *  exitPlanMode 调用它来取回模型目前写下的内容，“还没写计划”是一个
 *  合法（尽管无帮助）的状态。 */
export async function readPlan(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf-8')
  } catch {
    return ''
  }
}

/** 把计划正文持久化到 `planPath`。exitPlanMode 在模型传入 `plan` 覆盖值时用它，
 *  让磁盘记录与用户正在批准的内容一致。返回写入的路径（总是等于输入）。
 *  `cwd` 必须与会话的 `projectCwd` 一致（见 {@link plansDir}）：否则目录会被创建
 *  在 process.cwd() 下，而随后往 planPath 写入时会因为父目录不存在而 ENOENT。 */
export async function writePlan(planPath: string, body: string, cwd: string = process.cwd()): Promise<string> {
  await ensurePlanDir(cwd)
  await fs.writeFile(planPath, body, 'utf-8')
  return planPath
}
