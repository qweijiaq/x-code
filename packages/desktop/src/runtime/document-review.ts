// 文档编辑审核：基线、行 diff，以及 hunk 级别的应用。
//
// 文本文档首次打开时捕获基线。当 agent（或其他程序）编辑该文件时，
// `document:diff` 对照该基线展示变更；应用选中的 hunk 会从
// 基线加上保留的变更重建文件。当前文件哈希会先校验，
// 因此用户在审核期间所做的编辑绝不会被静默覆盖。
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { computeEditDiff } from '@x-code-cli/core'
import type { EditDiffHunk } from '@x-code-cli/core'

import type { DocumentDiffView } from '../shared/protocol.js'
import { saveBaseline, storedBaseline } from './document-store.js'

const REVIEWABLE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
])
const MAX_REVIEW_BYTES = 2 * 1024 * 1024
/** 与 document-store 的基线落盘上限（400_000 字符）保持一致。两边不一致时，
 *  400k～2M 字符的文件会被当成「可审核」，但基线永远存不进去：`documentDiff`
 *  恒为 null，`applyDocumentHunks` 报 “No baseline stored”。 */
const MAX_REVIEW_CHARS = 400_000

export function isReviewable(filePath: string): boolean {
  return REVIEWABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function textHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readReviewable(filePath: string): Promise<{ text: string; hash: string } | null> {
  // stat 的原始 Node 错误（ENOENT/EACCES）会一路冒到 IPC 处理器并显示在 UI
  // 的错误条里；目录 / FIFO 的 size 为 0 还能骗过大小检查，然后 readFile 抛
  // EISDIR（甚至挂住）。这些都统一降级为「不可审核」。
  const stats = await fs.stat(filePath).catch(() => null)
  if (!stats || !stats.isFile()) return null
  if (stats.size > MAX_REVIEW_BYTES) return null
  const text = await fs.readFile(filePath, 'utf8')
  if (text.length > MAX_REVIEW_CHARS) return null
  return { text, hash: textHash(text) }
}

/** 面向用户的「读不到可审核内容」原因，替代裸的 Node 错误。 */
async function describeUnreviewable(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath).catch(() => null)
  if (!stats) return `Cannot read ${filePath}: the file no longer exists or is not accessible`
  if (!stats.isFile()) return `Cannot read ${filePath}: it is not a regular file`
  return `File is too large for edit review (limit ${Math.round(MAX_REVIEW_BYTES / (1024 * 1024))} MB)`
}

export interface BaselineState {
  editable: boolean
  hash: string
  changed: boolean
}

/** 首次打开时捕获基线；随后报告文件自存储基线以来
 *  是否已变化。 */
export async function ensureBaseline(filePath: string): Promise<BaselineState> {
  if (!isReviewable(filePath)) return { editable: false, hash: '', changed: false }
  const current = await readReviewable(filePath)
  if (!current) return { editable: false, hash: '', changed: false }
  const baseline = storedBaseline(filePath)
  if (!baseline) {
    saveBaseline(filePath, current.hash, current.text)
    return { editable: true, hash: current.hash, changed: false }
  }
  return { editable: true, hash: baseline.hash, changed: baseline.hash !== current.hash }
}

export async function documentDiff(filePath: string): Promise<DocumentDiffView | null> {
  if (!isReviewable(filePath)) return null
  const current = await readReviewable(filePath)
  const baseline = storedBaseline(filePath)
  if (!current || !baseline) return null
  if (baseline.hash === current.hash) return null
  const diff = computeEditDiff(filePath, baseline.text, current.text)
  if (!diff || diff.hunks.length === 0) return null
  return {
    hash: current.hash,
    baselineHash: baseline.hash,
    hunks: diff.hunks.map((hunk) => ({ ...hunk })),
    additions: diff.additions,
    removals: diff.removals,
  }
}

/** 重建新内容，只保留接受的 hunk（拒绝的 hunk
 *  回退到基线行）。hunk 从后往前应用，这样
 *  靠前的行号保持有效，同时替换后面的。 */
export function applySelectedHunks(currentText: string, hunks: EditDiffHunk[], accepted: Set<number>): string {
  const lines = currentText.split('\n')
  // `accepted` 的下标语义来自调用方传入的 hunks 顺序，不能依赖它恰好也按
  // 坐标有序（换一个 diff 实现或排序就够）。这里显式按 newStart 从后往前应用，
  // 靠前的行号因此保持有效；越界 / 非法的 hunk 直接跳过，避免 splice 悄悄截断
  // 文件尾部。
  const ordered = hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => a.hunk.newStart - b.hunk.newStart || a.index - b.index)
  for (let position = ordered.length - 1; position >= 0; position--) {
    const entry = ordered[position]!
    if (accepted.has(entry.index)) continue
    const hunk = entry.hunk
    if (!Number.isInteger(hunk.newStart) || !Number.isInteger(hunk.newLines)) continue
    if (hunk.newStart < 1 || hunk.newLines < 0) continue
    if (hunk.newStart - 1 + hunk.newLines > lines.length) continue
    const oldSide = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1))
    lines.splice(hunk.newStart - 1, hunk.newLines, ...oldSide)
  }
  return lines.join('\n')
}

