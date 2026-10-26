// /rewind 功能的测试：内容寻址的快照存储 +
// session-jsonl 持久化 + hydrate 路径。
//
// 我们关心的（也是真正会破坏用户体验的）：
//
//   1. 往返：createCheckpoint → mutate → restore。用户事后看到的文件内容
//      就是变更前的内容。这是整个功能的要点——如果这条不成立，
//      rewind 就坏了。
//   2. 去重：两个 checkpoint 中相同的内容在磁盘上只占一个 blob。
//      没有这一点，100 个 checkpoint 的上限可能膨胀到数 GB。
//   3. checkpoint 之后的删除：agent 在 checkpoint 之后创建的文件必须在
//      rewind 时被 unlink。否则“回到我让你创建 X 之前”会把 X 留在磁盘上。
//   4. 缺席 / 跳过：标记为缺席的文件会被再次删除；标记为跳过（超大、
//      不可读）的文件则保持原样。skip 语义是安全阀——绝不静默删除
//      我们未能捕获的文件。
//   5. 持久化：appendCheckpoint → loadSession → hydrateLoopState 返回相同的
//      checkpoint 列表。没有这一点，/rewind 会在跨 /resume 时静默失效。
//   6. 压缩边界语义：边界之前的 checkpoint 在加载时消失（它们的
//      messageCount 锚点在压缩后无效）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { mkdir, open, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendCheckpoint,
  appendHeader,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  loadSession,
  markBoundaryAndReflush,
} from '../src/agent/session-store.js'
import {
  captureFileBeforeMutation,
  createCheckpoint,
  getDiffStatsForCheckpoint,
  restoreCheckpoint,
} from '../src/agent/snapshot.js'
import { XCODE_DIR } from '../src/utils.js'

// ── 准备 ───────────────────────────────────────────────────────────────

let tempDir: string
let originalCwd: string

