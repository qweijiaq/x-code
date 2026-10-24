// Document edit review: baselines, line diffs, and hunk-level apply.
//
// A baseline is captured the first time a text document is opened. When the
// agent (or another program) edits the file, `document:diff` shows the change
// against that baseline; applying selected hunks rebuilds the file from the
// baseline plus the kept changes. The current file hash is verified first, so
// an edit made while the user is reviewing never gets silently overwritten.
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

/** Capture a baseline on first open; report whether the file has changed
 *  since the stored baseline afterwards. */
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

/** Rebuild the new content keeping only the accepted hunks (rejected hunks
 *  revert to their baseline lines). Hunks are applied back-to-front so
 *  earlier line numbers stay valid while later ones are replaced. */
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
    // Windows can refuse rename over an existing file; the content is already
    // fully validated by this point, so fall back to an in-place write.
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

/** Keep the current content as the new baseline (dismiss the review). */
export async function saveCurrentBaseline(filePath: string): Promise<{ hash: string }> {
  const current = await readReviewable(filePath)
  if (!current) throw new Error('File is too large for edit review')
  saveBaseline(filePath, current.hash, current.text)
  return { hash: current.hash }
}
