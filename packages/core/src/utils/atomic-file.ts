// @x-code-cli/core — 可靠的文件写入：同目录临时文件、fsync、原子重命名。
// 供内存存储以及任何绝不允许被读到半写入状态的状态文件使用。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r').catch(() => null)
  if (!handle) return
  await handle.sync().catch(() => {})
  await handle.close().catch(() => {})
}

export async function atomicWriteFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync().catch(() => {})
  } finally {
    await handle.close()
  }
  await fs.rename(temp, target)
  await syncDirectory(path.dirname(target))
}
