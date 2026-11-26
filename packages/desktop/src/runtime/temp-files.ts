import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { TempDeliverableMoveResult } from '../shared/protocol.js'

function comparableTempPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  // macOS 部分 API 会把 /tmp、/var 展开成 /private/...，比较前统一回用户路径。
  return process.platform === 'darwin' && resolved.startsWith('/private/')
    ? resolved.slice('/private'.length)
    : resolved
}

export function isTempSourcePath(filePath: string): boolean {
  const target = comparableTempPath(filePath)
  return [os.tmpdir(), '/tmp', '/var/tmp'].some((root) => {
    const normalized = comparableTempPath(root)
    return target === normalized || target.startsWith(normalized + path.sep)
  })
}

/** 在工作区内找一个不冲突的文件名并复制过去；绝不覆盖已有文件。 */
async function copyIntoWorkspace(source: string, workspace: string): Promise<string> {
  const name = path.basename(source) || 'deliverable'
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length) || name
  for (let index = 0; index < 1_000; index++) {
    const candidate = path.join(workspace, index === 0 ? name : `${stem} (${index})${extension}`)
    try {
      // `node:fs/promises` 没有 `constants` 成员（运行时是 undefined），
      // 用它会让每一次搬迁都抛 TypeError 并被吞成对用户毫无意义的报错。
      await fs.copyFile(source, candidate, fsConstants.COPYFILE_EXCL)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Could not find an unused filename in the workspace')
}

/** 把 Agent 落在系统临时目录里的交付物复制回工作区，再删除源文件。
 *  使用 COPYFILE_EXCL 保证绝不覆盖工作区已有文件；跨磁盘也能工作。 */
export async function moveTempFilesIntoWorkspace(
  paths: string[],
  workspace: string,
): Promise<TempDeliverableMoveResult> {
  const moved: TempDeliverableMoveResult['moved'] = []
  const errors: TempDeliverableMoveResult['errors'] = []
  for (const raw of paths.slice(0, 20)) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const source = path.resolve(raw)
    if (!isTempSourcePath(source)) {
      errors.push({ path: source, error: 'Not inside the system temporary directory' })
      continue
    }
    try {
      // lstat：源本身是软链就拒绝。否则 /tmp/x.txt -> ~/.ssh/id_rsa 这类链接
      // 会被当成“临时文件”复制进工作区，等于把临时目录限制绕成任意文件读取。
      const stats = await fs.lstat(source)
      if (!stats.isFile()) throw new Error('Not a regular file')
      // 解析真实路径后再校验一次，避免 stat/copy 之间的 TOCTOU。校验通过后
      // 必须用 `real` 作为复制源：继续用 `source` 会在 realpath 与 copyFile
      // 之间被换成指向 ~/.ssh/id_rsa 的软链，把「只允许读临时目录」绕成任意
      // 文件读取。`path.resolve()` 不解析软链，上面那次校验也不足以挡住它。
      const real = await fs.realpath(source)
      if (!isTempSourcePath(real)) throw new Error('Real path is outside the system temporary directory')
      await fs.mkdir(workspace, { recursive: true })
      const destination = await copyIntoWorkspace(real, workspace)
      await fs.chmod(destination, stats.mode & 0o777)
      await fs.unlink(source)
      moved.push({ from: source, to: destination })
    } catch (error) {
      errors.push({ path: source, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { moved, errors }
}
