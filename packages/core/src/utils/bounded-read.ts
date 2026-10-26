import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

const READ_CHUNK_BYTES = 64 * 1024

export class FileSizeLimitError extends Error {
  constructor(
    readonly filePath: string,
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`File ${filePath} exceeds the ${limitBytes}-byte read limit`)
    this.name = 'FileSizeLimitError'
  }
}

/** 从同一个已打开的文件身份读取，并在 limit + 1 字节后停止。句柄级 stat
 *  关闭了先前调用方 stat 留下的路径替换窗口，而有界循环同时还能捕获读取
 *  途中被追加的文件。 */
export async function readFileWithinLimit(
  filePath: string,
  limitBytes: number,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  abortSignal?.throwIfAborted()
  const handle = await fs.open(filePath, 'r')
  try {
    return await readFileHandleWithinLimit(handle, filePath, limitBytes, abortSignal)
  } finally {
    await handle.close()
  }
}

/** 从已打开的文件身份读取有界快照，且不关闭它。 */
export async function readFileHandleWithinLimit(
  handle: FileHandle,
  filePath: string,
  limitBytes: number,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  abortSignal?.throwIfAborted()
  const stats = await handle.stat()
  if (stats.size > limitBytes) throw new FileSizeLimitError(filePath, stats.size, limitBytes)

  const chunks: Buffer[] = []
  let totalBytes = 0
  while (totalBytes <= limitBytes) {
    abortSignal?.throwIfAborted()
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limitBytes + 1 - totalBytes))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes)
    if (bytesRead === 0) break
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
    totalBytes += bytesRead
  }

  if (totalBytes > limitBytes) throw new FileSizeLimitError(filePath, totalBytes, limitBytes)
  abortSignal?.throwIfAborted()
  return Buffer.concat(chunks, totalBytes)
}
