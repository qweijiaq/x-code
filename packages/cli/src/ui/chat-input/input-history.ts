// @x-code-cli/cli — 输入历史（Up/Down 回调）的后备存储。
//
// 持久化形态：`.x-code/history.jsonl`，每行一个 JSON 对象，只追加。项目本地
// 化，两个无关项目不会互相污染回调——与我们现有的约定一致（`.x-code/sessions/`、
// `.x-code/plans/`、`.x-code/memory/`）。Claude Code 改用单个全局文件，每条记
// 录带 `project:` 字段；我们选择了更简单的按项目分文件，因为 (a) 它绕过了他们
// 全局文件所需的跨进程 flush 队列 + 锁文件那套繁琐机制，且 (b) 它让历史与
// `.x-code/` 其余部分风格一致——gitignore、按作用域隔离、随项目即可丢弃。
//
// 启动时只读文件尾部。追加会周期性通过临时文件 + 原子重命名压缩过大的历史，
// 这样启动成本保持有界，又不会在重写被中断时冒险损坏原文件。
//
// 写入由 UI 触发后即忘（fire-and-forget），并在本进程内按文件串行化，所以压缩
// 不会与后续追加竞争。我们有意跳过跨进程锁文件：历史是项目本地的，每次追加都
// 保持为一次追加模式的写入。
import fs from 'node:fs/promises'
import path from 'node:path'

import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { ensureProjectStorageDir } from '@x-code-cli/core'

import type { PastedContents } from './paste-refs.js'
import type { InputAction } from './reducer.js'

const HISTORY_FILE = '.x-code/history.jsonl'
const HISTORY_READ_BYTES = 1024 * 1024
const HISTORY_COMPACT_BYTES = 2 * 1024 * 1024
const HISTORY_COMPACT_MAX = 500
const HISTORY_READ_CHUNK = 64 * 1024

/** 对应 Claude Code 的 `MAX_HISTORY_ITEMS`。用户按 Up 时只会看到最近的 100 条
 *  记录；磁盘压缩则保留更宽的 500 条窗口。 */
const HISTORY_MAX = 100
const historyWriteQueues = new Map<string, Promise<void>>()

export interface InputHistoryEntry {
  /** 粘贴展开前的文本（保留 `[Pasted text #N]` 引用的占位形式）。恢复这种形式
   *  能保持输入框紧凑，而不是把整段粘贴重新展开回实时帧。 */
  text: string
  pasted: PastedContents
  ts: number
}

function historyPath(cwd: string): string {
  return path.join(cwd, HISTORY_FILE)
}

/** 最多读取 HISTORY_MAX 条最近记录。返回最旧在前，这样调用方可以把新提交
 *  `push` 到尾部，再通过 `arr[arr.length - 1 - i]` 往回走——与内存中
 *  `historyRef` 使用的形态一致。 */
async function readHistoryTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxBytes)
    const start = stat.size - length
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let raw = buffer.subarray(0, bytesRead).toString('utf-8')
    if (start > 0) {
      const firstNewline = raw.indexOf('\n')
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    }
    return raw
  } finally {
    await handle.close()
  }
}

async function readLastRawLines(file: string, maxLines: number): Promise<string[]> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    let position = stat.size
    let newlineCount = 0
    const chunks: Buffer[] = []

    while (position > 0 && newlineCount <= maxLines) {
      const length = Math.min(HISTORY_READ_CHUNK, position)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount++
      }
    }

    let raw = Buffer.concat(chunks).toString('utf-8')
    if (position > 0) {
      const firstNewline = raw.indexOf('\n')
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-maxLines)
  } finally {
    await handle.close()
  }
}

