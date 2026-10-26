import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR } from './utils.js'

const GITIGNORE_ENTRY = '.x-code'
const GITIGNORE_COMMENT = '\n# X-Code CLI project-local state (sessions, history, plans, memory, and local settings)'

function alreadyIgnoresXcode(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const rule = line.trim()
    return rule === '.x-code' || rule === '.x-code/' || rule === '/.x-code' || rule === '/.x-code/'
  })
}

async function appendXcodeToGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore')
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (alreadyIgnoresXcode(content)) return

    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const prefix = content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r') ? newline : ''
    await fs.appendFile(gitignorePath, `${prefix}${GITIGNORE_COMMENT}${newline}${GITIGNORE_ENTRY}${newline}`, 'utf-8')
  } catch {
    // .gitignore 缺失或不可写是非致命的；绝不隐式创建它。
  }
}

/** 创建已有的项目存储路径，且仅当这次 mkdir 操作创建了顶层 .x-code 目录时
 *  才更新 .gitignore。 */
export async function ensureProjectStorageDir(directory: string): Promise<void> {
  try {
    // mode 0o700：会话/记忆可能包含粘贴进来的机密——仅所有者可访问
    // （在 Windows 上被忽略，因为 mkdir 没有权限模型）。
    const createdDir = await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (createdDir !== undefined && path.basename(createdDir) === XCODE_DIR) {
      await appendXcodeToGitignore(path.dirname(createdDir))
    }
  } catch {
    // 项目持久化是尽力而为的，绝不能阻止 CLI 运行。
  }
}