beforeEach(() => {
  // chdir 到一个全新临时目录，让 session-store 的写入（使用 process.cwd()）
  // 和我们显式指定 cwd 的快照调用落在同一棵隔离目录树里。与
  // session-store.test.ts 中的模式一致。
  tempDir = mkdtempSync(path.join(tmpdir(), 'xc-snapshot-'))
  originalCwd = process.cwd()
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

// ── 辅助函数 ─────────────────────────────────────────────────────────────

async function writeWorkfile(rel: string, content: string): Promise<string> {
  const abs = path.join(tempDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
  return abs
}

function historySubdir(sid: string, sub: 'blobs' | 'checkpoints'): string {
  return path.join(tempDir, XCODE_DIR, 'file-history', sid, sub)
}

async function lsHistory(sid: string, sub: 'blobs' | 'checkpoints'): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    return (await readdir(historySubdir(sid, sub))).sort()
  } catch {
    return []
  }
}

// ── 快照核心 ───────────────────────────────────────────────────────

describe('snapshot: roundtrip', () => {
  it('restores file content captured at the checkpoint', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('src/a.ts', 'original')
    state.filesModified.add(file)

    const ckpt = await createCheckpoint(state, 'first prompt', tempDir)
    expect(ckpt).not.toBeNull()

    await writeFile(file, 'modified')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('uses state.projectCwd when the ambient process cwd differs', async () => {
    const projectDir = path.join(tempDir, 'project')
    const file = path.join(projectDir, 'src', 'a.ts')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'original', 'utf-8')
    const state = createLoopState('default', { projectCwd: projectDir })
    state.filesModified.add(file)

    const checkpoint = await createCheckpoint(state, 'project checkpoint')
    expect(checkpoint).not.toBeNull()
    expect(process.cwd()).not.toBe(projectDir)
    await expect(
      readFile(
        path.join(projectDir, XCODE_DIR, 'file-history', state.sessionId, 'checkpoints', `${checkpoint!.ckptId}.json`),
        'utf-8',
      ),
    ).resolves.toContain(checkpoint!.ckptId)

    await writeFile(file, 'modified', 'utf-8')
    await expect(getDiffStatsForCheckpoint(state, checkpoint!.ckptId)).resolves.toMatchObject({ filesChanged: [file] })
    await expect(restoreCheckpoint(state, checkpoint!.ckptId)).resolves.toBe(true)
    await expect(readFile(file, 'utf-8')).resolves.toBe('original')
  })

  it('returns false for an unknown checkpoint id', async () => {
    const state = createLoopState()
    expect(await restoreCheckpoint(state, 'does-not-exist', tempDir)).toBe(false)
  })

  it('records the entry on state.checkpoints with the correct messageCount', async () => {
    const state = createLoopState()
    // 模拟 agentLoop 的调用点：先 messages.push 再 createCheckpoint。
    state.messages.push({ role: 'user', content: 'hello' })
    const ckpt = await createCheckpoint(state, 'hello', tempDir)
    expect(ckpt).not.toBeNull()
    expect(ckpt!.messageCount).toBe(1)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })

  it('serializes concurrent checkpoints while keeping canonical ids unique', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.123Z'))
    try {
      const state = createLoopState()
      const file = await writeWorkfile('a.ts', 'content')
      state.filesModified.add(file)

      const checkpoints = await Promise.all([
        createCheckpoint(state, 'm1', tempDir),
        createCheckpoint(state, 'm2', tempDir),
        createCheckpoint(state, 'm3', tempDir),
      ])

      const ids = checkpoints.map((checkpoint) => checkpoint!.ckptId)
      expect(new Set(ids).size).toBe(3)
      expect(ids.every((id) => /^\d{8}-\d{6}-\d{3}$/.test(id))).toBe(true)
      expect(state.checkpoints.map((checkpoint) => checkpoint.ckptId)).toEqual(ids)
      expect(await lsHistory(state.sessionId, 'checkpoints')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses exclusive manifest creation across independent states', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T12:00:00.123Z'))
    try {
      const firstState = createLoopState()
      const secondState = createLoopState()
      secondState.sessionId = firstState.sessionId
      const file = await writeWorkfile('shared.ts', 'content')
      firstState.filesModified.add(file)
      secondState.filesModified.add(file)

      const [first, second] = await Promise.all([
        createCheckpoint(firstState, 'first', tempDir),
        createCheckpoint(secondState, 'second', tempDir),
      ])

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first!.ckptId).not.toBe(second!.ckptId)
      expect(await lsHistory(firstState.sessionId, 'checkpoints')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('snapshot: content-addressed dedup', () => {
  it('reuses a single blob across two checkpoints when content is unchanged', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'shared content')
    state.filesModified.add(file)

    await createCheckpoint(state, 'm1', tempDir)
    await createCheckpoint(state, 'm2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })

  it('writes a fresh blob when content changes', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'v2')
    await createCheckpoint(state, 'm2', tempDir)

    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)
  })

  it('does not read unchanged file contents again', async () => {
    const state = createLoopState()
    const first = await writeWorkfile('a.ts', 'first')
    const second = await writeWorkfile('b.ts', 'before')
    state.filesModified.add(first)
    state.filesModified.add(second)
    const readSpy = vi.spyOn(fs, 'readFile')

    await createCheckpoint(state, 'm1', tempDir)
    const readsAfterFirstCheckpoint = readSpy.mock.calls.length
    await createCheckpoint(state, 'm2', tempDir)

    expect(readSpy.mock.calls).toHaveLength(readsAfterFirstCheckpoint)

    await writeFile(second, 'after!', 'utf-8')
    const future = new Date(Date.now() + 2_000)
    await utimes(second, future, future)
    await createCheckpoint(state, 'm3', tempDir)

    expect(readSpy.mock.calls).toHaveLength(readsAfterFirstCheckpoint + 1)
    readSpy.mockRestore()
  })

  it('stops before writing a checkpoint when already aborted', async () => {
    const state = createLoopState()
    const controller = new AbortController()
    controller.abort()

    expect(await createCheckpoint(state, 'cancelled', tempDir, controller.signal)).toBeNull()
    expect(state.checkpoints).toHaveLength(0)
  })
})

describe('snapshot: after-checkpoint deletion', () => {
  it('unlinks a file that was created after the checkpoint', async () => {
    const state = createLoopState()
    // ckpt 1 在 filesModified 为空时建立 —— 代表“本会话中 agent 尚未
    // 做任何编辑”的世界。
    const ckpt1 = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt1).not.toBeNull()

    // 变更流水线先记录该路径在首次写入前确实缺席，
    // 再跟踪这次成功创建。
    const newfile = path.join(tempDir, 'newfile.ts')
    await captureFileBeforeMutation(state, newfile, tempDir)
    await writeWorkfile('newfile.ts', 'created later')
    state.filesModified.add(newfile)

    const ok = await restoreCheckpoint(state, ckpt1!.ckptId, tempDir)
    expect(ok).toBe(true)
    expect(existsSync(newfile)).toBe(false)
  })

  it('preserves an unknown legacy file instead of guessing that it was newly created', async () => {
    const state = createLoopState()
    const ckpt = await createCheckpoint(state, 'legacy', tempDir)
    const file = await writeWorkfile('legacy.ts', 'unknown provenance')
    state.filesModified.add(file)

    expect(await restoreCheckpoint(state, ckpt!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('unknown provenance')
  })
})

describe('snapshot: first-mutation origins', () => {
  it('restores a pre-existing file first touched after an empty checkpoint', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original')
    const ckpt = await createCheckpoint(state, 'edit existing', tempDir)

    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed')
    state.filesModified.add(file)

    expect(await restoreCheckpoint(state, ckpt!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('restores the origin when rewinding across multiple earlier checkpoints', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original')
    const first = await createCheckpoint(state, 'first', tempDir)
    await createCheckpoint(state, 'second', tempDir)

    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed')
    state.filesModified.add(file)

    expect(await restoreCheckpoint(state, first!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('persists origins for multiple files first touched in different turns', async () => {
    const state = createLoopState()
    const firstFile = await writeWorkfile('first.txt', 'original first')
    const secondFile = await writeWorkfile('second.txt', 'original second')
    const ckpt = await createCheckpoint(state, 'first', tempDir)

    await captureFileBeforeMutation(state, firstFile, tempDir)
    await writeFile(firstFile, 'changed first')
    state.filesModified.add(firstFile)
    await captureFileBeforeMutation(state, secondFile, tempDir)
    await writeFile(secondFile, 'changed second')
    state.filesModified.add(secondFile)

    expect(await restoreCheckpoint(state, ckpt!.ckptId, tempDir)).toBe(true)
    expect(await readFile(firstFile, 'utf-8')).toBe('original first')
    expect(await readFile(secondFile, 'utf-8')).toBe('original second')
  })

  it('captures a path only once so later edits cannot overwrite its origin', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original')
    const ckpt = await createCheckpoint(state, 'first', tempDir)

    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed once')
    state.filesModified.add(file)
    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed twice')

    expect(await restoreCheckpoint(state, ckpt!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('uses origin semantics in the rewind diff preview', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original\n')
    const ckpt = await createCheckpoint(state, 'edit existing', tempDir)

    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed\n')
    state.filesModified.add(file)

    const stats = await getDiffStatsForCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(stats?.filesChanged).toEqual([file])
    expect(stats?.insertions).toBeGreaterThan(0)
    expect(stats?.deletions).toBeGreaterThan(0)
  })

  it('keeps origin blobs alive during garbage collection', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original')
    const first = await createCheckpoint(state, 'first', tempDir)

    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed')
    state.filesModified.add(file)
    const second = await createCheckpoint(state, 'second', tempDir)
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)

    await restoreCheckpoint(state, second!.ckptId, tempDir)
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)
    await restoreCheckpoint(state, first!.ckptId, tempDir)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('loads the origin sidecar after session state is recreated', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('existing.ts', 'original')
    const ckpt = await createCheckpoint(state, 'first', tempDir)
    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed')

    const resumed = createLoopState()
    resumed.sessionId = state.sessionId
    resumed.checkpoints = state.checkpoints.slice()
    resumed.filesModified.add(file)

    expect(await restoreCheckpoint(resumed, ckpt!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('original')
  })

  it('recaptures a path on a new branch after rewinding before its first touch', async () => {
    const state = createLoopState()
    const file = path.join(tempDir, 'branch.txt')
    const originalCheckpoint = await createCheckpoint(state, 'create file', tempDir)
    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'created by abandoned branch')
    state.filesModified.add(file)

    await restoreCheckpoint(state, originalCheckpoint!.ckptId, tempDir)
    expect(existsSync(file)).toBe(false)

    await writeFile(file, 'created manually')
    const branchCheckpoint = await createCheckpoint(state, 'edit manual file', tempDir)
    await captureFileBeforeMutation(state, file, tempDir)
    await writeFile(file, 'changed by new branch')
    state.filesModified.add(file)

    expect(await restoreCheckpoint(state, branchCheckpoint!.ckptId, tempDir)).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('created manually')
  })
})

describe('snapshot: absent handling', () => {
  it('recreates "absent at snapshot" by deleting the file on restore', async () => {
    const state = createLoopState()
    // 跟踪一个在建立 checkpoint 时尚不存在的文件。
    const ghost = path.join(tempDir, 'ghost.ts')
    state.filesModified.add(ghost)

    const ckpt = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt).not.toBeNull()

    // 调用方之后才创建它。
    await writeWorkfile('ghost.ts', 'now exists')
    expect(existsSync(ghost)).toBe(true)

    await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    // manifest 说缺席 → restore 重新断言缺席 → 文件被 unlink。
    expect(existsSync(ghost)).toBe(false)
  })
})

describe('snapshot: oversize / skip', () => {
  it('does not blob oversized files, and leaves them alone on restore', async () => {
    const state = createLoopState()
    const big = path.join(tempDir, 'big.bin')
    // 稀疏文件略高于 10MB 上限。truncate() 在大多数文件系统上是瞬时的——
    // 我们不想仅仅为了测试边界就在内存里分配 10MB。
    const fh = await open(big, 'w')
    await fh.truncate(11 * 1024 * 1024)
    await fh.close()
    state.filesModified.add(big)

    const ckpt = await createCheckpoint(state, 'm1', tempDir)
    expect(ckpt).not.toBeNull()
    // 超大 → 不写 blob。
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(0)

    // 在 checkpoint 之后变更，再 restore。
    await writeFile(big, 'now small')
    const ok = await restoreCheckpoint(state, ckpt!.ckptId, tempDir)
    expect(ok).toBe(true)
    // skip 语义：我们没能捕获它，所以也不会撤销它。
    expect(await readFile(big, 'utf-8')).toBe('now small')
  })
})

describe('snapshot: post-restore bookkeeping', () => {
  it('drops checkpoints after the restored one from state.checkpoints', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'v2')
    await createCheckpoint(state, 'm2', tempDir)
    await writeFile(file, 'v3')
    await createCheckpoint(state, 'm3', tempDir)
    expect(state.checkpoints).toHaveLength(3)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.ckptId).toBe(c1!.ckptId)
    // 磁盘上的 manifest 也应已被裁剪。
    expect(await lsHistory(state.sessionId, 'checkpoints')).toHaveLength(1)
  })

  it('garbage-collects blobs no longer referenced by any remaining manifest', async () => {
    const state = createLoopState()
    const file = await writeWorkfile('a.ts', 'v1')
    state.filesModified.add(file)

    const c1 = await createCheckpoint(state, 'm1', tempDir)
    await writeFile(file, 'version-two')
    await createCheckpoint(state, 'm2', tempDir)
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(2)

    await restoreCheckpoint(state, c1!.ckptId, tempDir)
    // 第二个 blob 现在成了孤儿 → GC 把它 unlink；只剩 v1 的 blob。
    expect(await lsHistory(state.sessionId, 'blobs')).toHaveLength(1)
  })
})

// ── 会话存储集成 ──────────────────────────────────────────
//
// 这些覆盖 jsonl 持久化层，让 /rewind 能跨 /resume 存活。
// 它们不是“session-store 的单元测试”（那是 session-store.test.ts）——
// 而是 picker 所依赖的端到端契约 appendCheckpoint → loadSession
// → hydrateLoopState。

describe('rewind persistence: appendCheckpoint + loadSession roundtrip', () => {
  it('checkpoints written before any compact-boundary survive load', async () => {
    const state = createLoopState()
    state.taskSlug = 'fix-bug'
    state.messages.push({ role: 'user', content: 'one' })
    await appendHeader(state, 'anthropic:claude-x', 'one', tempDir)
    await flushPendingMessages(state)

    const ckpt = await createCheckpoint(state, 'one', tempDir)
    expect(ckpt).not.toBeNull()
    await appendCheckpoint(state, ckpt!)

    const loaded = await loadSession(getSessionFilePath(state, tempDir))
    expect(loaded).not.toBeNull()
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)

    // 而 hydrate 会把它们带到活的状态上。
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.checkpoints).toHaveLength(1)
    expect(hydrated.checkpoints[0]!.ckptId).toBe(ckpt!.ckptId)
  })

  it('checkpoints before a compact-boundary are dropped on load', async () => {
    // 为什么重要：边界之前 checkpoint 的 `messageCount` 锚点指向
    // 已被压缩掉的消息区间，因此“rewind 到这里”没有意义。加载器必须
    // 丢弃它们，与 markBoundaryAndReflush 所做的内存内清理一致。
    const state = createLoopState()
    state.taskSlug = 'compact-test'
    state.messages.push({ role: 'user', content: 'before' })
    await appendHeader(state, 'anthropic:claude-x', 'before', tempDir)
    await flushPendingMessages(state)

    const pre = await createCheckpoint(state, 'before', tempDir)
    await appendCheckpoint(state, pre!)

    // 模拟轻度压缩：收缩 messages，写入边界 + 重新 flush。
    // markBoundaryAndReflush 会在内存中清空 state.checkpoints，
    // 磁盘上的边界行让加载器同样丢弃 pre 条目。
    state.messages = []
    state.messages.push({ role: 'user', content: 'after' })
    await markBoundaryAndReflush(state)
    expect(state.checkpoints).toHaveLength(0)

    const post = await createCheckpoint(state, 'after', tempDir)
    await appendCheckpoint(state, post!)

    const loaded = await loadSession(getSessionFilePath(state, tempDir))
    expect(loaded).not.toBeNull()
    // 只有边界之后的 checkpoint 应该可见。
    expect(loaded!.checkpoints).toHaveLength(1)
    expect(loaded!.checkpoints[0]!.ckptId).toBe(post!.ckptId)
  })
})