async function compactInputHistory(file: string): Promise<void> {
  const lines = await readLastRawLines(file, HISTORY_COMPACT_MAX)
  const tempFile = `${file}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(tempFile, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8')
    await fs.rename(tempFile, file)
  } catch (error) {
    await fs.unlink(tempFile).catch(() => undefined)
    throw error
  }
}

export async function loadInputHistory(cwd: string = process.cwd()): Promise<InputHistoryEntry[]> {
  let raw: string
  try {
    raw = await readHistoryTail(historyPath(cwd), HISTORY_READ_BYTES)
  } catch {
    // 首次运行时 ENOENT——历史为空。其他任何错误也一视同仁地静默处理：历史
    // 并非关键路径，绝不阻塞启动。
    return []
  }
  // 尾部换行是正常的（每次追加都以 `\n` 结尾）；过滤空行，以及部分写入留下的
  // 任何空白行。
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const tail = lines.length > HISTORY_MAX ? lines.slice(lines.length - HISTORY_MAX) : lines
  const out: InputHistoryEntry[] = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<InputHistoryEntry>
      if (typeof parsed.text !== 'string' || !parsed.text) continue
      out.push({
        text: parsed.text,
        pasted: (parsed.pasted as PastedContents | undefined) ?? {},
        ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
      })
    } catch {
      // 损坏的行（写入中途崩溃、手动编辑）。跳过——宁可丢一条，也别让启动中断。
    }
  }
  return out
}

/** 追加一条记录。触发后即忘：返回 promise 供测试 await，但调用方可忽略。错误被
 *  吞掉，因为输入历史是 UX 锦上添花，不是承重墙——因磁盘偶发故障丢一条记录，好过
 *  在用户输入中途弹出一个错误。 */
async function appendInputHistoryNow(entry: InputHistoryEntry, file: string): Promise<void> {
  await ensureProjectStorageDir(path.dirname(file))
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' })
  const stat = await fs.stat(file)
  if (stat.size > HISTORY_COMPACT_BYTES) await compactInputHistory(file)
}

export async function appendInputHistory(entry: InputHistoryEntry, cwd: string = process.cwd()): Promise<void> {
  const file = historyPath(cwd)
  const previous = historyWriteQueues.get(file) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(() => appendInputHistoryNow(entry, file))
  historyWriteQueues.set(file, queued)
  try {
    await queued
  } catch {
    /* 尽力而为 */
  } finally {
    if (historyWriteQueues.get(file) === queued) historyWriteQueues.delete(file)
  }
}

interface UseInputHistoryOptions {
  text: string
  cursorRef: MutableRefObject<number>
  pastedContents: PastedContents
  dispatch: Dispatch<InputAction>
  setPastedContents: Dispatch<SetStateAction<PastedContents>>
  setCompletionIndex: Dispatch<SetStateAction<number>>
  setAtCompletionIndex: Dispatch<SetStateAction<number>>
}

export function useInputHistory({
  text,
  cursorRef,
  pastedContents,
  dispatch,
  setPastedContents,
  setCompletionIndex,
  setAtCompletionIndex,
}: UseInputHistoryOptions) {
  // 导航计数器保持同步，这样快速连续按 Up/Down 永远不会读到上一次渲染的 React
  // 状态值。历史保留紧凑的粘贴引用形式；恢复展开后的粘贴会把原始内容灌满输入框。
  const historyRef = useRef<InputHistoryEntry[]>([])
  const historyIndexRef = useRef(0)
  const historyDraftRef = useRef<{ text: string; cursor: number; pasted: PastedContents } | null>(null)
  // 把存储钉在启动目录，这样工具驱动的 `cd` 无法把一个会话的读写拆到两个项目
  // 历史文件里。
  const initialCwdRef = useRef(process.cwd())

  useEffect(() => {
    let cancelled = false
    void loadInputHistory(initialCwdRef.current).then((entries) => {
      if (cancelled) return
      historyRef.current = entries
    })
    return () => {
      cancelled = true
    }
  }, [])

  const resetHistoryNav = () => {
    historyIndexRef.current = 0
    historyDraftRef.current = null
  }

  const pushHistory = (raw: string, pasted: PastedContents) => {
    if (!raw.trim()) return
    const last = historyRef.current[historyRef.current.length - 1]
    if (last && last.text === raw) return
    const entry: InputHistoryEntry = { text: raw, pasted: { ...pasted }, ts: Date.now() }
    historyRef.current.push(entry)
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift()
    void appendInputHistory(entry, initialCwdRef.current)
  }

  const restoreHistoryEntry = (entry: { text: string; pasted: PastedContents }, cursorAt: 'start' | 'end') => {
    dispatch({ type: 'SET_TEXT', text: entry.text, cursor: cursorAt === 'start' ? 0 : entry.text.length })
    setPastedContents({ ...entry.pasted })
    setCompletionIndex(0)
    setAtCompletionIndex(0)
  }

  const navigateHistoryUp = () => {
    if (historyRef.current.length === 0) return
    if (historyIndexRef.current >= historyRef.current.length) return
    if (historyIndexRef.current === 0) {
      historyDraftRef.current = {
        text,
        cursor: cursorRef.current,
        pasted: { ...pastedContents },
      }
    }
    historyIndexRef.current += 1
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'start')
  }

  const navigateHistoryDown = () => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    if (historyIndexRef.current === 0) {
      const draft = historyDraftRef.current
      historyDraftRef.current = null
      if (draft) {
        dispatch({ type: 'SET_TEXT', text: draft.text, cursor: draft.cursor })
        setPastedContents({ ...draft.pasted })
      } else {
        dispatch({ type: 'RESET' })
        setPastedContents({})
      }
      setCompletionIndex(0)
      setAtCompletionIndex(0)
      return
    }
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'end')
  }

  const isNavigatingHistory = () => historyIndexRef.current > 0

  return { isNavigatingHistory, navigateHistoryDown, navigateHistoryUp, pushHistory, resetHistoryNav }
}