async function writeAtomically(filePath: string, text: string): Promise<void> {
  const stats = await fs.stat(filePath)
  // 同一进程内同一文件的两次写入（并发 apply、或重试）不能用同一个临时文件名，
  // 否则两个调用会互相截断/覆盖对方的半成品再 rename 成正式文件。
  const suffix = crypto.randomBytes(6).toString('hex')
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${suffix}.review.tmp`)
  try {
    await fs.writeFile(temp, text, { mode: stats.mode })
  } catch (error) {
    // 写临时文件失败（ENOSPC/EDQUOT/目录不可写）时绝不能就地写入：
    // 那会先截断用户原有内容，磁盘仍满就留下一个半写入的文件。
    await fs.unlink(temp).catch(() => {})
    throw error
  }
  try {
    await fs.rename(temp, filePath)
  } catch (error) {
    await fs.unlink(temp).catch(() => {})
    const code = (error as NodeJS.ErrnoException).code
    // 只有 Windows 的覆盖语义失败（EPERM/EEXIST/ENOTEMPTY/EBUSY）才回退到
    // 就地写入；此处内容已完整校验，回退是安全的。
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error
    await fs.writeFile(filePath, text, { mode: stats.mode })
  }
}

interface DocumentLock {
  tail: Promise<void>
  pending: number
}

const documentLocks = new Map<string, DocumentLock>()

/** 按文件路径串行化审核写入：`applyDocumentHunks` 从读到写之间隔着多次 await，
 *  两个并发的 `document:apply-hunks` 会互相踩踏基线、并让后一个用陈旧内容覆盖
 *  前一个的结果。 */
async function withDocumentLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath)
  const entry = documentLocks.get(key) ?? { tail: Promise.resolve(), pending: 0 }
  entry.pending += 1
  documentLocks.set(key, entry)
  const previous = entry.tail
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  entry.tail = previous.then(() => gate)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    entry.pending -= 1
    // 没有排队者也没有持有者时移除条目，避免长会话里这个 Map 无界增长。
    if (entry.pending === 0) documentLocks.delete(key)
  }
}

export async function applyDocumentHunks(
  filePath: string,
  accepted: number[],
  expectedHash: string,
): Promise<{ hash: string; applied: number }> {
  return withDocumentLock(filePath, () => applyDocumentHunksLocked(filePath, accepted, expectedHash))
}

async function applyDocumentHunksLocked(
  filePath: string,
  accepted: number[],
  expectedHash: string,
): Promise<{ hash: string; applied: number }> {
  if (!isReviewable(filePath)) throw new Error('This file type does not support edit review')
  const current = await readReviewable(filePath)
  if (!current) throw new Error(await describeUnreviewable(filePath))
  if (typeof expectedHash !== 'string' || expectedHash === '') {
    throw new Error('Missing file hash for reviewed changes')
  }
  if (current.hash !== expectedHash) {
    throw new Error('File changed while the review was open; reload the document and review again')
  }
  const baseline = storedBaseline(filePath)
  if (!baseline) throw new Error('No baseline stored for this document')
  if (baseline.hash === current.hash) {
    // 没有变更：基线本来就等于当前内容。
    saveBaseline(filePath, current.hash, current.text)
    return { hash: current.hash, applied: 0 }
  }
  const diff = computeEditDiff(filePath, baseline.text, current.text)
  if (!diff || diff.hunks.length === 0) {
    // 文件确实变了，但算不出 hunk（例如 structuredPatch 超时返回空）。把基线
    // 推进到当前内容等于让未审阅的变更变成基线、旧基线永久丢失，界面还会显示
    // “应用成功”。保留基线并报一个可理解的错误。
    throw new Error(
      'Could not compute a diff for the reviewed changes; nothing was applied. Reload the document and try again.',
    )
  }
  const acceptedSet = new Set(
    accepted.filter((index) => Number.isInteger(index) && index >= 0 && index < diff.hunks.length),
  )
  const nextText = applySelectedHunks(current.text, diff.hunks, acceptedSet)
  if (nextText !== current.text) {
    // 计算与写入之间隔着多次 await：agent 或用户可能已经保存了文件。落盘前
    // 重读一次哈希做最终校验，避免静默覆盖。
    const latest = await readReviewable(filePath)
    if (!latest || latest.hash !== current.hash) {
      throw new Error('File changed while the reviewed edits were being applied; reload the document and try again')
    }
    await writeAtomically(filePath, nextText)
  }
  const hash = textHash(nextText)
  saveBaseline(filePath, hash, nextText)
  return { hash, applied: acceptedSet.size }
}

/** 把当前内容作为新基线（放弃审核）。 */
export async function saveCurrentBaseline(filePath: string): Promise<{ hash: string }> {
  const current = await readReviewable(filePath)
  if (!current) throw new Error(await describeUnreviewable(filePath))
  saveBaseline(filePath, current.hash, current.text)
  return { hash: current.hash }
}
