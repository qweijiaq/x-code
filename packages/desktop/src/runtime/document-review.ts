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

export function isReviewable(filePath: string): boolean {
  return REVIEWABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function textHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readReviewable(filePath: string): Promise<{ text: string; hash: string } | null> {
  const stats = await fs.stat(filePath)
  if (stats.size > MAX_REVIEW_BYTES) return null
  const text = await fs.readFile(filePath, 'utf8')
  return { text, hash: textHash(text) }
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
  for (let index = hunks.length - 1; index >= 0; index--) {
    if (accepted.has(index)) continue
    const hunk = hunks[index]!
    const oldSide = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1))
    lines.splice(hunk.newStart - 1, hunk.newLines, ...oldSide)
  }
  return lines.join('\n')
}

async function writeAtomically(filePath: string, text: string): Promise<void> {
  const stats = await fs.stat(filePath)
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.review.tmp`)
  try {
    await fs.writeFile(temp, text, { mode: stats.mode })
    await fs.rename(temp, filePath)
  } catch (error) {
    await fs.unlink(temp).catch(() => {})
    // Windows 可能拒绝覆盖已有文件的 rename；此时内容已
    // 完全校验，因此回退到就地写入。
    await fs.writeFile(filePath, text, { mode: stats.mode })
    if (!(error instanceof Error)) throw error
  }
}

export async function applyDocumentHunks(
  filePath: string,
  accepted: number[],
  expectedHash: string,
): Promise<{ hash: string; applied: number }> {
  if (!isReviewable(filePath)) throw new Error('This file type does not support edit review')
  const current = await readReviewable(filePath)
  if (!current) throw new Error('File is too large for edit review')
  if (typeof expectedHash !== 'string' || expectedHash === '') {
    throw new Error('Missing file hash for reviewed changes')
  }
  if (current.hash !== expectedHash) {
    throw new Error('File changed while the review was open; reload the document and review again')
  }
  const baseline = storedBaseline(filePath)
  if (!baseline) throw new Error('No baseline stored for this document')
  const diff = computeEditDiff(filePath, baseline.text, current.text)
  if (!diff || diff.hunks.length === 0) {
    saveBaseline(filePath, current.hash, current.text)
    return { hash: current.hash, applied: 0 }
  }
  const acceptedSet = new Set(
    accepted.filter((index) => Number.isInteger(index) && index >= 0 && index < diff.hunks.length),
  )
  const nextText = applySelectedHunks(current.text, diff.hunks, acceptedSet)
  if (nextText !== current.text) await writeAtomically(filePath, nextText)
  const hash = textHash(nextText)
  saveBaseline(filePath, hash, nextText)
  return { hash, applied: acceptedSet.size }
}

/** 把当前内容作为新基线（放弃审核）。 */
export async function saveCurrentBaseline(filePath: string): Promise<{ hash: string }> {
  const current = await readReviewable(filePath)
  if (!current) throw new Error('File is too large for edit review')
  saveBaseline(filePath, current.hash, current.text)
  return { hash: current.hash }
}
