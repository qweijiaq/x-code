// @x-code-cli/core — 共享的 JSON 设置文件读/改/写
//
// 技能（disabledSkills）和插件（enabledPlugins）都使用同一批物理
// settings.json 文件（用户作用域和项目作用域）。本模块提供共享的读-改-写
// 管道，让每个子系统只需处理各自的字段逻辑。
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage } from './utils.js'
import { atomicWriteFile } from './utils/atomic-file.js'

/** settings.json 读取失败——文件存在但读不出来（EACCES/EISDIR/EIO…），
 *  或内容不是合法 JSON。调用方必须区别对待：
 *  - 写路径（`mutateSettingsFile`）必须放弃写入，否则会以空对象为基准
 *    整体重写文件、静默清空用户设置；
 *  - 纯读路径可以降级（见 {@link readSettingsFileForRead}）。 */
export class SettingsReadError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SettingsReadError'
  }
}

/** 读取 settings.json 文件，返回可变的浅拷贝——可以先修改再传给写入路径。
 *
 *  只有“文件不存在”（ENOENT）等价于“没有设置”而返回 `{}`。其它读取错误
 *  和 JSON 解析失败一律抛 {@link SettingsReadError}：本函数的返回值会被
 *  `mutateSettingsFile` 当作整份文件的新内容写回，降级成 `{}` 就会把
 *  `disabledSkills`/`enabledPlugins` 之外的字段全部抹掉。 */
export async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new SettingsReadError(filePath, `Cannot read settings file ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new SettingsReadError(filePath, `Cannot parse settings file ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    })
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>) }
  }
  return {}
}

/** {@link readSettingsFile} 的“纯读”变体：读取失败时记录调试日志并降级成
 *  `{}`，让启动路径（插件/技能加载）不会因为一个损坏的设置文件而崩掉。
 *  绝不要在写路径使用它——写路径必须用严格版本。 */
export async function readSettingsFileForRead(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readSettingsFile(filePath)
  } catch (error) {
    if (error instanceof SettingsReadError) {
      debugLog('settings.read-failed', `${error.filePath}: ${error.message}`)
      return {}
    }
    throw error
  }
}

/** 把设置对象写回磁盘，且不会暴露部分写入的 JSON 文件。 */
async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n')
}

/** 按目标路径串行化读-改-写。技能与插件共用同一批物理文件，并发
 *  `mutateSettingsFile` 会各自读到同一份快照、再由后完成的一方用陈旧快照
 *  整体覆盖写回，先完成的一方的修改就丢了。原子写只保证单次写入不暴露
 *  半截文件，解决不了这个语义冲突，所以这里在本进程内按路径排队。 */
const mutationChains = new Map<string, Promise<unknown>>()

/** 对 settings.json 文件执行读-改-写。mutator 仅在实际修改对象时返回 true，
 *  从而避免无操作更新触发不必要的写入。同一路径的并发调用按调用顺序排队。 */
export async function mutateSettingsFile(
  filePath: string,
  mutator: (data: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const key = path.resolve(filePath)
  const previous = mutationChains.get(key) ?? Promise.resolve()
  const task = previous.then(async () => {
    const data = await readSettingsFile(filePath)
    const changed = mutator(data)
    if (!changed) return false
    await writeSettingsFile(filePath, data)
    return true
  })
  // 队列尾部永远是一个不会 reject 的 promise，这样一次失败不会污染后续任务。
  const tail = task.catch(() => {})
  mutationChains.set(key, tail)
  try {
    return await task
  } finally {
    if (mutationChains.get(key) === tail) mutationChains.delete(key)
  }
}
