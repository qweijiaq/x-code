/**
 * 剪贴板图片以 Blob 形式到达，没有文件系统路径，因此渲染进程
 * 通过 IPC 发送，运行时在用户数据目录下写出真实文件。
 * 随后附件管线像处理普通拖入文件一样处理它。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { userXcodeDir } from '@x-code-cli/core'

const MAX_BYTES = 20 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FILES = 200

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function pastedImagesDir(): string {
  return path.join(userXcodeDir(), 'attachments')
}

/** 尽力做家务清理，避免重复的截图粘贴无限增长目录。
 *  失败会被忽略。 */
function prune(dir: string): void {
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('pasted-'))
      .map((entry) => {
        const filePath = path.join(dir, entry.name)
        try {
          return { filePath, mtime: fs.statSync(filePath).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { filePath: string; mtime: number } => entry !== null)
      .sort((left, right) => right.mtime - left.mtime)
    const now = Date.now()
    entries.forEach((entry, index) => {
      if (index < MAX_FILES && now - entry.mtime < MAX_AGE_MS) return
      try {
        fs.unlinkSync(entry.filePath)
      } catch {
        // 已被移除。
      }
    })
  } catch {
    // 目录可能尚不存在。
  }
}

export function savePastedImage(data: string, mime: string): { path: string } {
  const extension = EXTENSIONS[mime]
  if (!extension) throw new Error(`不支持的图片格式：${mime || '未知'}`)
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new Error('粘贴的图片内容为空')
  if (buffer.length > MAX_BYTES) throw new Error('粘贴的图片超过 20MB')
  const dir = pastedImagesDir()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(dir, `pasted-${stamp}-${randomUUID().slice(0, 8)}.${extension}`)
  fs.writeFileSync(filePath, buffer, { mode: 0o600 })
  prune(dir)
  return { path: filePath }
}
